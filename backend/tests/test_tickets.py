"""Tests for the /tickets endpoint.

The endpoint aggregates open tickets across every configured project by
dispatching to each project's provider (mirroring the
`agent-project-issues` plugin). Tests patch `load_all_projects` and
`provider_for` in the endpoint's namespace so no network or config disk
access happens.
"""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from src.main import app
from lib_python_projects.models import ProjectConfig, ProjectsLoadResult
from lib_python_projects.providers.base import Ticket


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


def _fake_provider(tickets: list[Ticket]) -> MagicMock:
    provider = MagicMock()
    provider.list_tickets.return_value = (tickets, False)
    return provider


def test_tickets_ok() -> None:
    """GET /tickets returns HTTP 200."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket()])):
        response = client.get("/tickets")
    assert response.status_code == 200


def test_tickets_json_array() -> None:
    """GET /tickets body is a JSON array."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([_sample_project()])), \
         patch("src.api.tickets.provider_for",
               return_value=_fake_provider([_sample_ticket()])):
        response = client.get("/tickets")
    assert isinstance(response.json(), list)


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
    items = response.json()
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
    items = response.json()
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
            return broken
        return _fake_provider([_sample_ticket("good-1")])

    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result(projects)), \
         patch("src.api.tickets.provider_for", side_effect=fake_provider_for):
        response = client.get("/tickets")
    items = response.json()
    assert response.status_code == 200
    assert len(items) == 1
    assert items[0]["project_id"] == "good"


def test_tickets_empty_list() -> None:
    """GET /tickets with no projects returns 200 with empty array."""
    with patch("src.api.tickets.load_all_projects",
               return_value=_make_result([])):
        response = client.get("/tickets")
    assert response.status_code == 200
    assert response.json() == []


def test_tickets_lib_error_returns_500() -> None:
    """GET /tickets when project loading raises RuntimeError returns HTTP 500."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)
    with patch("src.api.tickets.load_all_projects",
               side_effect=RuntimeError("config broken")):
        response = no_raise_client.get("/tickets")
    assert response.status_code == 500
