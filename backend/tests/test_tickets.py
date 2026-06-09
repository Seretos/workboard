"""Tests for the /tickets endpoint.

The endpoint aggregates open tickets across every configured project by
dispatching to each project's provider (mirroring the
`agent-project-issues` plugin). Tests patch `load_all_projects` and
`provider_for` in the endpoint's namespace so no network or config disk
access happens.
"""

import httpx
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from src.main import app
from lib_python_projects.models import ProjectConfig, ProjectsLoadResult
from lib_python_projects.providers.base import PullRequest, Ticket


client = TestClient(app)


def _make_result(projects: list[ProjectConfig]) -> ProjectsLoadResult:
    """Build a minimal ProjectsLoadResult for mocking."""
    return ProjectsLoadResult(
        state="ok",
        search_root="/tmp",
        projects=projects,
    )


def _sample_project(
    project_id: str = "workboard",
    path: str = "Seretos/workboard",
) -> ProjectConfig:
    return ProjectConfig(
        id=project_id,
        description="Workboard project",
        provider="github",
        path=path,
    )


def _sample_ticket(ticket_id: str = "42", title: str = "Fix the thing") -> Ticket:
    return Ticket(
        id=ticket_id,
        title=title,
        body="body text",
        status="open",
        author="octocat",
        assignees=["octocat"],
        labels=["bug"],
        url=f"https://github.com/Seretos/workboard/issues/{ticket_id}",
        created_at="2026-06-01T00:00:00Z",
        updated_at="2026-06-02T00:00:00Z",
    )


def _sample_pr(
    number: int = 1,
    body: str = "",
    ref: str = "main",
    ticket_number: int | None = None,
    status: str = "open",
    draft: bool = False,
) -> PullRequest:
    """Build a minimal PullRequest for use in tests.

    ``ticket_number`` is a convenience shorthand: when set the body is
    automatically set to ``"Fixes #<n>"`` (overrides explicit ``body``).
    """
    if ticket_number is not None:
        body = f"Fixes #{ticket_number}"
    return PullRequest(
        id=str(number),
        number=number,
        title=f"PR {number}",
        body=body,
        status=status,  # type: ignore[arg-type]
        draft=draft,
        author="octocat",
        assignees=[],
        reviewers=[],
        requested_reviewers=[],
        labels=[],
        head={"ref": ref, "sha": "abc123", "repo_full_name": "org/repo"},
        base={"ref": "main", "sha": "def456"},
        merged=False,
        mergeable=None,
        url=f"https://github.com/org/repo/pull/{number}",
        created_at="2026-06-01T00:00:00Z",
        updated_at="2026-06-02T00:00:00Z",
    )


def _fake_provider(
    tickets: list[Ticket],
    prs: list[PullRequest] | None = None,
) -> MagicMock:
    """Return a mock provider with stubbed list_tickets and list_prs."""
    provider = MagicMock()
    provider.list_tickets.return_value = (tickets, False)
    provider.list_prs.return_value = (prs if prs is not None else [], False)
    return provider


def _make_http_error(
    status_code: int,
    headers: dict | None = None,
) -> httpx.HTTPStatusError:
    """Build a minimal httpx.HTTPStatusError for simulating rate-limit responses."""
    response = httpx.Response(status_code, headers=headers or {})
    return httpx.HTTPStatusError(
        "rate limited",
        request=httpx.Request("GET", "https://api.github.com"),
        response=response,
    )


def test_tickets_ok() -> None:
    """GET /tickets returns HTTP 200."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket()])):
        response = client.get("/tickets")
    assert response.status_code == 200


def test_tickets_json_array() -> None:
    """GET /tickets body is a JSON object with a 'tickets' array."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket()])):
        response = client.get("/tickets")
    assert isinstance(response.json()["tickets"], list)


def test_tickets_content_type() -> None:
    """GET /tickets Content-Type contains application/json."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket()])):
        response = client.get("/tickets")
    assert "application/json" in response.headers["content-type"]


def test_tickets_item_fields() -> None:
    """Each row carries the provider ticket fields plus project context."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket("7", "Wire the icon")])):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    item = items[0]
    # Provider ticket fields.
    assert item["id"] == "7"
    assert item["title"] == "Wire the icon"
    assert item["status"] == "open"
    # Project context enrichment.
    assert item["provider"] == "github"
    assert item["project_id"] == "workboard"
    assert item["project_path"] == "Seretos/workboard"


