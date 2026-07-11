"""Tests for the /worktrees endpoint.

Patches WorktreeManager at the module level (src.api.worktrees.WorktreeManager)
and load_all_projects so no filesystem or git access happens.
"""

from __future__ import annotations

import dataclasses
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_projects_result(projects):
    """Minimal ProjectsLoadResult-like object for mocking load_all_projects."""
    result = MagicMock()
    result.projects = projects
    return result


def _make_project(project_id: str = "workboard", local_path: str = "E:/development/workboard", default_branch: str = "main"):
    project = MagicMock()
    project.id = project_id
    project.local_path = local_path
    project.default_branch = default_branch
    return project


def _make_worktree_record(
    worktree_id: str = "workboard-fix-42-abcd1234",
    repo_root: str = "E:/development/workboard",
    branch: str = "fix/42-some-feature",
    path: str = "C:/wt/workboard-fix-42-abcd1234",
    status: str = "idle",
):
    """Return a real WorktreeRecord dataclass instance."""
    from lib_python_worktree import WorktreeRecord
    return WorktreeRecord(
        id=worktree_id,
        repo_root=repo_root,
        branch=branch,
        path=path,
        status=status,
        ports={},
        pids={},
        branch_created_by_us=True,
        killed_pids=[],
    )


# ---------------------------------------------------------------------------
# POST /worktrees
# ---------------------------------------------------------------------------

def test_create_worktree_ok() -> None:
    """POST /worktrees returns 201 with the record id and path."""
    project = _make_project()
    record = _make_worktree_record()

    mock_manager = MagicMock()
    mock_manager.create.return_value = record

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Some Feature",
        })

    assert response.status_code == 201
    data = response.json()
    assert data["id"] == "workboard-fix-42-abcd1234"
    assert data["path"] == "C:/wt/workboard-fix-42-abcd1234"
    assert data["branch"] == "fix/42-some-feature"
    # Verify the branch slug was passed correctly
    mock_manager.create.assert_called_once_with(
        "E:/development/workboard",
        "fix/42-some-feature",
        base="main",
    )


def test_create_worktree_branch_slug_formation() -> None:
    """Branch name is fix/<number>-<slug(title)>."""
    project = _make_project()
    record = _make_worktree_record(branch="fix/54-worktrees-erzeugen-und-loschen")

    mock_manager = MagicMock()
    mock_manager.create.return_value = record

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 54,
            "ticket_title": "Worktrees erzeugen und löschen",
        })

    assert response.status_code == 201
    # The slug lowercases and collapses non-alphanumeric (including umlauts) to '-'.
    # "Worktrees erzeugen und löschen" → "worktrees-erzeugen-und-l-schen"
    # (ö is non-ASCII-alnum so it and its adjacent space collapse to a single '-')
    call_branch = mock_manager.create.call_args[0][1]
    assert call_branch == "fix/54-worktrees-erzeugen-und-l-schen"


def test_create_worktree_project_not_found() -> None:
    """POST /worktrees returns 404 when project_id does not match any project."""
    with patch("src.api.worktrees.load_all_projects",
               return_value=_make_projects_result([])):
        response = client.post("/worktrees", json={
            "project_id": "nonexistent",
            "ticket_number": 1,
            "ticket_title": "Test",
        })

    assert response.status_code == 404
    assert "nonexistent" in response.json()["detail"]


def test_create_worktree_no_local_path() -> None:
    """POST /worktrees returns 422 when the project has no local_path."""
    project = _make_project(local_path=None)
    project.local_path = None

    with patch("src.api.worktrees.load_all_projects",
               return_value=_make_projects_result([project])):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 422
    assert "local_path" in response.json()["detail"]


def test_create_worktree_lib_unavailable() -> None:
    """POST /worktrees returns 503 when lib-python-worktree is not available."""
    import src.api.worktrees as wt_module
    original = wt_module._WORKTREE_LIB_AVAILABLE

    try:
        wt_module._WORKTREE_LIB_AVAILABLE = False
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })
    finally:
        wt_module._WORKTREE_LIB_AVAILABLE = original

    assert response.status_code == 503


def test_create_worktree_duplicate() -> None:
    """POST /worktrees returns 409 when DuplicateWorktreeError is raised."""
    from lib_python_worktree import DuplicateWorktreeError

    project = _make_project()
    mock_manager = MagicMock()
    mock_manager.create.side_effect = DuplicateWorktreeError("already exists")

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 409


def test_create_worktree_branch_already_checked_out() -> None:
    """POST /worktrees returns 409 when BranchAlreadyCheckedOutError is raised."""
    from lib_python_worktree import BranchAlreadyCheckedOutError

    project = _make_project()
    mock_manager = MagicMock()
    mock_manager.create.side_effect = BranchAlreadyCheckedOutError(
        branch="fix/42-test", path="/some/path", prunable=False
    )

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 409


