"""Shared pytest fixtures for the backend test suite."""

import pytest


@pytest.fixture(autouse=True)
def _reset_projects_cache():
    """Clear `src.providers`' project-list TTL cache before every test.

    Most tests patch `load_all_projects` directly at the call site
    (`src.api.tickets.load_all_projects` / `src.api.worktrees.load_all_projects`),
    which bypasses the cache entirely. A few tests patch the lower-level
    `src.providers.load_projects` and rely on it being called fresh (e.g. to
    assert call args, or to simulate a raised exception) — without a reset,
    a cache entry left behind by an earlier test would serve a stale result
    instead of invoking the newly-patched mock.
    """
    from src.providers import _reset_projects_cache as reset

    reset()
    yield
    reset()
