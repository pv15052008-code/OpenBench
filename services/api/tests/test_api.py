"""
API tests. Supabase and Gemini are replaced by an in-process fake so we can check
the permission logic: the API must refuse whenever the user-scoped database call
does not return the row, and must only then use the service key.
"""
import json
import os

os.environ.update({
    "SUPABASE_URL": "https://fake.supabase.co", "SUPABASE_ANON_KEY": "anon-key",
    "SUPABASE_SERVICE_ROLE_KEY": "service-key", "CRON_SECRET": "cron-secret-123",
    "GEMINI_API_KEY": "", "RESEND_API_KEY": "",
})

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth as auth_mod  # noqa: E402
from app.main import app  # noqa: E402

BOOKING = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"
QUAL = "33333333-3333-3333-3333-333333333333"
INC = "44444444-4444-4444-4444-444444444444"
USERS = {"tok-owner": "u-owner", "tok-student": "u-student", "tok-admin": "u-admin"}


class FakeSupabase:
    def __init__(self):
        self.calls = []
        self.writes = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ")
        path = request.url.path
        self.calls.append((request.method, path, token))
        if request.url.host == "generativelanguage.googleapis.com":
            return httpx.Response(500)
        if path == "/auth/v1/user":
            return httpx.Response(200, json={"id": USERS[token]}) if token in USERS else httpx.Response(401, json={"msg": "bad jwt"})
        if path == "/rest/v1/rpc/review_queue":
            reqs = [] if token != "tok-owner" else [{
                "id": BOOKING, "purpose": "Printing a chassis", "start": "2026-11-01T10:00:00Z",
                "resource": {"name": "Prusa MK4"}, "user": {"full_name": "Aarav"}, "checks": [{"label": "Training", "ok": True}],
                "competition": {"competing": 2, "rank": 1}, "user_week": {"minutes": 120}, "user_strikes": 0, "user_history": 0}]
            return httpx.Response(200, json={"requests": reqs, "returns": [], "active": []})
        if path == "/rest/v1/rpc/verification_queue":
            quals = [] if token != "tok-owner" else [{"id": QUAL, "user_id": "u-student", "training_tag": "3d_printing",
                                                      "evidence_path": "u-student/cert.png", "user": {"full_name": "Aarav Singh"}}]
            return httpx.Response(200, json={"profiles": [], "qualifications": quals, "users": []})
        if path == "/rest/v1/rpc/incident_feed":
            items = [{"id": INC, "booking_id": BOOKING, "type": "damage", "severity": "medium", "description": "Scratch on lens"}] \
                if token in ("tok-owner", "tok-student") else []
            return httpx.Response(200, json=items)
        if path == "/rest/v1/rpc/get_booking":
            return httpx.Response(200, json={"can": {"manage": token == "tok-owner"}, "resource": {"name": "Camera"},
                "records": [{"phase": "checkin", "checklist": [{"key": "lens", "label": "Lens clean", "ok": True}]},
                            {"phase": "return", "checklist": [{"key": "lens", "label": "Lens clean", "ok": False, "note": "scratch"}]}]})
        if path == "/rest/v1/rpc/list_resources":
            return httpx.Response(200, json=[
                {"id": "r1", "name": "Keysight Oscilloscope", "category": "Oscilloscope", "location": "A-115", "eligible": True},
                {"id": "r2", "name": "Sony Camera", "category": "Camera", "location": "C-012", "eligible": False}])
        if path == "/storage/v1/object/authenticated/eligibility-docs/u-student/cert.png":
            assert token == "service-key"
            return httpx.Response(200, content=b"\x89PNG fake", headers={"content-type": "image/png"})
        if path.startswith("/rest/v1/profiles"):
            role = {"tok-admin": "admin"}.get(token, "user")
            return httpx.Response(200, json=[{"role": role, "verification_status": "verified"}])
        if path == "/rest/v1/rpc/seed_demo":
            assert token == "service-key"
            return httpx.Response(200, json={"ok": True})
        if path == "/rest/v1/rpc/sweep_due":
            assert token == "service-key"
            return httpx.Response(200, json={"no_show": 0, "overdue": 0})
        if request.method == "PATCH":
            assert token == "service-key", "writes must use the service key"
            self.writes.append((path, dict(request.url.params), json.loads(request.content)))
            return httpx.Response(200, json=[{}])
        return httpx.Response(404, json={"message": "unexpected " + path})