def test_tickets_aggregates_across_projects() -> None:
    """Tickets from every configured project are flattened into one list."""
    projects = [
        _sample_project("a", "org/a"),
        _sample_project("b", "org/b"),
    ]

    def fake_provider_for(project):
        return _fake_provider([_sample_ticket(f"{project.id}-1")])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.provider_for", side_effect=fake_provider_for):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 2
    assert {i["project_id"] for i in items} == {"a", "b"}


def test_tickets_skips_failing_project() -> None:
    """A project whose provider raises is skipped, not fatal to the board."""
    projects = [
        _sample_project("good", "org/good"),
        _sample_project("bad", "org/bad"),
    ]

    def fake_provider_for(project):
        if project.id == "bad":
            broken = MagicMock()
            broken.list_tickets.side_effect = RuntimeError("boom")
            broken.list_prs.return_value = ([], False)
            return broken
        return _fake_provider([_sample_ticket("good-1")])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.provider_for", side_effect=fake_provider_for):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert response.status_code == 200
    assert len(items) == 1
    assert items[0]["project_id"] == "good"


def test_tickets_empty_list() -> None:
    """GET /tickets with no projects returns 200 with empty tickets array and null poll_errors."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([])):
        response = client.get("/tickets")
    assert response.status_code == 200
    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"] is None


def test_tickets_lib_error_returns_500() -> None:
    """GET /tickets when project loading raises RuntimeError returns HTTP 500."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)
    with patch("src.api.tickets.load_all_projects",
               side_effect=RuntimeError("config broken")):
        response = no_raise_client.get("/tickets")
    assert response.status_code == 500


def test_tickets_loads_config_with_correct_filename() -> None:
    """The backend resolves projects from `projects.yml` (not the lib default).

    The `load_projects` call now lives in `src.providers.load_all_projects`,
    so the filename contract is asserted there. `provider_for` is patched
    so the sample project's tickets resolve without a network call.
    """
    mock_load = MagicMock(return_value=_make_result([_sample_project()]))
    with patch("src.providers.load_projects", mock_load), \
         patch("src.api.tickets.provider_for", return_value=_fake_provider([])):
        client.get("/tickets")
    mock_load.assert_called_once_with(
        config_filename="projects.yml",
        config_filename_alt="projects.yaml",
    )


def test_tickets_file_not_found_returns_500() -> None:
    """GET /tickets when project loading raises FileNotFoundError returns HTTP 500."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)
    with patch(
        "src.providers.load_projects",
        side_effect=FileNotFoundError("projects.yml not found"),
    ):
        response = no_raise_client.get("/tickets")
    assert response.status_code == 500


# ---------------------------------------------------------------------------
# New tests for the pull_request enrichment feature (ticket #15).
# ---------------------------------------------------------------------------


def test_tickets_pr_linked_via_body_keyword() -> None:
    """A PR with 'Fixes #42' in its body is linked to ticket id='42'."""
    pr = _sample_pr(number=7, ticket_number=42)
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket("42")], prs=[pr])):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    pr_field = items[0]["pull_request"]
    assert pr_field is not None
    assert pr_field["number"] == 7
    assert pr_field["url"] == "https://github.com/org/repo/pull/7"
    assert pr_field["status"] == "open"
    assert pr_field["draft"] is False


def test_tickets_pr_null_when_no_match() -> None:
    """A PR referencing ticket #99 leaves ticket #42 with pull_request=null."""
    pr = _sample_pr(number=3, ticket_number=99)
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket("42")], prs=[pr])):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["pull_request"] is None


