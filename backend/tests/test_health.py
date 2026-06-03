"""Tests for the /health endpoint."""

from fastapi.testclient import TestClient

from src.main import app


client = TestClient(app)


def test_health_ok() -> None:
    """GET /health returns HTTP 200."""
    response = client.get("/health")
    assert response.status_code == 200


def test_health_content() -> None:
    """GET /health body is {"status": "ok"}."""
    response = client.get("/health")
    assert response.json() == {"status": "ok"}


def test_health_content_type() -> None:
    """GET /health Content-Type contains application/json."""
    response = client.get("/health")
    assert "application/json" in response.headers["content-type"]
