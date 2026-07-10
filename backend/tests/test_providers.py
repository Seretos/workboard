"""Tests for `src.providers.load_all_projects`'s TTL cache.

`load_all_projects()` wraps the (filesystem-bound) `load_projects` lib call
and is invoked very often in a short span — every poll, every focus
refresh, every worktree create/delete. A short TTL cache collapses those
into one reload so a slow disk (e.g. saturated by a concurrent worktree
`npm install`) doesn't pay that cost redundantly. See ticket about the
backend going unresponsive under concurrent worktree load.

The `_reset_projects_cache` autouse fixture (conftest.py) clears the cache
before and after every test in this suite, so each test starts cold.
"""

from unittest.mock import MagicMock, patch

from lib_python_projects.models import ProjectConfig, ProjectsLoadResult

import src.providers as providers_module
from src.providers import load_all_projects


def _sample_project(project_id: str = "workboard") -> ProjectConfig:
    return ProjectConfig(
        id=project_id,
        description="Workboard project",
        provider="github",
        path="Seretos/workboard",
    )


def _make_raw_result(projects: list[ProjectConfig]) -> ProjectsLoadResult:
    return ProjectsLoadResult(state="ok", search_root="/tmp", projects=projects)


def test_load_all_projects_caches_within_ttl() -> None:
    """A second call within the TTL window must not re-invoke load_projects."""
    project = _sample_project()
    mock_load = MagicMock(return_value=_make_raw_result([project]))

    with patch("src.providers.load_projects", mock_load):
        first = load_all_projects()
        second = load_all_projects()

    mock_load.assert_called_once()
    assert first.projects == second.projects == [project]


def test_load_all_projects_reloads_after_cache_reset() -> None:
    """`_reset_projects_cache()` forces the next call to hit load_projects again."""
    project = _sample_project()
    mock_load = MagicMock(return_value=_make_raw_result([project]))

    with patch("src.providers.load_projects", mock_load):
        load_all_projects()
        providers_module._reset_projects_cache()
        load_all_projects()

    assert mock_load.call_count == 2


def test_load_all_projects_reloads_after_ttl_expires() -> None:
    """Once the TTL elapses, the next call reloads instead of serving stale data."""
    project = _sample_project()
    mock_load = MagicMock(return_value=_make_raw_result([project]))

    fake_now = [1000.0]

    with patch("src.providers.load_projects", mock_load), \
         patch("src.providers.time.monotonic", side_effect=lambda: fake_now[0]):
        load_all_projects()
        fake_now[0] += providers_module._PROJECTS_CACHE_TTL_S + 1
        load_all_projects()

    assert mock_load.call_count == 2


def test_load_all_projects_does_not_cache_exceptions() -> None:
    """A failed load must not poison the cache — the next call must retry."""
    project = _sample_project()
    mock_load = MagicMock(
        side_effect=[FileNotFoundError("projects.yml not found"), _make_raw_result([project])]
    )

    with patch("src.providers.load_projects", mock_load):
        try:
            load_all_projects()
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("expected FileNotFoundError to propagate")

        result = load_all_projects()

    assert mock_load.call_count == 2
    assert result.projects == [project]
