"""Old conditional requests must not revive module-bound chat settings."""

import re

from fastapi.testclient import TestClient

from todo_backend.main import create_app


def test_frontend_assets_are_fresh() -> None:
    # No lifespan: static assets require neither the database nor external workers.
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    html = client.get("/").text
    scripts = re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', html)
    assert {"/sources.js", "/suggestions.js", "/chat-results.js"} <= {
        path.partition("?")[0] for path in scripts
    }
    # Check current assets as well as old URLs; versions may change on each frontend release.
    for path in ("/", "/sources.js?v=1", "/suggestions.js?v=1", "/style.css", *scripts):
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
    source_path = next(path for path in scripts if path.partition("?")[0] == "/sources.js")
    script = client.get(source_path).text
    assert "sourceContext=id||null" in script
    assert "id||selection.module" not in script
