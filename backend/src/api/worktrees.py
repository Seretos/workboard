"""The /worktrees endpoint — create and delete per-ticket worktrees.

POST /worktrees   → 201 + WorktreeRecord as dict
DELETE /worktrees/{worktree_id} → 200 + removed WorktreeRecord as dict

Both endpoints are guarded by a runtime availability check: when
lib-python-worktree is not installed they return 503 immediately.
"""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from src.providers import load_all_projects

log = logging.getLogger("workboard.worktrees")

try:
    from lib_python_worktree import (
        WorktreeManager,
        BranchAlreadyCheckedOutError,
        BranchNotFoundError,
        DirtyWorktreeError,
        DuplicateWorktreeError,
        InvalidRepoError,
        ProcessAlreadyRunningError,
        SetupFailedError,
        WorktreeDirLockedError,
        WorktreeError,
        WorktreeNotFoundError,
    )
    _WORKTREE_LIB_AVAILABLE = True
except ImportError:  # pragma: no cover — missing in test env until installed
    _WORKTREE_LIB_AVAILABLE = False

router = APIRouter()

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")

# Diagnosed 2026-07-11: a worktree's setup step (or the underlying git
# operation) can wedge indefinitely — lib-python-worktree's SetupRunner
# invokes subprocess.run() with no timeout of its own — and manager.create()/
# .remove() run via asyncio.to_thread() have never had one either. A wedged
# call previously ran forever: the only thing that ever gave up was the
# frontend's 10-minute AbortController (TicketCard.tsx), which just stops
# waiting — it does not cancel the backend request, so the stuck thread (and
# whatever subprocess it's blocked on) kept running, and the whole backend
# process was later observed to crash under the resulting resource pressure.
# Set a hair below the frontend's 600s so the backend's own clean timeout
# error wins the race and is what actually gets logged and returned.
#
# #113 follow-up (2026-07-12): a *separate* complaint — a slow POST
# /worktrees appearing to stall a concurrent GET /tickets poll — was traced
# to OS-level resource contention, not request serialization on workboard's
# side: both handlers already dispatch their blocking work via
# asyncio.to_thread (see test_worktrees.py's
# test_concurrent_create_does_not_block_tickets_poll for a hermetic proof
# that the two requests really do run concurrently). The actual root cause
# was setup subprocesses (npm install/git checkout) saturating disk/CPU and
# starving everything else on the machine, including the poll. The fix
# landed upstream in lib-python-worktree v0.1.11's SetupRunner, which spawns
# setup-step subprocesses at a lowered OS scheduling/IO priority by default
# (toggle: WORKTREE_SETUP_LOWER_PRIORITY) — pinned here via requirements.txt
# in #114. A dedicated ThreadPoolExecutor for worktree create/remove was
# considered and declined: it would only matter for Python-side
# executor/GIL contention, which isn't the bottleneck (subprocess.run()
# releases the GIL while the child runs; the default to_thread pool already
# has far more workers than cores).
_WORKTREE_OP_TIMEOUT_S = 570


def _branch_slug(title: str) -> str:
    """Lower-case, collapse non-alphanumeric runs to '-', strip edges, truncate."""
    s = _NON_ALNUM_RE.sub("-", title.lower()).strip("-")
    if not s:
        s = "x"
    return s[:60]