def test_tickets_pr_null_when_no_prs() -> None:
    """No PRs at all → pull_request is null on every ticket."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket("42")], prs=[])):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["pull_request"] is None


def test_tickets_pr_linked_via_branch_name() -> None:
    """A PR with head ref 'fix/42-some-description' is linked to ticket id='42'."""
    pr = _sample_pr(number=5, body="", ref="fix/42-some-description")
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket("42")], prs=[pr])):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    pr_field = items[0]["pull_request"]
    assert pr_field is not None
    assert pr_field["number"] == 5


def test_tickets_pr_linked_via_branch_name_plain_prefix() -> None:
    """A PR with head ref '42-description' (no subdirectory) is also matched."""
    pr = _sample_pr(number=6, body="", ref="42-description")
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket("42")], prs=[pr])):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    pr_field = items[0]["pull_request"]
    assert pr_field is not None
    assert pr_field["number"] == 6


def test_tickets_pr_branch_heuristic_skipped_when_body_matched() -> None:
    """Regression: branch-name heuristic must not fire when body already matched.

    PR #7 body says "Fixes #42" (links to ticket A) and branch is
    "43-old-description" (encodes ticket B=43).  Ticket 43 must NOT get
    PR #7 attached — the branch heuristic is a fallback and must be
    suppressed once the body scan produced any match for that PR.
    """
    pr = _sample_pr(number=7, body="Fixes #42", ref="43-old-description")
    ticket_a = _sample_ticket("42", "Ticket A")
    ticket_b = _sample_ticket("43", "Ticket B")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([ticket_a, ticket_b], prs=[pr])):
        response = client.get("/tickets")

    assert response.status_code == 200
    items = response.json()["tickets"]
    by_id = {i["id"]: i for i in items}

    # Ticket A is correctly linked via body keyword.
    assert by_id["42"]["pull_request"] is not None
    assert by_id["42"]["pull_request"]["number"] == 7

    # Ticket B must NOT be linked — the branch number is a red herring.
    assert by_id["43"]["pull_request"] is None, (
        "Branch heuristic fired despite body already matching; "
        "ticket 43 should have pull_request=null"
    )


def test_tickets_pr_fetch_failure_does_not_suppress_ticket() -> None:
    """If list_prs raises, tickets are still returned with pull_request=null."""
    broken_provider = MagicMock()
    broken_provider.list_tickets.return_value = ([_sample_ticket("42")], False)
    broken_provider.list_prs.side_effect = RuntimeError("network error")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for", return_value=broken_provider):
        response = client.get("/tickets")
    assert response.status_code == 200
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["pull_request"] is None


def test_tickets_pr_field_always_present() -> None:
    """Every row always contains the 'pull_request' key (object or null).

    Exercises two projects — one with a matched PR, one without — to
    confirm the key is present regardless of match state and across
    aggregated projects.
    """
    projects = [
        _sample_project("proj-a", "org/a"),
        _sample_project("proj-b", "org/b"),
    ]

    def fake_provider_for(project):
        if project.id == "proj-a":
            # proj-a has a PR linking to ticket 1.
            pr = _sample_pr(number=10, ticket_number=1)
            return _fake_provider([_sample_ticket("1")], prs=[pr])
        # proj-b has no PRs.
        return _fake_provider([_sample_ticket("2")], prs=[])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.provider_for", side_effect=fake_provider_for):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 2
    for item in items:
        assert "pull_request" in item, f"pull_request key missing in {item}"

    # proj-a ticket should have PR linked, proj-b should be null.
    by_project = {i["project_id"]: i for i in items}
    assert by_project["proj-a"]["pull_request"] is not None
    assert by_project["proj-a"]["pull_request"]["number"] == 10
    assert by_project["proj-b"]["pull_request"] is None


def test_tickets_pr_body_keyword_variants() -> None:
    """All closing keyword variants in PR body are recognised.

    Tests: closes, closed, fix, fixes, fixed, resolve, resolves, resolved.
    """
    keywords = [
        "Closes #42",
        "closed #42",
        "fix #42",
        "Fixes #42",
        "fixed #42",
        "resolve #42",
        "Resolves #42",
        "resolved #42",
    ]
    for kw in keywords:
        pr = _sample_pr(number=1, body=kw)
        with patch("src.api.tickets.load_all_projects",
                   return_value=_make_result([_sample_project()])), \
             patch("src.api.tickets.provider_for",
                   return_value=_fake_provider([_sample_ticket("42")], prs=[pr])):
            response = client.get("/tickets")
        items = response.json()["tickets"]
        assert items[0]["pull_request"] is not None, \
            f"Expected PR match for keyword '{kw}' but got null"


# ---------------------------------------------------------------------------
# New tests for rate-limit resilience (ticket #25).
# ---------------------------------------------------------------------------


def test_tickets_rate_limit_403_sets_flag() -> None:
    """When list_tickets raises HTTP 403, poll_errors.rate_limited is True."""
    broken_provider = MagicMock()
    broken_provider.list_tickets.side_effect = _make_http_error(
        403, headers={"Retry-After": "120"}
    )
    broken_provider.list_prs.return_value = ([], False)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for", return_value=broken_provider):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"] is not None
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] == 120


def test_tickets_rate_limit_429_sets_flag() -> None:
    """When list_tickets raises HTTP 429, poll_errors.rate_limited is True."""
    broken_provider = MagicMock()
    broken_provider.list_tickets.side_effect = _make_http_error(
        429, headers={"Retry-After": "120"}
    )
    broken_provider.list_prs.return_value = ([], False)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for", return_value=broken_provider):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] == 120


def test_tickets_rate_limit_retry_after_absent() -> None:
    """HTTP 403 with no Retry-After header → poll_errors.retry_after is None."""
    broken_provider = MagicMock()
    broken_provider.list_tickets.side_effect = _make_http_error(403)
    broken_provider.list_prs.return_value = ([], False)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for", return_value=broken_provider):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] is None


def test_tickets_rate_limit_excludes_sentinel_from_ticket_list() -> None:
    """One rate-limited project + one good project → only good project's ticket."""
    projects = [
        _sample_project("rate-limited-proj", "org/limited"),
        _sample_project("good-proj", "org/good"),
    ]

    def fake_provider_for(project):
        if project.id == "rate-limited-proj":
            broken = MagicMock()
            broken.list_tickets.side_effect = _make_http_error(403)
            broken.list_prs.return_value = ([], False)
            return broken
        return _fake_provider([_sample_ticket("99", "Good ticket")])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.provider_for", side_effect=fake_provider_for):
        response = client.get("/tickets")

    data = response.json()
    assert len(data["tickets"]) == 1
    assert data["tickets"][0]["project_id"] == "good-proj"
    assert data["poll_errors"]["rate_limited"] is True