def test_create_worktree_dirty() -> None:
    """POST /worktrees returns 409 when DirtyWorktreeError is raised."""
    from lib_python_worktree import DirtyWorktreeError

    project = _make_project()
    mock_manager = MagicMock()
    mock_manager.create.side_effect = DirtyWorktreeError("dirty")

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 409


def test_create_worktree_timeout_returns_504() -> None:
    """POST /worktrees returns 504 when manager.create() exceeds the timeout.

    Regression test: a wedged setup step (or git op) previously ran forever —
    the backend request itself never resolved, only the frontend's own
    10-minute AbortController eventually gave up client-side. manager.create
    runs a real time.sleep() in a real thread (via the unmocked asyncio.to_thread)
    so this exercises the actual asyncio.wait_for timeout path, not a mock.
    """
    import time as time_module

    project = _make_project()
    mock_manager = MagicMock()
    mock_manager.create.side_effect = lambda *a, **k: time_module.sleep(0.05)

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager), \
         patch("src.api.worktrees._WORKTREE_OP_TIMEOUT_S", 0.01):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 504
    assert "timed out" in response.json()["detail"]


# ---------------------------------------------------------------------------
# DELETE /worktrees/{worktree_id}
# ---------------------------------------------------------------------------

def test_delete_worktree_ok() -> None:
    """DELETE /worktrees/{id} returns 200 with the removed record."""
    record = _make_worktree_record(status="removed")

    mock_manager = MagicMock()
    mock_manager.remove.return_value = record

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.delete("/worktrees/workboard-fix-42-abcd1234")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "workboard-fix-42-abcd1234"
    assert data["status"] == "removed"
    mock_manager.remove.assert_called_once_with(
        "workboard-fix-42-abcd1234",
        force=False,
        kill_blocking_processes=False,
    )


def test_delete_worktree_not_found() -> None:
    """DELETE /worktrees/{id} returns 404 when WorktreeNotFoundError is raised."""
    from lib_python_worktree import WorktreeNotFoundError

    mock_manager = MagicMock()
    mock_manager.remove.side_effect = WorktreeNotFoundError("not found")

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.delete("/worktrees/nonexistent-id")

    assert response.status_code == 404


def test_delete_worktree_locked_no_force() -> None:
    """DELETE /worktrees/{id} returns 409 when WorktreeDirLockedError is raised."""
    from lib_python_worktree import WorktreeDirLockedError

    mock_manager = MagicMock()
    mock_manager.remove.side_effect = WorktreeDirLockedError("some-id", killed=[])

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.delete("/worktrees/some-id")

    assert response.status_code == 409


def test_delete_worktree_force_passes_kill_flag() -> None:
    """DELETE /worktrees/{id}?force=true passes kill_blocking_processes=True."""
    record = _make_worktree_record(status="removed")

    mock_manager = MagicMock()
    mock_manager.remove.return_value = record

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.delete("/worktrees/workboard-fix-42-abcd1234?force=true")

    assert response.status_code == 200
    mock_manager.remove.assert_called_once_with(
        "workboard-fix-42-abcd1234",
        force=True,
        kill_blocking_processes=True,
    )


def test_delete_worktree_timeout_returns_504() -> None:
    """DELETE /worktrees/{id} returns 504 when manager.remove() exceeds the timeout."""
    import time as time_module

    mock_manager = MagicMock()
    mock_manager.remove.side_effect = lambda *a, **k: time_module.sleep(0.05)

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager), \
         patch("src.api.worktrees._WORKTREE_OP_TIMEOUT_S", 0.01):
        response = client.delete("/worktrees/some-id")

    assert response.status_code == 504
    assert "timed out" in response.json()["detail"]


def test_delete_worktree_lib_unavailable() -> None:
    """DELETE /worktrees/{id} returns 503 when lib-python-worktree is not available."""
    import src.api.worktrees as wt_module
    original = wt_module._WORKTREE_LIB_AVAILABLE

    try:
        wt_module._WORKTREE_LIB_AVAILABLE = False
        response = client.delete("/worktrees/some-id")
    finally:
        wt_module._WORKTREE_LIB_AVAILABLE = original

    assert response.status_code == 503


