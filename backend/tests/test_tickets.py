"""Tests for the /tickets endpoint.

The endpoint aggregates open tickets across every configured project by
dispatching to each project's provider (mirroring the
`agent-project-issues` plugin). Tests patch `load_all_projects` and
`fetch_open_board` (for GitHub projects) or `provider_for` (for non-GitHub
projects) in the endpoint's namespace so no network or config disk access
happens.
"""

from unittest.mock import MagicMock, call, patch

from fastapi.testclient import TestClient

from src.main import app
from lib_python_projects.models import ProjectConfig, ProjectsLoadResult
from lib_python_projects.providers.base import ProviderError, PullRequest, RateLimitError, Ticket


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
    provider: str = "github",
) -> ProjectConfig:
    return ProjectConfig(
        id=project_id,
        description="Workboard project",
        provider=provider,
        path=path,
    )


def _sample_gitlab_project(
    project_id: str = "gl-proj",
    path: str = "org/gl-proj",
) -> ProjectConfig:
    return _sample_project(project_id=project_id, path=path, provider="gitlab")


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


def _make_rate_limit_error(retry_after: int | None) -> RateLimitError:
    """Build a RateLimitError with the given retry_after value."""
    return RateLimitError(429, "rate limited", retry_after=retry_after)


def _make_provider_error(status: int) -> ProviderError:
    """Build a generic ProviderError with the given HTTP status code."""
    return ProviderError(status, f"provider error {status}")


def _make_batch_result(project: ProjectConfig, tickets=None, prs=None, error=None):
    """Build a BatchProjectResult-like MagicMock for a single project."""
    from lib_python_projects.providers import BatchProjectResult
    return BatchProjectResult(
        project=project,
        tickets=tickets if tickets is not None else [],
        pull_requests=prs if prs is not None else [],
        error=error,
    )


# ---------------------------------------------------------------------------
# Basic HTTP contract tests
# ---------------------------------------------------------------------------

def test_tickets_ok() -> None:
    """GET /tickets returns HTTP 200."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket()])]):
        response = client.get("/tickets")
    assert response.status_code == 200


def test_tickets_json_array() -> None:
    """GET /tickets body is a JSON object with a 'tickets' array."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket()])]):
        response = client.get("/tickets")
    assert isinstance(response.json()["tickets"], list)


def test_tickets_content_type() -> None:
    """GET /tickets Content-Type contains application/json."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket()])]):
        response = client.get("/tickets")
    assert "application/json" in response.headers["content-type"]


def test_tickets_item_fields() -> None:
    """Each row carries the provider ticket fields plus project context."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("7", "Wire the icon")])]):
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
    proj_a = _sample_project("a", "org/a")
    proj_b = _sample_project("b", "org/b")
    projects = [proj_a, proj_b]

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj_a, tickets=[_sample_ticket("a-1")]),
                   _make_batch_result(proj_b, tickets=[_sample_ticket("b-1")]),
               ]):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 2
    assert {i["project_id"] for i in items} == {"a", "b"}


