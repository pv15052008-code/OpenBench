"""
OpenBench engine API.

Every endpoint first asks Supabase, *with the caller's own token*, for the data it
needs. If the database's permission checks don't return the row, the caller isn't
allowed to act on it and we stop. Only then is the service-role key used, and only
to write the advisory AI field back.
"""
from __future__ import annotations

import hmac
import logging
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import ai
from .auth import Caller, current_user
from .config import get_settings
from .ratelimit import limit
from .supa import SupabaseError, as_user, service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("openbench.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))
    yield
    await app.state.http.aclose()


app = FastAPI(title="OpenBench API", version="1.0.0", lifespan=lifespan,
              docs_url="/docs", redoc_url=None, openapi_url="/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if int(request.headers.get("content-length") or 0) > 64_000:
        return JSONResponse({"detail": "Request too large"}, status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(SupabaseError)
async def supabase_error(_: Request, e: SupabaseError):
    # Database messages are written for users (e.g. "Booking not found"); pass 4xx through, hide 5xx detail
    if 400 <= e.status < 500:
        status = 404 if "not found" in e.message.lower() else (403 if e.status in (401, 403) else 400)
        return JSONResponse({"detail": e.message[:300]}, status_code=status)
    log.error("supabase %s: %s", e.status, e.message[:300])
    return JSONResponse({"detail": "The database is not responding. Try again shortly."}, status_code=502)


def http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http


@app.get("/health")
async def health():
    s = get_settings()
    return {"ok": True, "ai": "gemini" if s.gemini_api_key else "rules", "email": bool(s.resend_api_key),
            "time": datetime.now(timezone.utc).isoformat()}


# ---------------------------------------------------------------------------
# AI endpoints (advisory only)
# ---------------------------------------------------------------------------

@app.post("/ai/brief/{booking_id}")
async def brief(booking_id: uuid.UUID, caller: Caller = Depends(current_user), client=Depends(http)):
    limit(f"ai:{caller.id}", 30, 60)
    queue = await as_user(caller.token, client).rpc("review_queue")
    item = next((r for r in (queue or {}).get("requests", []) if r.get("id") == str(booking_id)), None)
    if item is None:
        raise HTTPException(404, "Request not found in your review queue")
    result = await ai.request_brief(client, item)
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    await service(client).update("bookings", {"id": str(booking_id)}, {"ai_brief": result})
    return result


@app.post("/ai/certificate/{qualification_id}")
async def certificate(qualification_id: uuid.UUID, caller: Caller = Depends(current_user), client=Depends(http)):
    limit(f"ai:{caller.id}", 30, 60)
    queue = await as_user(caller.token, client).rpc("verification_queue")
    q = next((x for x in (queue or {}).get("qualifications", []) if x.get("id") == str(qualification_id)), None)
    if q is None:
        raise HTTPException(404, "Qualification not found in your verification queue")
    path = q.get("evidence_path") or ""
    file = None
    # The path was written by its owner under their own folder (enforced by a trigger); check again
    if re.fullmatch(rf"{re.escape(q['user_id'])}/[A-Za-z0-9._-]{{1,120}}", path):
        try:
            file = await service(client).download("eligibility-docs", path)
        except SupabaseError as e:
            log.info("certificate download failed: %s", e.status)
    if file and file[1] not in ("image/jpeg", "image/png", "image/webp", "application/pdf"):
        file = None
    result = await ai.certificate_prescreen(client, file, (q.get("user") or {}).get("full_name", ""), q.get("training_tag", ""))
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    await service(client).update("user_qualifications", {"id": str(qualification_id)}, {"ai_review": result})
    return result


@app.post("/ai/incident/{incident_id}")
async def incident(incident_id: uuid.UUID, caller: Caller = Depends(current_user), client=Depends(http)):
    limit(f"ai:{caller.id}", 30, 60)
    user_db = as_user(caller.token, client)
    feed = await user_db.rpc("incident_feed")
    inc = next((i for i in feed or [] if i.get("id") == str(incident_id)), None)
    if inc is None:
        raise HTTPException(404, "Incident not found")
    booking = await user_db.rpc("get_booking", {"p_id": inc["booking_id"]})
    if not (booking.get("can") or {}).get("manage"):
        raise HTTPException(403, "Only the people managing this resource can summarise its incidents")
    result = await ai.incident_summary(client, inc, booking)
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    await service(client).update("incidents", {"id": str(incident_id)}, {"ai_summary": result})
    return result


class SearchBody(BaseModel):
    query: str = Field(min_length=2, max_length=300)


@app.post("/ai/search")
async def search(body: SearchBody, caller: Caller = Depends(current_user), client=Depends(http)):
    limit(f"search:{caller.id}", 20, 60)
    resources = await as_user(caller.token, client).rpc("list_resources", {})
    result = await ai.smart_search(client, body.query, resources or [])
    by_id = {r["id"]: r for r in resources or []}
    result["results"] = [{**by_id[m["id"]], "reason": m["reason"]} for m in result["matches"] if m["id"] in by_id]
    return result


# ---------------------------------------------------------------------------
# Scheduled work: no-shows, overdue returns, email delivery
# ---------------------------------------------------------------------------

def _check_secret(given: str) -> None:
    expected = get_settings().cron_secret
    if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(401, "Bad cron secret")


async def _send_emails(client: httpx.AsyncClient) -> int:
    s = get_settings()
    if not s.resend_api_key:
        return 0
    db = service(client)
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    rows = await db.select("notifications", {
        "select": "id,title,body,booking_id,user:profiles(email,full_name)",
        "emailed_at": "is.null", "created_at": f"gte.{since}", "order": "created_at.asc", "limit": "50"})
    sent = 0
    for n in rows or []:
        to = (n.get("user") or {}).get("email")
        if not to:
            continue
        link = f"{s.app_url.rstrip('/')}/bookings/{n['booking_id']}" if n.get("booking_id") else s.app_url
        text = f"{n['title']}\n\n{n.get('body') or ''}\n\nOpen OpenBench: {link}\n"
        try:
            r = await client.post("https://api.resend.com/emails", headers={"Authorization": f"Bearer {s.resend_api_key}"},
                                  json={"from": s.email_from, "to": [to], "subject": n["title"][:120], "text": text}, timeout=10)
            if r.status_code < 300:
                await db.update("notifications", {"id": n["id"]}, {"emailed_at": datetime.now(timezone.utc).isoformat()})
                sent += 1
        except httpx.HTTPError:
            break
    return sent


@app.post("/cron/tick")
async def cron_tick(x_cron_secret: str = Header(default=""), client=Depends(http)):
    _check_secret(x_cron_secret)
    swept = await service(client).rpc("sweep_due")
    emailed = await _send_emails(client)
    return {"swept": swept, "emailed": emailed}


# ---------------------------------------------------------------------------
# Demo reset for judging (admin only)
# ---------------------------------------------------------------------------

@app.post("/admin/reset-demo")
async def reset_demo(caller: Caller = Depends(current_user), client=Depends(http)):
    me = await as_user(caller.token, client).select("profiles", {"select": "role,verification_status", "id": f"eq.{caller.id}"})
    if not me or me[0].get("role") != "admin" or me[0].get("verification_status") != "verified":
        raise HTTPException(403, "Only an admin can reset the demo")
    limit(f"reset-demo:{caller.id}", 2, 60)  # checked after the admin test, so others can't use up the admin's allowance
    result = await service(client).rpc("seed_demo")
    log.info("demo reset by %s", caller.id)
    return result