@pytest.fixture
def fake():
    f = FakeSupabase()
    auth_mod._CACHE.clear()
    from app import ratelimit
    ratelimit._hits.clear()
    with TestClient(app) as client:
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(f.handler))
        client.fake = f
        yield client


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_health(fake):
    r = fake.get("/health")
    assert r.status_code == 200 and r.json()["ai"] == "rules"
    assert r.headers["x-frame-options"] == "DENY"


def test_requires_sign_in(fake):
    assert fake.post(f"/ai/brief/{BOOKING}").status_code == 401
    assert fake.post(f"/ai/brief/{BOOKING}", headers=H("forged")).status_code == 401


def test_brief_owner_ok_and_written_with_service_key(fake):
    r = fake.post(f"/ai/brief/{BOOKING}", headers=H("tok-owner"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "rules" and "Aarav" in body["summary"]
    assert any("compete" in f for f in body["flags"])
    path, params, values = fake.fake.writes[-1]
    assert path == "/rest/v1/bookings" and params == {"id": f"eq.{BOOKING}"} and "ai_brief" in values


def test_brief_student_refused_and_nothing_written(fake):
    r = fake.post(f"/ai/brief/{BOOKING}", headers=H("tok-student"))
    assert r.status_code == 404
    assert fake.fake.writes == []


def test_brief_rejects_non_uuid(fake):
    assert fake.post("/ai/brief/../../rest/v1/bookings", headers=H("tok-owner")).status_code == 404
    assert fake.post("/ai/brief/not-a-uuid", headers=H("tok-owner")).status_code == 422


def test_certificate_flow(fake):
    r = fake.post(f"/ai/certificate/{QUAL}", headers=H("tok-owner"))
    assert r.status_code == 200 and r.json()["source"] == "rules"
    assert fake.post(f"/ai/certificate/{QUAL}", headers=H("tok-student")).status_code == 404


def test_incident_requires_manage(fake):
    assert fake.post(f"/ai/incident/{INC}", headers=H("tok-student")).status_code == 403
    r = fake.post(f"/ai/incident/{INC}", headers=H("tok-owner"))
    assert r.status_code == 200
    assert r.json()["changed_items"] == ["Lens clean: OK at check-in, not OK at return (scratch)"]


def test_search_rules_fallback(fake):
    r = fake.post("/ai/search", headers=H("tok-student"), json={"query": "measure a 5 MHz signal"})
    assert r.status_code == 200
    assert r.json()["results"][0]["id"] == "r1"
    assert fake.post("/ai/search", headers=H("tok-student"), json={"query": "x" * 400}).status_code == 422


def test_cron_secret(fake):
    assert fake.post("/cron/tick").status_code == 401
    assert fake.post("/cron/tick", headers={"X-Cron-Secret": "wrong"}).status_code == 401
    r = fake.post("/cron/tick", headers={"X-Cron-Secret": "cron-secret-123"})
    assert r.status_code == 200 and r.json()["emailed"] == 0


def test_reset_demo_admin_only(fake):
    assert fake.post("/admin/reset-demo", headers=H("tok-student")).status_code == 403
    assert fake.post("/admin/reset-demo", headers=H("tok-admin")).status_code == 200


def test_rate_limit(fake):
    codes = [fake.post("/ai/search", headers=H("tok-student"), json={"query": "camera"}).status_code for _ in range(22)]
    assert codes[:20] == [200] * 20 and codes[-1] == 429


def test_cors_only_allowed_origins(fake):
    r = fake.options("/ai/search", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers
    r = fake.options("/ai/search", headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:8081"


def test_oversized_body_refused(fake):
    r = fake.post("/ai/search", headers={**H("tok-student"), "Content-Length": "100000"}, content=b"x" * 100000)
    assert r.status_code == 413


def test_reset_limit_is_per_admin_and_after_the_check(fake):
    for _ in range(5):
        assert fake.post("/admin/reset-demo", headers=H("tok-student")).status_code == 403
    assert fake.post("/admin/reset-demo", headers=H("tok-admin")).status_code == 200


def test_service_marker_token_is_not_special(fake):
    assert fake.post(f"/ai/brief/{BOOKING}", headers=H("__service__")).status_code == 401


def test_checklist_diff_ignores_malformed_items():
    from app.ai import checklist_diff
    recs = [{"phase": "checkin", "checklist": [None, {"key": "lens", "label": "Lens", "ok": True}, {"label": {"x": 1}}]},
            {"phase": "return", "checklist": [None, {"key": "lens", "label": "Lens", "ok": False}]}, None]
    assert checklist_diff(recs) == ["Lens: OK at check-in, not OK at return"]