def test_tickets_skips_failing_project() -> None:
    """A project whose batch entry has an error is skipped, not fatal to the board."""
    proj_good = _sample_project("good", "org/good")
    proj_bad = _sample_project("bad", "org/bad")
    projects = [proj_good, proj_bad]

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj_good, tickets=[_sample_ticket("good-1")]),
                   _make_batch_result(proj_bad, error="repo not found"),
               ]):
        response = client.get("/tickets")
    data = response.json()
    items = data["tickets"]
    assert response.status_code == 200
    assert len(items) == 1
    assert items[0]["project_id"] == "good"
    assert data["poll_errors"] is not None
    assert "bad" in data["poll_errors"]["failed_projects"]


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
    so the filename contract is asserted there. `fetch_open_board` is patched
    so the sample project's tickets resolve without a network call.
    """
    project = _sample_project()
    mock_load = MagicMock(return_value=_make_result([project]))
    with patch("src.providers.load_projects", mock_load), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[])]):
        client.get("/tickets")
    mock_load.assert_called_once_with(
        config_filename="projects.yml",
        config_filename_alt="projects.yaml",
    )


def test_tickets_filters_out_non_config_projects() -> None:
    """Only projects with source='config' appear on the board.

    Regression test for ticket #74: auto-discovered (source='git-remote') and
    token-discovered (source='token-discovery') projects must be stripped by
    load_all_projects() before the endpoint sees the project list.

    Three projects are returned by load_projects: one config-sourced (GitHub),
    one git-remote (GitLab), and one token-discovery (GitLab). The mock
    load_projects returns all three; load_all_projects should filter down to
    just the config project, so only its tickets appear in /tickets.
    """
    config_project = ProjectConfig(
        id="config-proj",
        description="Explicitly configured project",
        provider="github",
        path="org/config-proj",
        source="config",
    )
    git_remote_project = ProjectConfig(
        id="git-remote-proj",
        description="Auto-discovered via git remote",
        provider="gitlab",
        path="org/git-remote-proj",
        source="git-remote",
    )
    token_discovery_project = ProjectConfig(
        id="token-discovery-proj",
        description="Discovered via GitLab token",
        provider="gitlab",
        path="org/token-discovery-proj",
        source="token-discovery",
    )
    all_three = [config_project, git_remote_project, token_discovery_project]

    # Patch load_projects (the underlying lib call) to return all three.
    # config_file must be set so the guard in load_all_projects() activates.
    mock_load = MagicMock(return_value=ProjectsLoadResult(
        state="ok",
        search_root="/tmp",
        config_file="projects.yml",
        projects=all_three,
    ))

    # fetch_open_board is patched to accept whichever projects reach it.
    # We capture what projects it actually receives to assert the filter ran.
    captured_projects: list = []

    def capturing_batch(projects, token=None):
        captured_projects.extend(projects)
        return [_make_batch_result(config_project, tickets=[_sample_ticket("config-1")])]

    with patch("src.providers.load_projects", mock_load), \
         patch("src.api.tickets.fetch_open_board", side_effect=capturing_batch):
        response = client.get("/tickets")

    assert response.status_code == 200
    items = response.json()["tickets"]

    # Only the config-sourced project's ticket must appear.
    assert len(items) == 1
    assert items[0]["project_id"] == "config-proj"

    # The non-config projects must never have reached fetch_open_board.
    reached_ids = {p.id for p in captured_projects}
    assert "git-remote-proj" not in reached_ids, (
        "git-remote project leaked through to fetch_open_board"
    )
    assert "token-discovery-proj" not in reached_ids, (
        "token-discovery project leaked through to fetch_open_board"
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
    project = _sample_project()
    pr = _sample_pr(number=7, ticket_number=42)
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[pr])]):
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
    project = _sample_project()
    pr = _sample_pr(number=3, ticket_number=99)
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[pr])]):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["pull_request"] is None


def test_tickets_pr_null_when_no_prs() -> None:
    """No PRs at all → pull_request is null on every ticket."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[])]):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["pull_request"] is None


def test_tickets_pr_linked_via_branch_name() -> None:
    """A PR with head ref 'fix/42-some-description' is linked to ticket id='42'."""
    project = _sample_project()
    pr = _sample_pr(number=5, body="", ref="fix/42-some-description")
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[pr])]):
        response = client.get("/tickets")
    items = response.json()["tickets"]
    assert len(items) == 1
    pr_field = items[0]["pull_request"]
    assert pr_field is not None
    assert pr_field["number"] == 5


def test_tickets_pr_linked_via_branch_name_plain_prefix() -> None:
    """A PR with head ref '42-description' (no subdirectory) is also matched."""
    project = _sample_project()
    pr = _sample_pr(number=6, body="", ref="42-description")
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[pr])]):
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
    project = _sample_project()
    pr = _sample_pr(number=7, body="Fixes #42", ref="43-old-description")
    ticket_a = _sample_ticket("42", "Ticket A")
    ticket_b = _sample_ticket("43", "Ticket B")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[ticket_a, ticket_b], prs=[pr])]):
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
    """If list_prs raises for a non-GitHub project, tickets are still returned with pull_request=null."""
    project = _sample_gitlab_project()
    broken_provider = MagicMock()
    broken_provider.list_tickets.return_value = ([_sample_ticket("42")], False)
    broken_provider.list_prs.side_effect = RuntimeError("network error")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
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
    proj_a = _sample_project("proj-a", "org/a")
    proj_b = _sample_project("proj-b", "org/b")
    projects = [proj_a, proj_b]

    pr = _sample_pr(number=10, ticket_number=1)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj_a, tickets=[_sample_ticket("1")], prs=[pr]),
                   _make_batch_result(proj_b, tickets=[_sample_ticket("2")], prs=[]),
               ]):
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
    project = _sample_project()
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
                   return_value=_make_result([project])), \
             patch("src.api.tickets.fetch_open_board",
                   return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[pr])]):
            response = client.get("/tickets")
        items = response.json()["tickets"]
        assert items[0]["pull_request"] is not None, \
            f"Expected PR match for keyword '{kw}' but got null"


# ---------------------------------------------------------------------------
# New tests for rate-limit resilience (ticket #25).
# ---------------------------------------------------------------------------