def test_delete_worktree_unexpected_exception_returns_500() -> None:
    """DELETE /worktrees/{id} returns 500 when an unexpected exception is raised."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)

    mock_manager = MagicMock()
    mock_manager.remove.side_effect = RuntimeError("something totally unexpected")

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = no_raise_client.delete("/worktrees/some-id")

    assert response.status_code == 500
    assert "something totally unexpected" in response.json()["detail"]


# ---------------------------------------------------------------------------
# POST /worktrees — 500 path
# ---------------------------------------------------------------------------

def test_create_worktree_unexpected_exception_returns_500() -> None:
    """POST /worktrees returns 500 when an unexpected exception is raised by WorktreeManager."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)

    project = _make_project()
    mock_manager = MagicMock()
    mock_manager.create.side_effect = RuntimeError("disk full or something")

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = no_raise_client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 500
    assert "disk full or something" in response.json()["detail"]


def test_create_worktree_setup_failed_returns_422() -> None:
    """POST /worktrees returns 422 when SetupFailedError is raised by WorktreeManager.create."""
    from pathlib import Path
    from lib_python_worktree import SetupFailedError

    project = _make_project()
    mock_manager = MagicMock()
    mock_manager.create.side_effect = SetupFailedError(
        worktree_id="workboard-fix-42-abcd1234",
        step_index=0,
        step_name="npm install",
        log_path=Path("C:/wt/workboard-fix-42-abcd1234/setup-0.log"),
        returncode=1,
    )

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Test",
        })

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "workboard-fix-42-abcd1234" in detail
    assert "npm install" in detail
    assert "1" in detail


# ---------------------------------------------------------------------------
# _branch_slug unit tests
# ---------------------------------------------------------------------------

def test_branch_slug_lowercases_and_collapses() -> None:
    """_branch_slug converts to lowercase and collapses non-alphanumeric to '-'."""
    from src.api.worktrees import _branch_slug
    assert _branch_slug("Fix the Bug NOW") == "fix-the-bug-now"
    assert _branch_slug("Hello, World!") == "hello-world"
    assert _branch_slug("  leading spaces  ") == "leading-spaces"


def test_branch_slug_truncates_to_60() -> None:
    """_branch_slug truncates at 60 characters."""
    from src.api.worktrees import _branch_slug
    long_title = "a" * 100
    assert len(_branch_slug(long_title)) == 60


def test_branch_slug_empty_fallback() -> None:
    """_branch_slug returns 'x' for a title with no alphanumeric content."""
    from src.api.worktrees import _branch_slug
    assert _branch_slug("!!!") == "x"
    assert _branch_slug("") == "x"


def test_create_worktree_uses_asyncio_to_thread() -> None:
    """POST /worktrees calls asyncio.to_thread with manager.create and correct args.

    Regression test for #86: create_worktree called WorktreeManager().create() directly
    inside an async handler, blocking the uvicorn event loop.

    load_all_projects() is now *also* dispatched via asyncio.to_thread (see the
    backend-unresponsive fix: a slow filesystem walk there must not block the
    event loop either), so this handler now makes two to_thread calls. The
    side_effect below lets the load_all_projects call through to its (already
    mocked) return value and only special-cases the manager.create call.
    """
    project = _make_project()
    record = _make_worktree_record()

    mock_manager = MagicMock()
    mock_manager.create.return_value = record

    def to_thread_side_effect(fn, *args, **kwargs):
        if fn is mock_manager.create:
            return record
        return fn(*args, **kwargs)

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager), \
         patch("src.api.worktrees.asyncio.to_thread", new_callable=AsyncMock, side_effect=to_thread_side_effect) as mock_to_thread:
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Some Feature",
        })

    assert response.status_code == 201
    mock_to_thread.assert_any_call(
        mock_manager.create,
        "E:/development/workboard",
        "fix/42-some-feature",
        base="main",
    )


def test_delete_worktree_uses_asyncio_to_thread() -> None:
    """DELETE /worktrees/{id} calls asyncio.to_thread with manager.remove and correct args.

    Regression test for #86: delete_worktree called WorktreeManager().remove() directly
    inside an async handler, blocking the uvicorn event loop.
    """
    record = _make_worktree_record(status="removed")

    mock_manager = MagicMock()
    mock_manager.remove.return_value = record

    with patch("src.api.worktrees.WorktreeManager", return_value=mock_manager), \
         patch("src.api.worktrees.asyncio.to_thread", new_callable=AsyncMock, return_value=record) as mock_to_thread:
        response = client.delete("/worktrees/workboard-fix-42-abcd1234")

    assert response.status_code == 200
    mock_to_thread.assert_called_once_with(
        mock_manager.remove,
        "workboard-fix-42-abcd1234",
        force=False,
        kill_blocking_processes=False,
    )


