"""
Thin Supabase REST client.

Two ways of talking to the database:
  * as_user(token)  -> requests carry the signed-in user's JWT, so Row Level Security
                       and every permission check inside the RPCs apply exactly as in the app.
  * service()       -> requests carry the service-role key. Used only after a user-scoped
                       call has already proven the caller may act, and for cron/demo reset.
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import get_settings

TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class SupabaseError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Supa:
    def __init__(self, apikey: str, bearer: str | None, client: httpx.AsyncClient | None = None):
        self.base = get_settings().supabase_url.rstrip("/")
        self.headers = {"apikey": apikey, "Content-Type": "application/json"}
        if bearer:
            self.headers["Authorization"] = f"Bearer {bearer}"
        self.client = client or httpx.AsyncClient(timeout=TIMEOUT)

    async def _check(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            try:
                body = r.json()
                msg = body.get("message") or body.get("msg") or body.get("error_description") or str(body)
            except ValueError:
                msg = r.text[:300]
            raise SupabaseError(r.status_code, msg)
        if not r.content:
            return None
        return r.json()

    async def rpc(self, fn: str, args: dict | None = None) -> Any:
        r = await self.client.post(f"{self.base}/rest/v1/rpc/{fn}", json=args or {}, headers=self.headers)
        return await self._check(r)

    async def select(self, table: str, params: dict[str, str]) -> list[dict]:
        r = await self.client.get(f"{self.base}/rest/v1/{table}", params=params, headers=self.headers)
        return await self._check(r)

    async def update(self, table: str, match: dict[str, str], values: dict) -> list[dict]:
        params = {k: f"eq.{v}" for k, v in match.items()}
        r = await self.client.patch(f"{self.base}/rest/v1/{table}", params=params, json=values,
                                    headers={**self.headers, "Prefer": "return=representation"})
        return await self._check(r)

    async def download(self, bucket: str, path: str, max_bytes: int = 8 * 1024 * 1024) -> tuple[bytes, str]:
        r = await self.client.get(f"{self.base}/storage/v1/object/authenticated/{bucket}/{path}", headers=self.headers)
        if r.status_code >= 400:
            await self._check(r)  # raises with the storage error message
        if len(r.content) > max_bytes:
            raise SupabaseError(413, "File too large")
        return r.content, r.headers.get("content-type", "application/octet-stream").split(";")[0]

    async def get_user(self) -> dict:
        r = await self.client.get(f"{self.base}/auth/v1/user", headers=self.headers)
        return await self._check(r)


def as_user(token: str, client: httpx.AsyncClient | None = None) -> Supa:
    """Requests as the signed-in user: the public key plus their own token, so RLS applies."""
    return Supa(get_settings().supabase_anon_key, token, client)


def service(client: httpx.AsyncClient | None = None) -> Supa:
    """Requests with the service-role key. Only after a user-scoped call proved the caller may act."""
    key = get_settings().supabase_service_role_key
    # New-style secret keys (sb_secret_...) go only in the apikey header; classic service-role JWTs also as the bearer
    return Supa(key, None if key.startswith("sb_") else key, client)
