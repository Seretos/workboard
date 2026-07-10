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
import time
from dataclasses import asdict

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


def _branch_slug(title: str) -> str:
    """Lower-case, collapse non-alphanumeric runs to '-', strip edges, truncate."""
    s = _NON_ALNUM_RE.sub("-", title.lower()).strip("-")
    if not s:
        s = "x"
    return s[:60]


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
        record = await asyncio.to_thread(manager.create, local_path, branch, base=project.default_branch)
    except HTTPException:
        raise
    except (DuplicateWorktreeError, BranchAlreadyCheckedOutError, DirtyWorktreeError) as exc:
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
        record = await asyncio.to_thread(
            manager.remove,
            worktree_id,
            force=force,
            kill_blocking_processes=force,
        )
    except HTTPException:
        raise
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