def _is_clean_worktree(path: str) -> bool:
    """True if `path` has nothing on disk, or has no uncommitted changes."""
    if not Path(path).exists():
        return True
    try:
        proc = subprocess.run(
            ["git", "-C", path, "status", "--porcelain"],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:  # noqa: BLE001 — best-effort; caller treats this as "not clean"
        return False
    return proc.returncode == 0 and not proc.stdout.strip()


# Diagnosed 2026-07-13: BranchAlreadyCheckedOutError fires when `git worktree
# add` refuses because git already has the branch checked out somewhere —
# most commonly a worktree left behind by a *previous* create() whose backend
# process crashed/was killed (see 8a63a86) after `git worktree add` succeeded
# but before the WorktreeRecord was persisted to state.yaml. Git remembers
# the checkout; our state store doesn't, so create() sees no conflict, retries
# the same `git worktree add`, and git rejects it — surfacing a raw
# "branch_already_checked_out" error the user had to resolve by hand.
#
# This reclaims that leftover checkout so the request can just succeed:
#   - prunable=True  → the on-disk directory is already gone; `git worktree
#     prune` clears git's stale bookkeeping, no data at risk.
#   - prunable=False → the directory is still there. Only reclaim it if it has
#     no uncommitted changes (adopt() into our state store, then remove() it
#     properly — ports/pids/branch handling included). A dirty leftover is
#     left alone and surfaces as the normal 409 for manual inspection.
def _reclaim_stale_worktree(manager: "WorktreeManager", local_path: str, exc: "BranchAlreadyCheckedOutError") -> bool:
    """Best-effort clean up of a worktree git knows about but our state store
    doesn't. Returns True if `create()` can safely be retried."""
    if exc.prunable:
        try:
            subprocess.run(
                ["git", "-C", local_path, "worktree", "prune"],
                capture_output=True, text=True, timeout=30, check=True,
            )
            return True
        except Exception:  # noqa: BLE001 — best-effort; fall through to the normal 409
            return False

    if not _is_clean_worktree(exc.path):
        return False

    try:
        manager.adopt(local_path)
        record = next((r for r in manager.list() if r.path == exc.path), None)
        if record is None:
            return False
        manager.remove(record.id, force=True, kill_blocking_processes=True)
        return True
    except Exception:  # noqa: BLE001 — best-effort; fall through to the normal 409
        return False


class CreateWorktreeRequest(BaseModel):
    project_id: str
    ticket_number: int
    ticket_title: str


@router.post("/worktrees", status_code=201)
async def create_worktree(req: CreateWorktreeRequest) -> dict:
    """Create a new worktree for a ticket."""
    if not _WORKTREE_LIB_AVAILABLE:
        raise HTTPException(status_code=503, detail="lib-python-worktree is not available")

    # Run off the event loop — see the matching comment in tickets.py's
    # /tickets handler. Otherwise a slow load_all_projects() call here
    # blocks every other in-flight request (including /tickets polls) for
    # its full duration.
    result = await asyncio.to_thread(load_all_projects)
    project = next((p for p in result.projects if p.id == req.project_id), None)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{req.project_id}' not found")

    local_path = getattr(project, "local_path", None)
    if local_path is None:
        raise HTTPException(status_code=422, detail="project has no local_path configured")

    branch = f"fix/{req.ticket_number}-{_branch_slug(req.ticket_title)}"

    log.info("creating worktree: project=%s branch=%s base=%s",
              req.project_id, branch, project.default_branch)
    started = time.monotonic()
    try:
        manager = WorktreeManager()
    except Exception as exc:
        log.warning("worktree manager init failed after %.1fs: %s", time.monotonic() - started, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    healed_once = False
    while True:
        try:
            record = await asyncio.wait_for(
                asyncio.to_thread(manager.create, local_path, branch, base=project.default_branch),
                timeout=_WORKTREE_OP_TIMEOUT_S,
            )
            break
        except HTTPException:
            raise
        except asyncio.TimeoutError as exc:
            log.warning(
                "worktree create timed out after %.1fs (limit %ds): project=%s branch=%s — "
                "backend thread keeps running in the background and cannot be cancelled; "
                "check the worktree's setup log under ~/.agent-worktree/logs/",
                time.monotonic() - started, _WORKTREE_OP_TIMEOUT_S, req.project_id, branch,
            )
            raise HTTPException(
                status_code=504,
                detail=(
                    f"Worktree creation for branch '{branch}' timed out after "
                    f"{_WORKTREE_OP_TIMEOUT_S}s. The underlying operation may still be "
                    f"running in the background — check the setup log under "
                    f"~/.agent-worktree/logs/ before retrying."
                ),
            ) from exc
        except BranchAlreadyCheckedOutError as exc:
            if not healed_once and await asyncio.to_thread(_reclaim_stale_worktree, manager, local_path, exc):
                healed_once = True
                log.warning(
                    "worktree create found branch '%s' already checked out at '%s' "
                    "outside our tracked state (likely left behind by a crashed prior "
                    "create) — reclaimed it and retrying",
                    exc.branch, exc.path,
                )
                continue
            log.warning("worktree create rejected after %.1fs: %s", time.monotonic() - started, exc)
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (DuplicateWorktreeError, DirtyWorktreeError) as exc:
            log.warning("worktree create rejected after %.1fs: %s", time.monotonic() - started, exc)
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (BranchNotFoundError, InvalidRepoError, WorktreeError) as exc:
            log.warning("worktree create failed after %.1fs: %s", time.monotonic() - started, exc)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except SetupFailedError as exc:
            log.warning("worktree setup step failed after %.1fs: %s", time.monotonic() - started, exc)
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Worktree '{exc.worktree_id}' was created but setup step "
                    f"'{exc.step_name}' (index {exc.step_index}) failed with "
                    f"returncode {exc.returncode}. "
                    f"See log: {exc.log_path}"
                ),
            ) from exc
        except Exception as exc:
            log.warning("worktree create failed unexpectedly after %.1fs: %s", time.monotonic() - started, exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    log.info("worktree created in %.1fs: id=%s path=%s", time.monotonic() - started, record.id, record.path)
    return asdict(record)


@router.delete("/worktrees/{worktree_id}")
async def delete_worktree(
    worktree_id: str,
    force: bool = Query(default=False),
) -> dict:
    """Remove a worktree by its ID."""
    if not _WORKTREE_LIB_AVAILABLE:
        raise HTTPException(status_code=503, detail="lib-python-worktree is not available")

    log.info("removing worktree: id=%s force=%s", worktree_id, force)
    started = time.monotonic()
    try:
        manager = WorktreeManager()
        record = await asyncio.wait_for(
            asyncio.to_thread(
                manager.remove,
                worktree_id,
                force=force,
                kill_blocking_processes=force,
            ),
            timeout=_WORKTREE_OP_TIMEOUT_S,
        )
    except HTTPException:
        raise
    except asyncio.TimeoutError as exc:
        log.warning(
            "worktree remove timed out after %.1fs (limit %ds): id=%s",
            time.monotonic() - started, _WORKTREE_OP_TIMEOUT_S, worktree_id,
        )
        raise HTTPException(
            status_code=504,
            detail=(
                f"Removing worktree '{worktree_id}' timed out after "
                f"{_WORKTREE_OP_TIMEOUT_S}s. The underlying operation may still be "
                f"running in the background — retry once it settles."
            ),
        ) from exc
    except WorktreeNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WorktreeDirLockedError, ProcessAlreadyRunningError, DirtyWorktreeError) as exc:
        log.warning("worktree remove rejected after %.1fs: %s", time.monotonic() - started, exc)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except WorktreeError as exc:
        log.warning("worktree remove failed after %.1fs: %s", time.monotonic() - started, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        log.warning("worktree remove failed unexpectedly after %.1fs: %s", time.monotonic() - started, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    log.info("worktree removed in %.1fs: id=%s", time.monotonic() - started, worktree_id)
    return asdict(record)
