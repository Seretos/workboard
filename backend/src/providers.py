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

from lib_python_projects import ProjectConfig, load_projects
from lib_python_projects.providers.azuredevops import AzureDevOpsProvider
from lib_python_projects.providers.github import GitHubProvider
from lib_python_projects.providers.gitlab import GitLabProvider

# Same config naming the plugin uses — see agent-project-issues
# `tools/_providers.py`. Keeping these identical means a single
# `.seretos/projects.yml` drives both the MCP plugin and this app.
_CONFIG_FILENAME = "projects.yml"
_CONFIG_FILENAME_ALT = "projects.yaml"


_PROVIDERS = {
    "github": GitHubProvider(),
    "gitlab": GitLabProvider(),
    "azuredevops": AzureDevOpsProvider(),
}


def load_all_projects():
    """Load the configured project list using the shared `projects.yml`.

    Resolution is the lib default (no `cwd` override): walk git project
    boundaries outward from the process CWD, then fall back to the
    user-level `~/.seretos/projects.yml`. So launching the board from
    this repo uses the repo-local `.seretos/projects.yml` (dev/testing),
    while the real desktop app — started outside any git repo — falls
    through to the user-level config.

    Thin indirection around `load_projects` so tests can monkey-patch
    `src.providers.load_projects` to substitute a deterministic project
    list without touching the disk.
    """
    import sys

    mod = sys.modules[__name__]
    return mod.load_projects(
        config_filename=_CONFIG_FILENAME,
        config_filename_alt=_CONFIG_FILENAME_ALT,
    )


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
