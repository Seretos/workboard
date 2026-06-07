"""Tests for the /tickets endpoint."""

from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient

from src.main import app
from lib_python_projects.models import ProjectConfig, ProjectsLoadResult


client = TestClient(app)


def _make_result(projects: list[ProjectConfig]) -> ProjectsLoadResult:
    """Build a minimal ProjectsLoadResult for mocking."""
    return ProjectsLoadResult(
        state="ok",
        search_root="/tmp",
        projects=projects,
    )


def _sample_project() -> ProjectConfig:
    return ProjectConfig(
        id="workboard",
        description="Workboard project",
        provider="github",
        path="Seretos/workboard",
    )


def test_tickets_ok() -> None:
    """GET /tickets returns HTTP 200."""
    with patch("src.api.tickets.load_projects", return_value=_make_result([_sample_project()])):
        response = client.get("/tickets")
    assert response.status_code == 200


def test_tickets_json_array() -> None:
    """GET /tickets body is a JSON array."""
    with patch("src.api.tickets.load_projects", return_value=_make_result([_sample_project()])):
        response = client.get("/tickets")
    body = response.json()
    assert isinstance(body, list)


def test_tickets_content_type() -> None:
    """GET /tickets Content-Type contains application/json."""
    with patch("src.api.tickets.load_projects", return_value=_make_result([_sample_project()])):
        response = client.get("/tickets")
    assert "application/json" in response.headers["content-type"]


def test_tickets_item_fields() -> None:
    """Each ticket item contains at minimum id, provider, and path."""
    with patch("src.api.tickets.load_projects", return_value=_make_result([_sample_project()])):
        response = client.get("/tickets")
    items = response.json()
    assert len(items) == 1
    item = items[0]
    assert item["id"] == "workboard"
    assert item["provider"] == "github"
    assert item["path"] == "Seretos/workboard"
    assert item["description"] == "Workboard project"


def test_tickets_empty_list() -> None:
    """GET /tickets with no projects returns 200 with empty array."""
    with patch("src.api.tickets.load_projects", return_value=_make_result([])):
        response = client.get("/tickets")
    assert response.status_code == 200
    assert response.json() == []


def test_tickets_lib_error_returns_500() -> None:
    """GET /tickets when load_projects raises RuntimeError returns HTTP 500."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)
    with patch("src.api.tickets.load_projects", side_effect=RuntimeError("config broken")):
        response = no_raise_client.get("/tickets")
    assert response.status_code == 500


def test_tickets_load_projects_called_with_correct_filename() -> None:
    """GET /tickets calls load_projects with config_filename='projects.yml'."""
    mock_load = MagicMock(return_value=_make_result([_sample_project()]))
    with patch("src.api.tickets.load_projects", mock_load):
        client.get("/tickets")
    mock_load.assert_called_once_with(
        config_filename="projects.yml",
        config_filename_alt="projects.yaml",
    )


def test_tickets_file_not_found_returns_500() -> None:
    """GET /tickets when load_projects raises FileNotFoundError returns HTTP 500."""
    no_raise_client = TestClient(app, raise_server_exceptions=False)
    with patch(
        "src.api.tickets.load_projects",
        side_effect=FileNotFoundError("projects.yml not found"),
    ):
        response = no_raise_client.get("/tickets")
    assert response.status_code == 500
