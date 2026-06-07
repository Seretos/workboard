"""The /tickets endpoint.

Aggregates the *open tickets* across every configured project, the same
way the `agent-project-issues` plugin's `list_tickets` tool does: resolve
the project list (config-driven, via `lib_python_projects` +
`lib-python-config`), dispatch to each project's provider, and call
`list_tickets`. Each row is flattened with its originating project's
context so the board can render a provider badge + repo path per card.

Previously this endpoint returned the *projects* themselves (one
`load_projects()` call, dumped verbatim), which is why the board only
ever showed the auto-discovered repo and never any actual tickets.
"""
from __future__ import annotations

import logging
from dataclasses import asdict

from fastapi import APIRouter

from lib_python_projects import resolve_token
from lib_python_projects.providers.base import TicketFilters

from src.providers import load_all_projects, provider_for

log = logging.getLogger("workboard.tickets")

router = APIRouter()

# Match the plugin's `list_tickets` defaults: open tickets, page of 30.
_DEFAULT_LIMIT = 30


@router.get("/tickets")
async def tickets() -> list:
    """Return the open tickets across all configured projects.

    A project whose provider call fails (auth, network, unsupported
    provider) is logged and skipped rather than failing the whole board —
    one misconfigured project shouldn't blank out the others.
    """
    result = load_all_projects()
    rows: list[dict] = []

    for project in result.projects:
        try:
            provider = provider_for(project)
        except NotImplementedError:
            log.warning("skipping project %s: unsupported provider %s",
                        project.id, project.provider)
            continue

        token = resolve_token(project)  # optional — public repos work without
        try:
            found, _has_more = provider.list_tickets(
                project,
                token,
                TicketFilters(status="open", limit=_DEFAULT_LIMIT),
            )
        except Exception as exc:  # noqa: BLE001 — resilience: skip, don't blank
            log.warning("skipping project %s: list_tickets failed: %s",
                        project.id, exc)
            continue

        for ticket in found:
            row = asdict(ticket)
            # Enrich each ticket with its originating project context so a
            # card can show which repo/provider it belongs to.
            row["provider"] = project.provider
            row["project_id"] = project.id
            row["project_path"] = project.path
            rows.append(row)

    return rows