def test_tickets_rate_limit_403_sets_flag() -> None:
    """When fetch_open_board raises RateLimitError (403), poll_errors.rate_limited is True."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_rate_limit_error(retry_after=120)):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"] is not None
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] == 120


def test_tickets_rate_limit_429_sets_flag() -> None:
    """When fetch_open_board raises RateLimitError (429), poll_errors.rate_limited is True."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_rate_limit_error(retry_after=120)):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] == 120


def test_tickets_rate_limit_retry_after_absent() -> None:
    """RateLimitError with no retry_after → poll_errors.retry_after is None."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_rate_limit_error(retry_after=None)):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] is None


def test_tickets_rate_limit_excludes_sentinel_from_ticket_list() -> None:
    """One rate-limited project + one good project → only good project's ticket."""
    proj_limited = _sample_project("rate-limited-proj", "org/limited")
    proj_good = _sample_project("good-proj", "org/good")
    projects = [proj_limited, proj_good]

    # Both are GitHub projects so both go through the batch path.
    # Simulate a whole-batch rate-limit — both projects get sentinels.
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_rate_limit_error(retry_after=None)):
        response = client.get("/tickets")

    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"]["rate_limited"] is True


def test_tickets_rate_limit_retry_after_max_across_projects() -> None:
    """Two rate-limited GitHub projects → retry_after is the maximum of both.

    With the batch path, the whole-batch RateLimitError carries the
    retry_after from the response. Two projects in the same batch
    produce sentinels with the same retry_after value; the max is itself.
    This test verifies that the sentinel retry_after flows through
    correctly and poll_errors.retry_after equals that value.
    """
    proj_a = _sample_project("proj-a", "org/a")
    proj_b = _sample_project("proj-b", "org/b")
    projects = [proj_a, proj_b]

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_rate_limit_error(retry_after=300)):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"]["retry_after"] == 300


