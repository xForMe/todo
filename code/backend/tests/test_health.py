from fastapi.testclient import TestClient

from todo_backend.main import create_app


def test_liveness_contract() -> None:
    with TestClient(create_app(), base_url="http://127.0.0.1") as client:
        response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
