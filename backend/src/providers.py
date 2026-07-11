"""Project loading + provider dispatch for the Workboard backend.

Mirrors the layering used by the `agent-project-issues` MCP plugin
(`tools/_providers.py`) so both consumers behave identically:

  - Domain models + the config-driven project list come from
    `lib_python_projects.load_projects`, which itself sits on
    `lib-python-config` for filesystem/​env/​YAML resolution.
  - Provider implementations (`GitHubProvider`, `GitLabProvider`,
    `AzureDevOpsProvider`) and their list/​get surface come from
    `lib_python_projects.providers.*`.

The config filename is pinned to `projects.yml` (matching the plugin)
so the backend reads the same `.seretos/projects.yml` the rest of the
toolchain uses, rather than the lib's legacy `project-issues.yml`
default.
"""
from __future__ import annotations

import threading
import time

from lib_python_projects import ProjectConfig, load_projects
from lib_python_projects.providers.azuredevops import AzureDevOpsProvider
from lib_python_projects.providers.github import GitHubProvider
from lib_python_projects.providers.gitlab import GitLabProvider

# Same config naming the plugin uses — see agent-project-issues
# `tools/_providers.py`. Keeping these identical means a single
# `.seretos/projects.yml` drives both the MCP plugin and this app.
_CONFIG_FILENAME = "projects.yml"
_CONFIG_FILENAME_ALT = "projects.yaml"

# load_all_projects() is filesystem work (config walk + git-remote
# discovery) and, since a recent /tickets and /worktrees fix, runs in a
# worker thread rather than blocking the event loop. It is still called
# very often in a short span — every 5-minute poll, every focus refresh,
# every worktree create/delete — for a project list that is effectively
# static within a session. A short TTL cache collapses those redundant
# reloads into one, which matters most exactly when it hurts most: a
# concurrent worktree `npm install` saturates disk I/O and can turn a
# normally-instant load into tens of seconds (see ticket describing the
# backend going unresponsive under load).
_PROJECTS_CACHE_TTL_S = 30.0
_projects_cache_lock = threading.Lock()
_projects_cache_result = None
_projects_cache_ts: float = 0.0


def _reset_projects_cache() -> None:
    """Clear the cached project list. Exposed for tests."""
    global _projects_cache_result, _projects_cache_ts
    with _projects_cache_lock:
        _projects_cache_result = None
        _projects_cache_ts = 0.0


_PROVIDERS = {
    "github": GitHubProvider(),
    "gitlab": GitLabProvider(),
    "azuredevops": AzureDevOpsProvider(),
}


def load_all_projects():
    """Load the configured project list using the shared `projects.yml`.

    Resolution uses the lib defaults, so the standard precedence applies:
    the `PROJECT_ISSUES_CONFIG` override env (highest priority) → walk git
    project boundaries outward from the process CWD → user-level
    `~/.seretos/projects.yml` fallback.

    The Electron main process sets `PROJECT_ISSUES_CONFIG` only in dev
    (see `resolveProjectsConfigPath` in `main.ts`), pinning the repo-local
    `.seretos/projects.yml`. In the packaged app it leaves the override
    unset, so resolution falls through to the user-level
    `~/.seretos/projects.yml` — the installed board reads each user's own
    project list rather than a bundled one.

    Thin indirection around `load_projects` so tests can monkey-patch
    `src.providers.load_projects` to substitute a deterministic project
    list without touching the disk.

    When a config file was found (`result.config_file` is set), auto-discovered
    projects whose `source` is `"git-remote"` or `"token-discovery"` are
    filtered out so that only explicitly configured projects reach the board.
    Without this filter, `lib_python_projects` appends the CWD git repo as an
    auto-discovered entry even when a config file is present, causing
    non-configured projects to appear on the board (tickets #68, #74).

    Cached for `_PROJECTS_CACHE_TTL_S` seconds (module-level, thread-safe)
    since this is called from multiple worker threads in short succession —
    without the lock, two callers racing past an expired cache would both
    pay the full (potentially slow) reload cost instead of one reload
    serving both.
    """
    global _projects_cache_result, _projects_cache_ts

    with _projects_cache_lock:
        now = time.monotonic()
        if _projects_cache_result is not None and (now - _projects_cache_ts) < _PROJECTS_CACHE_TTL_S:
            return _projects_cache_result

        import sys

        mod = sys.modules[__name__]
        result = mod.load_projects(
            config_filename=_CONFIG_FILENAME,
            config_filename_alt=_CONFIG_FILENAME_ALT,
        )

        # Only filter when a config file was resolved.  When no config file is
        # found the lib falls back to pure auto-discovery and every entry is
        # intentional — filtering would blank the board entirely.
        if result.config_file:
            _AUTO_SOURCES = {"git-remote", "token-discovery"}
            filtered = [
                p for p in result.projects
                if getattr(p, "source", None) not in _AUTO_SOURCES
            ]
            result = result.model_copy(update={"projects": filtered})

        _projects_cache_result = result
        _projects_cache_ts = now
        return result


def provider_for(project: ProjectConfig):
    """Return the provider implementation for `project`, or raise.

    Mirrors `agent-project-issues` `_provider_for`: an unconfigured
    provider name is a `NotImplementedError` the caller can skip on.
    """
    impl = _PROVIDERS.get(project.provider)
    if impl is None:
        raise NotImplementedError(
            f"provider '{project.provider}' is not implemented yet"
        )
    return impl