def test_tickets_no_errors_poll_errors_null() -> None:
    """When all projects succeed, poll_errors is null."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket()])]):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"] is None


def test_tickets_generic_provider_failure_sets_failed_projects() -> None:
    """A ProviderError (non-rate-limit) from fetch_open_board populates failed_projects.

    Regression test: before the fix, ProviderError/GitHubError subclasses were
    never caught by the dead `except httpx.HTTPStatusError` branch, so the
    project was silently swallowed into [] and poll_errors stayed null — making
    the board indistinguishable from a genuinely empty project.
    """
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_provider_error(404)):
        response = client.get("/tickets")

    data = response.json()
    assert data["poll_errors"] is not None
    assert data["poll_errors"]["rate_limited"] is False
    assert "workboard" in data["poll_errors"]["failed_projects"]


def test_tickets_unknown_exception_does_not_set_poll_errors() -> None:
    """A bare RuntimeError from fetch_open_board degrades gracefully; board is not blanked.

    Regression test: _fetch_github_batch must honour the same "Never raises"
    contract as _fetch_project_tickets. An unexpected exception (network
    timeout, JSON decode error, lib bug) must degrade to __fail_error__
    sentinels rather than propagating a 500 that blanks the entire board.
    The project shows up in failed_projects; rate_limited stays False.
    """
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=RuntimeError("totally unexpected")):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"] is not None
    assert data["poll_errors"]["rate_limited"] is False
    assert "workboard" in data["poll_errors"]["failed_projects"]


def test_no_tickets_skips_list_prs() -> None:
    """When a GitHub batch project returns 0 tickets, no PRs need to be fetched.

    The batch call returns an empty tickets list (and no PRs) for the project.
    fetch_open_board is called exactly once; no provider_for call happens.
    """
    project = _sample_project()
    mock_batch = MagicMock(return_value=[_make_batch_result(project, tickets=[], prs=[])])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board", mock_batch):
        response = client.get("/tickets")

    assert response.status_code == 200
    assert response.json()["tickets"] == []
    mock_batch.assert_called_once()


def test_tickets_rate_limit_retry_after_non_numeric() -> None:
    """RateLimitError with retry_after=None must not crash the endpoint.

    The lib already normalises non-numeric Retry-After values to None before
    raising RateLimitError. The endpoint must return 200 with rate_limited: True
    and retry_after: None rather than a 500.
    """
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=_make_rate_limit_error(retry_after=None)):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] is None


# ---------------------------------------------------------------------------
# New batch-path tests (ticket #42 acceptance criteria).
# ---------------------------------------------------------------------------


def test_tickets_github_uses_single_batch_call() -> None:
    """Two GitHub projects produce exactly one fetch_open_board call with both projects.

    Regression test for the core acceptance criterion: N GitHub projects must
    not produce N individual REST calls.
    """
    proj_a = _sample_project("a", "org/a")
    proj_b = _sample_project("b", "org/b")
    projects = [proj_a, proj_b]

    mock_batch = MagicMock(return_value=[
        _make_batch_result(proj_a, tickets=[_sample_ticket("1")]),
        _make_batch_result(proj_b, tickets=[_sample_ticket("2")]),
    ])
    mock_provider_for = MagicMock()

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board", mock_batch), \
         patch("src.api.tickets.provider_for", mock_provider_for):
        response = client.get("/tickets")

    assert response.status_code == 200
    # fetch_open_board called exactly once with both projects.
    mock_batch.assert_called_once()
    call_args = mock_batch.call_args[0][0]  # first positional arg (projects list)
    assert {p.id for p in call_args} == {"a", "b"}
    # provider_for must NOT have been called for GitHub projects.
    mock_provider_for.assert_not_called()


def test_tickets_batch_returns_tickets_with_enrichment() -> None:
    """Batch result rows carry correct project_id/provider/project_path/pull_request."""
    proj_a = _sample_project("proj-a", "org/a")
    proj_b = _sample_project("proj-b", "org/b")
    projects = [proj_a, proj_b]

    pr_a = _sample_pr(number=10, ticket_number=1)

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj_a, tickets=[_sample_ticket("1")], prs=[pr_a]),
                   _make_batch_result(proj_b, tickets=[_sample_ticket("2")], prs=[]),
               ]):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 2
    by_proj = {i["project_id"]: i for i in items}

    assert by_proj["proj-a"]["provider"] == "github"
    assert by_proj["proj-a"]["project_path"] == "org/a"
    assert by_proj["proj-a"]["pull_request"] is not None
    assert by_proj["proj-a"]["pull_request"]["number"] == 10

    assert by_proj["proj-b"]["provider"] == "github"
    assert by_proj["proj-b"]["project_path"] == "org/b"
    assert by_proj["proj-b"]["pull_request"] is None


def test_tickets_batch_rate_limit_sets_poll_errors() -> None:
    """fetch_open_board raises RateLimitError → poll_errors.rate_limited True, tickets empty."""
    proj_a = _sample_project("proj-a", "org/a")
    proj_b = _sample_project("proj-b", "org/b")
    projects = [proj_a, proj_b]

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=RateLimitError(429, "rate limited", retry_after=120)):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] == 120
    # Both GitHub project IDs should be in failed_projects.
    assert set(data["poll_errors"]["failed_projects"]) == {"proj-a", "proj-b"}


def test_tickets_batch_rate_limit_retry_after_none() -> None:
    """RateLimitError with retry_after=None does not crash; poll_errors.retry_after is None."""
    project = _sample_project()
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=RateLimitError(429, "rate limited", retry_after=None)):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["poll_errors"]["rate_limited"] is True
    assert data["poll_errors"]["retry_after"] is None


def test_tickets_batch_partial_failure_github_plus_other_provider() -> None:
    """GitHub batch rate-limited + GitLab project succeeds → GitLab ticket present."""
    github_proj = _sample_project("gh-proj", "org/gh")
    gitlab_proj = _sample_gitlab_project("gl-proj", "org/gl")
    projects = [github_proj, gitlab_proj]

    gitlab_provider = _fake_provider([_sample_ticket("99", "GitLab ticket")])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               side_effect=RateLimitError(429, "rate limited", retry_after=60)), \
         patch("src.api.tickets.provider_for", return_value=gitlab_provider):
        response = client.get("/tickets")

    data = response.json()
    assert response.status_code == 200
    # GitLab ticket should be present.
    assert len(data["tickets"]) == 1
    assert data["tickets"][0]["project_id"] == "gl-proj"
    # GitHub project should be rate-limited.
    assert data["poll_errors"]["rate_limited"] is True
    assert "gh-proj" in data["poll_errors"]["failed_projects"]


def test_tickets_batch_per_project_error_sets_failed_projects() -> None:
    """BatchProjectResult.error non-None → that project ID in failed_projects, rate_limited False."""
    proj_ok = _sample_project("ok-proj", "org/ok")
    proj_err = _sample_project("err-proj", "org/err")
    projects = [proj_ok, proj_err]

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj_ok, tickets=[_sample_ticket("1")]),
                   _make_batch_result(proj_err, error="repo alias not found"),
               ]):
        response = client.get("/tickets")

    data = response.json()
    assert response.status_code == 200
    assert len(data["tickets"]) == 1
    assert data["tickets"][0]["project_id"] == "ok-proj"
    assert data["poll_errors"] is not None
    assert data["poll_errors"]["rate_limited"] is False
    assert "err-proj" in data["poll_errors"]["failed_projects"]


def test_tickets_non_github_skips_batch_call() -> None:
    """Only GitLab projects → fetch_open_board never called, GitLab tickets returned."""
    gitlab_proj = _sample_gitlab_project("gl-proj", "org/gl")
    gitlab_provider = _fake_provider([_sample_ticket("55", "GitLab issue")])
    mock_batch = MagicMock()

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([gitlab_proj])), \
         patch("src.api.tickets.fetch_open_board", mock_batch), \
         patch("src.api.tickets.provider_for", return_value=gitlab_provider):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert len(data["tickets"]) == 1
    assert data["tickets"][0]["project_id"] == "gl-proj"
    assert data["poll_errors"] is None
    # _fetch_github_batch short-circuits on an empty projects list and returns
    # [] before ever calling fetch_open_board — so the mock must be untouched.
    mock_batch.assert_not_called()


def test_tickets_empty_github_projects_no_batch_call() -> None:
    """Zero projects → fetch_open_board not called; response is empty tickets, null poll_errors."""
    mock_batch = MagicMock()

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([])), \
         patch("src.api.tickets.fetch_open_board", mock_batch):
        response = client.get("/tickets")

    assert response.status_code == 200
    data = response.json()
    assert data["tickets"] == []
    assert data["poll_errors"] is None
    mock_batch.assert_not_called()


def test_tickets_batch_pr_body_keyword_enrichment() -> None:
    """Batch PR with 'Fixes #42' body + ticket id 42 → PR attached to ticket 42."""
    project = _sample_project()
    pr = _sample_pr(number=7, ticket_number=42)
    ticket = _sample_ticket("42")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[ticket], prs=[pr])]):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 1
    pr_field = items[0]["pull_request"]
    assert pr_field is not None
    assert pr_field["number"] == 7


def test_tickets_batch_pr_branch_name_enrichment() -> None:
    """Batch PR head ref 'fix/42-description', no body match → ticket 42 gets PR via branch heuristic."""
    project = _sample_project()
    pr = _sample_pr(number=5, body="", ref="fix/42-description")
    ticket = _sample_ticket("42")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[ticket], prs=[pr])]):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 1
    pr_field = items[0]["pull_request"]
    assert pr_field is not None
    assert pr_field["number"] == 5


# ---------------------------------------------------------------------------
# New tests for the worktree enrichment feature (ticket #53).
# ---------------------------------------------------------------------------


def _sample_worktree_record(
    repo_root: str = "E:/development/workboard",
    branch: str = "fix/42-some-description",
    path: str = "C:/worktrees/workboard-fix-42",
    status: str = "idle",
) -> MagicMock:
    """Return a mock WorktreeRecord with the given fields."""
    rec = MagicMock()
    rec.id = "workboard-fix-42-abcd1234"
    rec.repo_root = repo_root
    rec.branch = branch
    rec.path = path
    rec.status = status
    return rec


def test_tickets_worktree_field_always_present() -> None:
    """Every row always contains the 'worktree' key (null or object).

    Exercises two projects — one with a matched worktree, one without — to
    confirm the key is present regardless of match state and across
    aggregated projects.
    """
    proj_a = _sample_project("proj-a", "org/a")
    proj_b = _sample_project("proj-b", "org/b")
    projects = [proj_a, proj_b]

    wt_record = _sample_worktree_record(branch="fix/1-my-feature")
    # proj-a ticket 1 gets a worktree; proj-b ticket 2 does not.
    def fake_wt_map(local_path):
        if local_path and "a" in str(local_path):
            return {1: wt_record}
        return {}

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj_a, tickets=[_sample_ticket("1")], prs=[]),
                   _make_batch_result(proj_b, tickets=[_sample_ticket("2")], prs=[]),
               ]), \
         patch("src.api.tickets._build_worktree_map", side_effect=fake_wt_map):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 2
    for item in items:
        assert "worktree" in item, f"worktree key missing in {item}"


def test_tickets_worktree_matched_via_branch_name() -> None:
    """A WorktreeRecord with branch 'fix/42-...' is linked to ticket id='42'."""
    project = _sample_project()
    wt_record = _sample_worktree_record(
        branch="fix/42-some-description",
        path="C:/worktrees/workboard-fix-42",
        status="idle",
    )

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[])]), \
         patch("src.api.tickets._build_worktree_map", return_value={42: wt_record}):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 1
    wt_field = items[0]["worktree"]
    assert wt_field is not None
    assert wt_field["id"] == "workboard-fix-42-abcd1234"
    assert wt_field["path"] == "C:/worktrees/workboard-fix-42"
    assert wt_field["branch"] == "fix/42-some-description"
    assert wt_field["status"] == "idle"


def test_tickets_worktree_null_when_no_local_path() -> None:
    """When local_path is None, _build_worktree_map returns {} and all rows have worktree=null."""
    from src.api.tickets import _build_worktree_map
    result = _build_worktree_map(None)
    assert result == {}


def test_tickets_worktree_null_when_store_absent() -> None:
    """When YamlStateStore().list() raises FileNotFoundError, all rows get worktree=null.

    This test exercises the real _build_worktree_map code path (not patched
    away) so that removing the ``except Exception`` handler inside
    _build_worktree_map would make this test FAIL.  It sets
    _WORKTREE_LIB_AVAILABLE=True and patches YamlStateStore so that
    list() raises FileNotFoundError, then asserts:
    - the endpoint returns HTTP 200 (no crash)
    - every ticket row has worktree=null (graceful degradation)
    """
    import src.api.tickets as tickets_module

    original_available = tickets_module._WORKTREE_LIB_AVAILABLE

    # Give the project a local_path so _build_worktree_map is not short-circuited
    # by the early-return guard (`if not local_path: return {}`).
    project_with_path = _sample_project()
    project_with_path.__dict__["local_path"] = "E:/development/workboard"

    mock_store = MagicMock()
    mock_store.list.side_effect = FileNotFoundError("~/.agent-worktree/state.yaml not found")

    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = True
        with patch("src.api.tickets.load_all_projects",
                   return_value=_make_result([project_with_path])), \
             patch("src.api.tickets.fetch_open_board",
                   return_value=[_make_batch_result(project_with_path,
                                                    tickets=[_sample_ticket("42")],
                                                    prs=[])]), \
             patch("src.api.tickets.YamlStateStore", return_value=mock_store):
            response = client.get("/tickets")
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original_available

    assert response.status_code == 200
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["worktree"] is None


def test_tickets_worktree_null_when_no_branch_match() -> None:
    """A worktree with branch 'chore/99-foo' does not match ticket id='42'."""
    project = _sample_project()
    # wt_map has no entry for ticket 42 — the branch belongs to a different ticket.
    wt_map = {}  # ticket 42 has no matching worktree

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[])]), \
         patch("src.api.tickets._build_worktree_map", return_value=wt_map):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["worktree"] is None


def test_tickets_pr_and_worktree_simultaneously() -> None:
    """A ticket can carry both pull_request and worktree non-null at once."""
    project = _sample_project()
    pr = _sample_pr(number=7, ticket_number=42)
    wt_record = _sample_worktree_record(
        branch="fix/42-my-feature",
        path="C:/worktrees/workboard-fix-42",
        status="running",
    )

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([project])), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[_make_batch_result(project, tickets=[_sample_ticket("42")], prs=[pr])]), \
         patch("src.api.tickets._build_worktree_map", return_value={42: wt_record}):
        response = client.get("/tickets")

    items = response.json()["tickets"]
    assert len(items) == 1
    item = items[0]
    # Both fields are non-null simultaneously.
    assert item["pull_request"] is not None
    assert item["pull_request"]["number"] == 7
    assert item["worktree"] is not None
    assert item["worktree"]["branch"] == "fix/42-my-feature"
    assert item["worktree"]["status"] == "running"


def test_build_worktree_map_filters_by_repo_root() -> None:
    """_build_worktree_map only includes records whose repo_root matches local_path.

    Regression: a worktree from a different repo must not bleed into this
    project's map.
    """
    import src.api.tickets as tickets_module

    # Temporarily enable the lib if it was unavailable (e.g. not installed).
    original_available = tickets_module._WORKTREE_LIB_AVAILABLE

    matching_rec = _sample_worktree_record(
        repo_root="E:/development/workboard",
        branch="fix/42-match",
        path="C:/wt/match",
    )
    other_rec = _sample_worktree_record(
        repo_root="E:/development/other-repo",
        branch="fix/42-other",
        path="C:/wt/other",
    )

    mock_store = MagicMock()
    mock_store.list.return_value = [matching_rec, other_rec]

    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = True
        with patch("src.api.tickets.YamlStateStore", return_value=mock_store):
            result = tickets_module._build_worktree_map("E:/development/workboard")
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original_available

    assert 42 in result
    assert result[42].path == "C:/wt/match"
    # The other repo's record must not appear.
    assert len(result) == 1


def test_build_worktree_map_degrades_on_store_exception() -> None:
    """_build_worktree_map returns {} when YamlStateStore().list() raises."""
    import src.api.tickets as tickets_module

    original_available = tickets_module._WORKTREE_LIB_AVAILABLE

    mock_store = MagicMock()
    mock_store.list.side_effect = FileNotFoundError("state.yaml not found")

    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = True
        with patch("src.api.tickets.YamlStateStore", return_value=mock_store):
            result = tickets_module._build_worktree_map("E:/development/workboard")
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original_available

    assert result == {}


# ---------------------------------------------------------------------------
# Regression tests for ticket #68: duplicate tickets and non-configured
# projects leaking onto the board.
# ---------------------------------------------------------------------------


def test_tickets_dedup_when_project_appears_twice() -> None:
    """Regression #68 (Bug B): when load_all_projects returns duplicate ProjectConfig
    entries for the same project, the /tickets endpoint returns each ticket exactly once.

    Simulates the scenario where a project ends up in the list twice (e.g. explicit
    config entry + auto-discovered CWD entry before the filter is applied) and verifies
    the dedup pass in tickets() prevents duplicate board cards.
    """
    proj = _sample_project("dup-proj", "org/dup")
    # Same project appearing twice in the list.
    projects_with_dup = [proj, proj]

    ticket = _sample_ticket("42", "Duplicate ticket")

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects_with_dup)), \
         patch("src.api.tickets.fetch_open_board",
               return_value=[
                   _make_batch_result(proj, tickets=[ticket]),
                   _make_batch_result(proj, tickets=[ticket]),
               ]):
        response = client.get("/tickets")

    assert response.status_code == 200
    items = response.json()["tickets"]
    # Despite two identical project entries each returning the same ticket,
    # only one row should appear on the board.
    assert len(items) == 1, (
        f"Expected 1 ticket but got {len(items)}; dedup did not fire"
    )
    assert items[0]["id"] == "42"
    assert items[0]["project_id"] == "dup-proj"


def test_load_all_projects_filters_auto_discovered_when_config_file_present() -> None:
    """Regression #68 (Bug A): when load_projects returns a result with config_file set,
    load_all_projects() must strip out projects whose source is 'git-remote' or
    'token-discovery', keeping only explicitly configured ('config' source) ones.

    This prevents the lib from leaking CWD auto-discovered repos onto the board
    when the user has a real projects.yml config file.
    """
    from lib_python_projects.models import ProjectsLoadResult

    config_proj = _sample_project("configured", "org/configured")
    config_proj = config_proj.model_copy(update={"source": "config"})

    auto_proj = _sample_project("auto-discovered", "org/auto")
    auto_proj = auto_proj.model_copy(update={"source": "git-remote"})

    token_proj = _sample_project("token-discovered", "org/token")
    token_proj = token_proj.model_copy(update={"source": "token-discovery"})

    # Simulate load_projects returning all three, with a config_file set.
    raw_result = ProjectsLoadResult(
        state="ok",
        config_file="projects.yml",
        search_root="/tmp",
        projects=[config_proj, auto_proj, token_proj],
    )

    with patch("src.providers.load_projects", return_value=raw_result):
        from src.providers import load_all_projects
        result = load_all_projects()

    project_ids = [p.id for p in result.projects]
    assert "configured" in project_ids, "Explicitly configured project must survive the filter"
    assert "auto-discovered" not in project_ids, (
        "git-remote project must be filtered out when config_file is set"
    )
    assert "token-discovered" not in project_ids, (
        "token-discovery project must be filtered out when config_file is set"
    )
    assert len(result.projects) == 1


def test_load_all_projects_does_not_filter_when_no_config_file() -> None:
    """When no config file was found (config_file=None), auto-discovered projects
    must pass through unchanged — filtering would blank a pure-discovery board.
    """
    from lib_python_projects.models import ProjectsLoadResult

    auto_proj = _sample_project("auto-discovered", "org/auto")
    auto_proj = auto_proj.model_copy(update={"source": "git-remote"})

    raw_result = ProjectsLoadResult(
        state="ok",
        config_file=None,
        search_root="/tmp",
        projects=[auto_proj],
    )

    with patch("src.providers.load_projects", return_value=raw_result):
        from src.providers import load_all_projects
        result = load_all_projects()

    assert len(result.projects) == 1
    assert result.projects[0].id == "auto-discovered"


# ---------------------------------------------------------------------------
# Tests for ticket #78: auto-delete orphaned worktrees during poll.
# ---------------------------------------------------------------------------


def test_enrich_rows_removes_orphaned_worktree() -> None:
    """Orphaned worktree (ticket not in open list) is deleted via WorktreeManager.remove().

    Regression for #78: _enrich_rows must call WorktreeManager().remove() with
    force=True and kill_blocking_processes=True for every wt_map entry whose
    ticket number is absent from the open ticket list.
    """
    import src.api.tickets as tickets_module

    project = _sample_project()
    # wt_map contains ticket 99 (orphan) — open tickets only has ticket 42.
    orphan_rec = _sample_worktree_record(branch="fix/99-orphaned", path="C:/wt/orphan")
    orphan_rec.id = "workboard-fix-99-deadbeef"

    open_ticket = _sample_ticket("42", "Open ticket")

    original = tickets_module._WORKTREE_LIB_AVAILABLE
    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = True
        # Patch _build_worktree_map to return a map with the orphaned record
        # already keyed by ticket number, bypassing the repo_root filter so
        # the test focuses purely on the orphan-deletion logic.
        # _spawn_background is patched to run its target inline (synchronously)
        # instead of on a real thread — cleanup is fire-and-forget in
        # production (see _spawn_background's docstring) but must be
        # deterministic here.
        with patch("src.api.tickets.WorktreeManager") as mock_wm_cls, \
             patch("src.api.tickets._build_worktree_map", return_value={99: orphan_rec}), \
             patch("src.api.tickets._spawn_background", side_effect=lambda fn, *a: fn(*a)):
            mock_wm_cls.return_value = MagicMock()
            tickets_module._enrich_rows(project, [open_ticket], [])
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original

    mock_wm_cls.return_value.remove.assert_called_once_with(
        orphan_rec.id, force=True, kill_blocking_processes=True
    )


def test_enrich_rows_does_not_remove_open_worktree() -> None:
    """A worktree whose ticket is still open must NOT be deleted.

    Regression for #78: _enrich_rows must leave wt_map entries alone when
    their ticket number appears in the open ticket list.
    """
    import src.api.tickets as tickets_module

    project = _sample_project()
    live_rec = _sample_worktree_record(branch="fix/42-live", path="C:/wt/live")
    live_rec.id = "workboard-fix-42-cafebabe"

    open_ticket = _sample_ticket("42", "Still open")

    original = tickets_module._WORKTREE_LIB_AVAILABLE
    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = True
        # Ticket 42 is in both wt_map and the open ticket list — must not be deleted.
        with patch("src.api.tickets.WorktreeManager") as mock_wm_cls, \
             patch("src.api.tickets._build_worktree_map", return_value={42: live_rec}):
            mock_wm_cls.return_value = MagicMock()
            tickets_module._enrich_rows(project, [open_ticket], [])
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original

    mock_wm_cls.return_value.remove.assert_not_called()


def test_enrich_rows_deletion_failure_is_logged_not_raised() -> None:
    """WorktreeManager.remove() raising must not propagate — endpoint stays HTTP 200.

    Regression for #78: deletion failures are caught, logged as warnings, and
    the poll cycle must continue normally.
    """
    import src.api.tickets as tickets_module

    project = _sample_project()
    orphan_rec = _sample_worktree_record(branch="fix/99-locked", path="C:/wt/locked")
    orphan_rec.id = "workboard-fix-99-locked"

    open_ticket = _sample_ticket("42", "Open ticket")

    original = tickets_module._WORKTREE_LIB_AVAILABLE
    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = True
        with patch("src.api.tickets.WorktreeManager") as mock_wm_cls, \
             patch("src.api.tickets._build_worktree_map", return_value={99: orphan_rec}), \
             patch("src.api.tickets.load_all_projects",
                   return_value=_make_result([project])), \
             patch("src.api.tickets.fetch_open_board",
                   return_value=[_make_batch_result(project,
                                                    tickets=[open_ticket], prs=[])]):
            mock_instance = MagicMock()
            mock_instance.remove.side_effect = RuntimeError("locked")
            mock_wm_cls.return_value = mock_instance
            response = client.get("/tickets")
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original

    assert response.status_code == 200
    # The open ticket is still returned despite the deletion failure.
    items = response.json()["tickets"]
    assert len(items) == 1
    assert items[0]["id"] == "42"


def test_enrich_rows_orphan_cleanup_skipped_when_lib_unavailable() -> None:
    """WorktreeManager.remove must never be called when _WORKTREE_LIB_AVAILABLE is False.

    Regression for #78: the cleanup block is guarded by _WORKTREE_LIB_AVAILABLE
    so it is safely skipped in environments where lib_python_worktree is absent.
    """
    import src.api.tickets as tickets_module

    project = _sample_project()
    open_ticket = _sample_ticket("42", "Open ticket")

    original = tickets_module._WORKTREE_LIB_AVAILABLE
    try:
        tickets_module._WORKTREE_LIB_AVAILABLE = False
        with patch("src.api.tickets.WorktreeManager") as mock_wm_cls:
            mock_wm_cls.return_value = MagicMock()
            tickets_module._enrich_rows(project, [open_ticket], [])
    finally:
        tickets_module._WORKTREE_LIB_AVAILABLE = original

    mock_wm_cls.return_value.remove.assert_not_called()
