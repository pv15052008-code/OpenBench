"""
Local test gateway: a minimal stand-in for the Supabase HTTP endpoints the app
uses (auth, PostgREST-style REST and RPC, storage), backed by the local Postgres
with all migrations applied. Every data request runs as the `authenticated`
role with the caller's user id, so RLS, grants and triggers behave as in production.

TEST TOOL ONLY. Never deploy this. Run:
  python supabase/tests/gateway.py   (listens on :54321)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import psycopg
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

DSN = os.environ.get("TEST_DSN", "host=127.0.0.1 dbname=openbench_test user=postgres password=postgres")
SECRET = b"local-test-secret-not-for-production"
ANON_KEY = "local-anon-key"
SERVICE_KEY = "local-service-key"
PASSWORD = os.environ.get("DEMO_PASSWORD", "OpenBench@2026")
FILES = Path(os.environ.get("GATEWAY_FILES", "/tmp/openbench-gateway-files"))
FILES.mkdir(parents=True, exist_ok=True)
IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["*"])


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwt(sub: str, email: str, ttl: int = 3600) -> tuple[str, int]:
    exp = int(time.time()) + ttl
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps({"sub": sub, "email": email, "role": "authenticated", "aud": "authenticated", "exp": exp, "iat": int(time.time())}).encode())
    sig = b64(hmac.new(SECRET, f"{header}.{body}".encode(), hashlib.sha256).digest())
    return f"{header}.{body}.{sig}", exp


def verify(token: str) -> dict | None:
    try:
        h, b, s = token.split(".")
        good = b64(hmac.new(SECRET, f"{h}.{b}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(good, s):
            return None
        claims = json.loads(base64.urlsafe_b64decode(b + "=="))
        return claims if claims["exp"] > time.time() else None
    except Exception:
        return None


def caller(request: Request) -> tuple[str, str]:
    """('service', '') | ('authenticated', uid) | ('anon', '')"""
    auth = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    apikey = request.headers.get("apikey", "")
    if auth == SERVICE_KEY or (apikey == SERVICE_KEY and auth in ("", SERVICE_KEY)):
        return "service_role", ""
    claims = verify(auth) if auth and auth != ANON_KEY else None
    if claims:
        return "authenticated", claims["sub"]
    return "anon", ""


def run(role: str, uid: str, sql: str, params: list | tuple = (), fetch: str = "all"):
    with psycopg.connect(DSN) as conn:
        conn.execute(f"set role {role}")
        conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
        cur = conn.execute(sql, params)
        out = (cur.fetchall() if fetch == "all" else cur.fetchone()) if cur.description else None
        conn.commit()
        return out, cur


def pg_error(e: psycopg.Error) -> JSONResponse:
    code = getattr(e, "sqlstate", None) or "XX000"
    msg = (e.diag.message_primary if e.diag and e.diag.message_primary else str(e)).strip()
    status = 403 if code == "42501" else 404 if code == "P0002" else 409 if code in ("23505", "23P01") else 400
    return JSONResponse({"code": code, "message": msg, "details": None, "hint": None}, status_code=status)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def session_for(uid: str, email: str) -> dict:
    token, exp = jwt(uid, email)
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {},
            "created_at": "2026-01-01T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": exp,
            "refresh_token": b64(json.dumps({"uid": uid, "email": email}).encode()), "user": user}


@app.post("/auth/v1/token")
async def token(request: Request):
    grant = request.query_params.get("grant_type")
    body = await request.json()
    if grant == "password":
        rows, _ = run("postgres", "", "select id::text, email from auth.users where lower(email) = lower(%s)", (body.get("email", ""),))
        if not rows or body.get("password") != PASSWORD:
            return JSONResponse({"error": "invalid_grant", "error_description": "Invalid login credentials", "msg": "Invalid login credentials",
                                 "code": "invalid_credentials"}, status_code=400)
        return session_for(rows[0][0], rows[0][1])
    if grant == "refresh_token":
        try:
            d = json.loads(base64.urlsafe_b64decode(body["refresh_token"] + "=="))
            return session_for(d["uid"], d["email"])
        except Exception:
            return JSONResponse({"error": "invalid_grant", "msg": "Invalid refresh token"}, status_code=400)
    return JSONResponse({"msg": "unsupported grant"}, status_code=400)


@app.post("/auth/v1/signup")
async def signup(request: Request):
    body = await request.json()
    try:
        rows, _ = run("postgres", "", "insert into auth.users (email, raw_user_meta_data) values (lower(%s), %s) returning id::text, email",
                      (body["email"], json.dumps(body.get("data") or {})))
    except psycopg.Error as e:
        return JSONResponse({"msg": e.diag.message_primary or "Sign-up failed", "code": "unexpected_failure"}, status_code=400)
    return session_for(rows[0][0], rows[0][1])


@app.get("/auth/v1/user")
async def user(request: Request):
    role, uid = caller(request)
    if role != "authenticated":
        return JSONResponse({"msg": "invalid JWT", "code": "bad_jwt"}, status_code=401)
    rows, _ = run("postgres", "", "select email from auth.users where id = %s", (uid,))
    return {"id": uid, "email": rows[0][0], "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}}


@app.post("/auth/v1/logout")
async def logout():
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# REST: RPC and simple table access
# ---------------------------------------------------------------------------

@app.post("/rest/v1/rpc/{fn}")
async def rpc(fn: str, request: Request):
    if not IDENT.match(fn):
        return JSONResponse({"message": "bad function"}, status_code=400)
    role, uid = caller(request)
    raw = await request.body()
    args: dict[str, Any] = json.loads(raw) if raw else {}
    # Function argument types: let Postgres cast from text/json via a typed lookup
    types, _ = run("postgres", "", """
        select p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = %s""", (fn,))
    casts = {}
    if types:
        casts = dict(zip(types[0][0] or [], types[0][1]))
    named = ", ".join(f"{k} => %s::{casts.get(k, 'text')}" for k in args if IDENT.match(k))
    vals = []
    for k, v in args.items():
        if not IDENT.match(k):
            continue
        vals.append(json.dumps(v) if casts.get(k) in ("jsonb", "json") else v)
    try:
        row, _ = run(role, uid, f"select to_jsonb({fn}({named}))", vals, fetch="one")
    except psycopg.Error as e:
        return pg_error(e)
    return JSONResponse(row[0] if row else None)


def build_filters(params) -> tuple[str, list]:
    where, vals = [], []
    for k, v in params.multi_items():
        if k in ("select", "order", "limit", "offset", "columns", "on_conflict"):
            continue
        if not IDENT.match(k):
            raise ValueError("bad column")
        op, _, val = v.partition(".")
        if op == "eq":
            where.append(f"{k}::text = %s"); vals.append(val)
        elif op == "is":
            where.append(f"{k} is {'null' if val == 'null' else 'not null' if val == 'not.null' else 'true' if val == 'true' else 'false'}")
        elif op == "gte":
            where.append(f"{k} >= %s"); vals.append(val)
        elif op == "in":
            items = val.strip("()").split(",")
            where.append(f"{k}::text = any(%s)"); vals.append(items)
        else:
            raise ValueError(f"unsupported filter {op}")
    return (" where " + " and ".join(where)) if where else "", vals


def select_list(sel: str | None) -> str:
    if not sel or sel == "*":
        return "*"
    cols = [c.strip() for c in sel.split(",")]
    if not all(IDENT.match(c) for c in cols):
        raise ValueError("embedded selects are not supported by the test gateway")
    return ", ".join(cols)


@app.api_route("/rest/v1/{table}", methods=["GET", "HEAD", "PATCH", "POST"])
async def table(table: str, request: Request):
    if not IDENT.match(table):
        return JSONResponse({"message": "bad table"}, status_code=400)
    role, uid = caller(request)
    qp = request.query_params
    try:
        where, vals = build_filters(qp)
        if request.method in ("GET", "HEAD"):
            cols = select_list(qp.get("select"))
            order = ""
            if qp.get("order"):
                col, _, direction = qp["order"].partition(".")
                if not IDENT.match(col):
                    raise ValueError("bad order")
                order = f" order by {col} {'desc' if direction.startswith('desc') else 'asc'}"
            limit = f" limit {int(qp['limit'])}" if qp.get("limit") else ""
            rows, _ = run(role, uid, f"select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select {cols} from {table}{where}{order}{limit}) t", vals, fetch="one")
            data = rows[0]
            headers = {"Content-Range": f"0-{max(len(data) - 1, 0)}/{len(data)}"}
            if request.method == "HEAD":
                return Response(status_code=200, headers=headers)
            accept = request.headers.get("accept", "")
            if "vnd.pgrst.object" in accept:
                if len(data) > 1:
                    return JSONResponse({"message": "multiple rows"}, status_code=406)
                return JSONResponse(data[0] if data else None, headers=headers)
            return JSONResponse(data, headers=headers)
        body = await request.json()
        if request.method == "PATCH":
            sets = [f"{k} = %s" for k in body if IDENT.match(k)]
            if not sets:
                raise ValueError("nothing to update")
            setvals = [json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in body.items() if IDENT.match(k)]
            rows, _ = run(role, uid, f"with u as (update {table} set {', '.join(sets)}{where} returning *) select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from u",
                          setvals + vals, fetch="one")
            return JSONResponse(rows[0])
        items = body if isinstance(body, list) else [body]
        out = []
        for it in items:
            cols = [k for k in it if IDENT.match(k)]
            rows, _ = run(role, uid, f"insert into {table} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))}) returning to_jsonb({table}.*)",
                          [json.dumps(it[c]) if isinstance(it[c], (dict, list)) else it[c] for c in cols], fetch="one")
            out.append(rows[0])
        return JSONResponse(out, status_code=201)
    except psycopg.Error as e:
        return pg_error(e)
    except ValueError as e:
        return JSONResponse({"message": str(e)}, status_code=400)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def file_path(bucket: str, name: str) -> Path:
    p = (FILES / bucket / name).resolve()
    if not str(p).startswith(str(FILES.resolve())):
        raise ValueError("bad path")
    return p


@app.post("/storage/v1/object/{bucket}/{name:path}")
async def upload(bucket: str, name: str, request: Request):
    role, uid = caller(request)
    if bucket == "sign":
        return await sign(name.split("/", 1)[0], name.split("/", 1)[1], request)
    ctype = request.headers.get("content-type", "application/octet-stream")
    if ctype.startswith("multipart/form-data"):
        form = await request.form()  # supabase-js sends Blob/File uploads as a form, like real Storage accepts
        part = next((v for v in form.values() if hasattr(v, "read")), None)
        data = await part.read() if part else b""
        ctype = getattr(part, "content_type", None) or "application/octet-stream"
    else:
        data = await request.body()
    try:
        run(role, uid, "insert into storage.objects (bucket_id, name, owner) values (%s, %s, nullif(%s, '')::uuid)", (bucket, name, uid))
    except psycopg.Error as e:
        return JSONResponse({"statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy"}, status_code=400)
    p = file_path(bucket, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    (p.with_suffix(p.suffix + ".ct")).write_text(ctype)
    return {"Key": f"{bucket}/{name}", "Id": str(uuid.uuid4())}


async def sign(bucket: str, name: str, request: Request):
    role, uid = caller(request)
    rows, _ = run(role, uid, "select 1 from storage.objects where bucket_id = %s and name = %s", (bucket, name))
    if not rows:
        return JSONResponse({"statusCode": "404", "error": "not_found", "message": "Object not found"}, status_code=400)
    tok = b64(hmac.new(SECRET, f"{bucket}/{name}".encode(), hashlib.sha256).digest())
    return {"signedURL": f"/object/sign/{bucket}/{name}?token={tok}"}


def serve(bucket: str, name: str) -> Response:
    p = file_path(bucket, name)
    if not p.exists():
        return JSONResponse({"message": "Object not found"}, status_code=404)
    ct = (p.with_suffix(p.suffix + ".ct")).read_text() if p.with_suffix(p.suffix + ".ct").exists() else "application/octet-stream"
    return Response(p.read_bytes(), media_type=ct)


@app.get("/storage/v1/object/sign/{bucket}/{name:path}")
async def signed(bucket: str, name: str, token: str):
    good = b64(hmac.new(SECRET, f"{bucket}/{name}".encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(good, token):
        return JSONResponse({"message": "bad token"}, status_code=400)
    return serve(bucket, name)


@app.get("/storage/v1/object/public/{bucket}/{name:path}")
async def public(bucket: str, name: str):
    rows, _ = run("postgres", "", "select public from storage.buckets where id = %s", (bucket,))
    if not rows or not rows[0][0]:
        return JSONResponse({"message": "not public"}, status_code=400)
    return serve(bucket, name)


@app.get("/storage/v1/object/authenticated/{bucket}/{name:path}")
async def authed(bucket: str, name: str, request: Request):
    role, uid = caller(request)
    if role != "service_role":
        rows, _ = run(role, uid, "select 1 from storage.objects where bucket_id = %s and name = %s", (bucket, name))
        if not rows:
            return JSONResponse({"message": "not found"}, status_code=400)
    return serve(bucket, name)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=54321, log_level="warning")