def test_tickets_rate_limit_retry_after_max_across_projects() -> None:
    """Two rate-limited projects → retry_after is the maximum of both."""
    projects = [
        _sample_project("proj-a", "org/a"),
        _sample_project("proj-b", "org/b"),
    ]

    def fake_provider_for(project):
        if project.id == "proj-a":
            broken = MagicMock()
            broken.list_tickets.side_effect = _make_http_error(
                429, headers={"Retry-After": "60"}
            )
            broken.list_prs.return_value = ([], False)
            return broken
        broken = MagicMock()
        broken.list_tickets.side_effect = _make_http_error(
            429, headers={"Retry-After": "300"}
        )
        broken.list_prs.return_value = ([], False)
        return broken

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.provider_for", side_effect=fake_provider_for):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"]["retry_after"] == 300


def test_tickets_no_errors_poll_errors_null() -> None:
    """When all projects succeed, poll_errors is null."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket()])):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"] is None


def test_tickets_generic_failure_does_not_set_rate_limited() -> None:
    """A generic (non-HTTP) exception does not set poll_errors.rate_limited."""
    broken_provider = MagicMock()
    broken_provider.list_tickets.side_effect = RuntimeError("generic failure")
    broken_provider.list_prs.return_value = ([], False)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for", return_value=broken_provider):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"] is None


def test_tickets_rate_limit_retry_after_non_numeric() -> None:
    """HTTP-date Retry-After (RFC 7231) must not crash the endpoint.

    ``int()`` on a date string such as "Thu, 01 Jan 2026 00:00:00 GMT" raises
    ``ValueError``. The endpoint must return 200 with ``rate_limited: True``
    and ``retry_after: None`` rather than a 500.
    """
    broken_provider = MagicMock()
    broken_provider.list_tickets.side_effect = _make_http_error(
        403, headers={"Retry-After": "Thu, 01 Jan 2026 00:00:00 GMT"}
    )
    broken_provider.list_prs.return_value = ([], False)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for", return_value=broken_provider):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] is None
