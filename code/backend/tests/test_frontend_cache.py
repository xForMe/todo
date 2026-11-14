"""Old conditional requests must not revive module-bound chat settings."""

from fastapi.testclient import TestClient

from todo_backend.main import create_app


def test_frontend_assets_are_fresh() -> None:
    # No lifespan: static assets require neither the database nor external workers.
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    for path in ("/", "/sources.js?v=1", "/suggestions.js?v=1", "/style.css"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        revalidated = client.get(
            path,
            headers={
                "If-None-Match": response.headers["etag"],
                "If-Modified-Since": response.headers["last-modified"],
            },
        )
        assert revalidated.status_code == 200
        assert revalidated.content == response.content
    html = client.get("/").text
    assert "/sources.js?v=3" in html and "/suggestions.js?v=4" in html
    script = client.get("/sources.js?v=3").text
    assert "sourceContext=id||null" in script
    assert "id||selection.module" not in script
