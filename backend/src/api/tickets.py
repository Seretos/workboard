"""The /tickets endpoint.

Aggregates the *open tickets* across every configured project, the same
way the `agent-project-issues` plugin's `list_tickets` tool does: resolve
the project list (config-driven, via `lib_python_projects` +
`lib-python-config`), dispatch to each project's provider, and call
`list_tickets`. Each row is flattened with its originating project's
context so the board can render a provider badge + repo path per card.

Provider calls are blocking (sync `httpx`), so the per-project fetches
run concurrently in worker threads — otherwise N projects serialise into
N round-trips and the board waits seconds before the first paint.

Previously this endpoint returned the *projects* themselves (one
`load_projects()` call, dumped verbatim), which is why the board only
ever showed the auto-discovered repo and never any actual tickets.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import asdict

from fastapi import APIRouter

from lib_python_projects import ProjectConfig, resolve_token
from lib_python_projects.providers.base import (
    PRFilters,
    ProviderError,
    PullRequest,
    RateLimitError,
    TicketFilters,
)

from src.providers import load_all_projects, provider_for

log = logging.getLogger("workboard.tickets")

router = APIRouter()

# Match the plugin's `list_tickets` defaults: open tickets, page of 30.
_DEFAULT_LIMIT = 30

# Heuristic: closing keywords that link a PR body to a ticket number.
_CLOSING_KW_RE = re.compile(
    r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*#(\d+)',
    re.IGNORECASE,
)

# Heuristic: branch name patterns like "fix/42-description" or "42-description".
_BRANCH_NUM_RE = re.compile(r'^(?:\w+/)?(\d+)-')


def _build_pr_map(prs: list[PullRequest]) -> dict[int, PullRequest]:
    """Build a ticket-number → PR mapping using two heuristics.

    Body keyword scan takes priority; branch name convention is the
    fallback. First PR matched for a given ticket number wins.
    """
    pr_map: dict[int, PullRequest] = {}
    for pr in prs:
        # Heuristic 1: closing keywords in the PR body.
        body = pr.body or ""
        body_matched = False
        for m in _CLOSING_KW_RE.finditer(body):
            num = int(m.group(1))
            body_matched = True
            if num not in pr_map:
                pr_map[num] = pr

        # Heuristic 2: branch name convention (e.g. "fix/42-some-title").
        # Only fires when the body scan produced no ticket links for this PR,
        # so it is a genuine fallback and cannot link a PR to an unrelated
        # ticket that happens to share the branch-name number.
        if not body_matched:
            try:
                ref = pr.head.get("ref", "") if isinstance(pr.head, dict) else ""
            except Exception:
                ref = ""
            branch_m = _BRANCH_NUM_RE.match(ref)
            if branch_m:
                num = int(branch_m.group(1))
                if num not in pr_map:
                    pr_map[num] = pr

    return pr_map


def _fetch_project_tickets(project: ProjectConfig) -> list[dict]:
    """Fetch + flatten one project's open tickets. Never raises.

    A project whose provider call fails (auth, network, unsupported
    provider, renamed repo → 301/404) is logged and yields an empty list
    rather than failing the whole board — one misconfigured project
    shouldn't blank out the others.

    When the provider returns HTTP 403 or 429 (rate-limited), a sentinel
    dict is returned instead of an empty list so the caller can distinguish
    a genuine empty ticket list from a rate-limit failure.

    Each ticket row is enriched with an optional ``pull_request`` field:
    either ``{"number", "url", "status", "draft"}`` or ``null``. PR
    retrieval is best-effort: a failure degrades every ticket in the
    project to ``pull_request: null`` without suppressing the ticket list.
    """
    try:
        provider = provider_for(project)
    except NotImplementedError:
        log.warning("skipping project %s: unsupported provider %s",
                    project.id, project.provider)
        return []

    token = resolve_token(project)  # optional — public repos work without
    try:
        found, _has_more = provider.list_tickets(
            project,
            token,
            TicketFilters(status="open", limit=_DEFAULT_LIMIT),
        )
    except RateLimitError as exc:
        log.warning(
            "rate-limited on project %s: HTTP %s, retry_after=%s",
            project.id, exc.status, exc.retry_after,
        )
        return [{
            "__rate_limit_error__": True,
            "project_id": project.id,
            "retry_after": exc.retry_after,
        }]
    except ProviderError as exc:
        log.warning("skipping project %s: provider error: %s", project.id, exc)
        return [{"__fail_error__": True, "project_id": project.id}]
    except Exception as exc:  # noqa: BLE001 — resilience: skip, don't blank
        log.warning("skipping project %s: list_tickets failed: %s",
                    project.id, exc)
        return []

    # Fetch open PRs for this project; only bother when there are tickets to
    # enrich — an empty ticket list has nothing to link PRs to. Degrade
    # gracefully on failure.
    if found:
        try:
            prs, _ = provider.list_prs(
                project, token, PRFilters(status="open", limit=100)
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("skipping PR fetch for project %s: %s", project.id, exc)
            prs = []
    else:
        prs = []

    pr_map = _build_pr_map(prs)

    rows: list[dict] = []
    for ticket in found:
        row = asdict(ticket)
        # Enrich each ticket with its originating project context so a
        # card can show which repo/provider it belongs to.
        row["provider"] = project.provider
        row["project_id"] = project.id
        row["project_path"] = project.path

        # Attach matched PR info or null.
        ticket_num = int(ticket.id) if ticket.id.isdigit() else None
        matched_pr = pr_map.get(ticket_num) if ticket_num is not None else None
        if matched_pr is not None:
            row["pull_request"] = {
                "number": matched_pr.number,
                "url": matched_pr.url,
                "status": matched_pr.status,
                "draft": matched_pr.draft,
            }
        else:
            row["pull_request"] = None

        rows.append(row)
    return rows


@router.get("/tickets")
async def tickets() -> dict:
    """Return the open tickets across all configured projects.

    Per-project provider calls run concurrently in worker threads so the
    board's latency is the slowest single project, not the sum.

    Returns a JSON envelope:
    ``{"tickets": [...], "poll_errors": null | {"rate_limited": bool, ...}}``

    ``poll_errors`` is ``null`` when all projects succeeded (including a
    genuine empty ticket list).  When one or more projects were
    rate-limited, ``poll_errors.rate_limited`` is ``true`` and the
    ``tickets`` array contains only the rows from projects that did succeed.
    """
    result = load_all_projects()
    per_project = await asyncio.gather(
        *(asyncio.to_thread(_fetch_project_tickets, p) for p in result.projects)
    )

    ticket_rows: list[dict] = []
    rate_limited = False
    retry_after_max: int | None = None
    failed_projects: list[str] = []

    for rows in per_project:
        for row in rows:
            if row.get("__rate_limit_error__"):
                rate_limited = True
                failed_projects.append(row["project_id"])
                ra = row.get("retry_after")
                if ra is not None:
                    retry_after_max = max(retry_after_max or 0, ra)
            elif row.get("__fail_error__"):
                failed_projects.append(row["project_id"])
            else:
                ticket_rows.append(row)

    # `failed_projects` is always populated alongside `rate_limited` today,
    # so the `or failed_projects` guard is kept for defensive forward-compat
    # should a future error class populate failed_projects without setting
    # rate_limited.
    poll_errors = (
        {
            "rate_limited": rate_limited,
            "retry_after": retry_after_max,
            "failed_projects": failed_projects,
        }
        if (rate_limited or failed_projects)
        else None
    )
    return {"tickets": ticket_rows, "poll_errors": poll_errors}
