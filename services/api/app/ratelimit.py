"""In-memory sliding-window limiter. One process on the free tier, so memory is enough."""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException

_hits: dict[str, deque] = defaultdict(deque)


def limit(key: str, max_calls: int, per_seconds: float) -> None:
    now = time.monotonic()
    q = _hits[key]
    while q and q[0] <= now - per_seconds:
        q.popleft()
    if len(q) >= max_calls:
        raise HTTPException(429, "Too many requests, wait a moment and try again")
    q.append(now)