def test_concurrent_create_does_not_block_tickets_poll() -> None:
    """A slow POST /worktrees does not delay a concurrent GET /tickets poll.

    Regression test for #113 ("worktree creation slows concurrent tickets
    polls to a crawl"). The reported symptom was that a slow worktree
    creation appeared to stall the ticket board's poll. Two hypotheses were
    considered for the root cause:

    1. workboard's own request dispatch serializes the two requests (e.g.
       blocking the event loop, or funneling both through a shared
       executor with too few workers) — this is what this test disproves.
    2. OS-level resource contention: the create's setup subprocesses (npm
       install / git checkout) saturate disk/CPU, so *everything* on the
       machine slows down, including an otherwise-independent poll. This
       was confirmed to be the actual cause and is fixed upstream in
       lib-python-worktree v0.1.11's SetupRunner (subprocess priority
       lowering), already pinned in requirements.txt (#114).

    A dedicated ThreadPoolExecutor for worktree create/remove was
    considered and declined: it would only be relevant if hypothesis (1)
    held via Python-side executor/GIL contention, but manager.create() runs
    via the plain asyncio.to_thread default pool (far more workers than
    CPU cores) and subprocess.run() releases the GIL while the child runs
    — so there is no Python-side contention to fix. A real npm/git timing
    benchmark was also considered and declined: it wouldn't be hermetic
    (flaky, environment-dependent), and there is no meaningful "before"
    state to compare against now that the upstream fix is pinned.

    This test proves hypothesis (1) is false directly and deterministically:
    it blocks WorktreeManager.create() on a threading.Event (simulating a
    long-running setup step) and asserts a concurrent GET /tickets still
    completes — via the real (unmocked) asyncio.to_thread dispatch path —
    while the create is still blocked. Only after that assertion does it
    release the event and confirm the create then completes normally.
    Synchronization is entirely event-based (no sleeps) so the test cannot
    be timing-flaky; every wait is bounded so a real deadlock fails fast
    instead of hanging the suite.
    """
    import asyncio
    import threading

    import httpx

    project = _make_project()
    record = _make_worktree_record()

    create_started = threading.Event()
    release_create = threading.Event()

    mock_manager = MagicMock()

    def blocking_create(*args, **kwargs):
        create_started.set()
        # Bounded wait: if release_create is never set (test bug or a real
        # deadlock reintroduced by a future change), fail loudly instead of
        # hanging the suite.
        if not release_create.wait(timeout=5):
            raise TimeoutError("release_create was never set (deadlock?)")
        return record

    mock_manager.create.side_effect = blocking_create

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as ac:
            create_task = asyncio.create_task(
                ac.post("/worktrees", json={
                    "project_id": "workboard",
                    "ticket_number": 42,
                    "ticket_title": "Some Feature",
                })
            )

            # Wait (off-loop) for manager.create() to actually be running in
            # its worker thread before racing the poll against it.
            started_in_time = await asyncio.to_thread(create_started.wait, 5)
            assert started_in_time, "manager.create() never started"

            # The create request is now blocked mid-flight. A concurrent
            # /tickets poll must still complete promptly — this is the
            # crux of the regression check.
            tickets_response = await asyncio.wait_for(ac.get("/tickets"), timeout=5)

            # ...and it must have completed while create_task is STILL
            # pending — proving the poll wasn't queued behind the create.
            assert not create_task.done(), (
                "GET /tickets only completed after POST /worktrees — "
                "the two requests are serialized"
            )

            # Now release the blocked create and confirm it completes cleanly.
            release_create.set()
            create_response = await asyncio.wait_for(create_task, timeout=5)

            return tickets_response, create_response

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager), \
         patch("src.api.tickets.load_all_projects", return_value=_make_projects_result([])):
        tickets_response, create_response = asyncio.run(scenario())

    assert tickets_response.status_code == 200
    assert tickets_response.json() == {"tickets": [], "poll_errors": None}

    assert create_response.status_code == 201
    assert create_response.json()["id"] == record.id


def test_create_worktree_uses_project_default_branch() -> None:
    """POST /worktrees passes project.default_branch (not a hardcoded 'main') to WorktreeManager.create.

    Regression test for #77: worktree creation hardcodes base branch 'main'
    instead of using the project's configured default branch.
    """
    project = _make_project(default_branch="master")
    record = _make_worktree_record()

    mock_manager = MagicMock()
    mock_manager.create.return_value = record

    with patch("src.api.worktrees.load_all_projects", return_value=_make_projects_result([project])), \
         patch("src.api.worktrees.WorktreeManager", return_value=mock_manager):
        response = client.post("/worktrees", json={
            "project_id": "workboard",
            "ticket_number": 42,
            "ticket_title": "Some Feature",
        })

    assert response.status_code == 201
    # The critical assertion: base branch must come from project.default_branch, not "main"
    mock_manager.create.assert_called_once_with(
        "E:/development/workboard",
        "fix/42-some-feature",
        base="master",
    )
