"""Verifies the caller's Supabase access token by asking Supabase Auth who it belongs to."""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from fastapi import Header, HTTPException, Request

from .supa import SupabaseError, as_user

_CACHE: dict[str, tuple[float, str]] = {}
_TTL = 60.0


@dataclass
class Caller:
    id: str
    token: str


async def current_user(request: Request, authorization: str = Header(default="")) -> Caller:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in first")
    token = authorization[7:].strip()
    if not token or len(token) > 4096:
        raise HTTPException(401, "Sign in first")

    # Cache by a hash of the token, never the token itself
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _CACHE.get(key)
    if hit and hit[0] > time.monotonic():
        return Caller(id=hit[1], token=token)

    try:
        user = await as_user(token, request.app.state.http).get_user()
    except SupabaseError:
        raise HTTPException(401, "Session expired, sign in again")
    uid = user.get("id")
    if not uid:
        raise HTTPException(401, "Sign in first")
    if len(_CACHE) > 5000:
        _CACHE.clear()
    _CACHE[key] = (time.monotonic() + _TTL, uid)
    return Caller(id=uid, token=token)
