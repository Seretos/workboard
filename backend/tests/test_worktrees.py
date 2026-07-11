"""Tests for the /worktrees endpoint.

Patches WorktreeManager at the module level (src.api.worktrees.WorktreeManager)
and load_all_projects so no filesystem or git access happens.
"""

from __future__ import annotations

import dataclasses
from unittest.mock import MagicMock, patch

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
         patch("src.api.worktrees.asyncio.to_thread", side_effect=to_thread_side_effect) as mock_to_thread:
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
         patch("src.api.worktrees.asyncio.to_thread", return_value=record) as mock_to_thread:
        response = client.delete("/worktrees/workboard-fix-42-abcd1234")

    assert response.status_code == 200
    mock_to_thread.assert_called_once_with(
        mock_manager.remove,
        "workboard-fix-42-abcd1234",
        force=False,
        kill_blocking_processes=False,
    )


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
