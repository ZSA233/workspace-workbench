from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from typing import Callable, Mapping


@dataclass(frozen=True)
class CachedValue:
    payload: dict[str, object]
    fingerprint: str
    updated_at: float


class BoundedMemoryCache:
    """An LRU cache bounded by both entry count and serialized bytes."""

    def __init__(self, *, max_entries: int = 500, max_bytes: int = 32 * 1024 * 1024) -> None:
        self.max_entries = max(1, max_entries)
        self.max_bytes = max(1024, max_bytes)
        self._items: OrderedDict[str, CachedValue] = OrderedDict()
        self._sizes: dict[str, int] = {}
        self._bytes = 0
        self._lock = threading.RLock()


    @staticmethod
    def _size(value: Mapping[str, object]) -> int:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))

    def get(self, key: str, *, fingerprint: str | None = None) -> CachedValue | None:
        with self._lock:
            value = self._items.get(key)
            if value is None or (fingerprint is not None and value.fingerprint != fingerprint):
                return None
            self._items.move_to_end(key)
            return value

    def latest(self, key: str) -> CachedValue | None:
        with self._lock:
            value = self._items.get(key)
            if value is not None:
                self._items.move_to_end(key)
            return value

    def put(self, key: str, payload: Mapping[str, object], *, fingerprint: str = "", updated_at: float | None = None) -> None:
        value = CachedValue(dict(payload), fingerprint, updated_at if updated_at is not None else time.time())
        size = self._size(value.payload)
        with self._lock:
            old_size = self._sizes.pop(key, 0)
            self._items.pop(key, None)
            self._bytes -= old_size
            if size <= self.max_bytes:
                self._items[key] = value
                self._sizes[key] = size
                self._bytes += size
            while self._items and (len(self._items) > self.max_entries or self._bytes > self.max_bytes):
                evicted_key, _ = self._items.popitem(last=False)
                self._bytes -= self._sizes.pop(evicted_key, 0)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._sizes.clear()
            self._bytes = 0

    def delete(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)
            self._bytes -= self._sizes.pop(key, 0)

    def status(self) -> dict[str, int]:
        with self._lock:
            return {"entries": len(self._items), "bytes": self._bytes, "maxEntries": self.max_entries, "maxBytes": self.max_bytes}


class SQLiteCache:
    """A rebuildable, per-project persistent cache with bounded retention."""

    schema_version = 1

    def __init__(self, path: str | Path | None, *, max_entries: int = 5000) -> None:
        self.path = Path(path).expanduser().resolve() if path else None
        self.max_entries = max(1, max_entries)
        self.available = False
        self.issue: str | None = None
        self._write_lock = threading.RLock()
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
            os.close(descriptor)
            self.path.chmod(0o600)
            self._initialize()
            self.available = True
        except (OSError, sqlite3.Error) as exc:
            self.issue = str(exc)

    def _connect(self) -> sqlite3.Connection:
        if self.path is None:
            raise sqlite3.OperationalError("cache disabled")
        connection = sqlite3.connect(str(self.path), timeout=2.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=2000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS cache_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cache_entries (
                    cache_key TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS cache_entries_updated ON cache_entries(updated_at);
                """
            )
            connection.execute(
                "INSERT INTO cache_meta(key, value) VALUES('schemaVersion', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(self.schema_version),),
            )
            self._prune_connection(connection)
        try:
            self.path.chmod(0o600)  # type: ignore[union-attr]
        except OSError:
            pass

    def _decode(self, row: sqlite3.Row) -> CachedValue | None:
        try:
            value = json.loads(str(row["payload"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        return CachedValue(value, str(row["fingerprint"]), float(row["updated_at"]))

    def get(self, key: str, *, fingerprint: str | None = None) -> CachedValue | None:
        if not self.available:
            return None
        try:
            with self._connect() as connection:
                row = connection.execute(
                    "SELECT cache_key, fingerprint, payload, updated_at FROM cache_entries WHERE cache_key = ?",
                    (key,),
                ).fetchone()
            value = self._decode(row) if row is not None else None
            return value if value is not None and (fingerprint is None or value.fingerprint == fingerprint) else None
        except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
            self.issue = str(exc)
            self.available = False
            return None

    def latest(self, key: str) -> CachedValue | None:
        return self.get(key)

    def delete(self, key: str) -> None:
        if not self.available:
            return
        try:
            with self._connect() as connection:
                connection.execute("DELETE FROM cache_entries WHERE cache_key = ?", (key,))
        except sqlite3.Error as error:
            self.issue = str(error)

    def put(self, key: str, payload: Mapping[str, object], *, fingerprint: str = "", updated_at: float | None = None) -> None:
        if not self.available:
            return
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str, sort_keys=True)
        try:
            with self._write_lock, self._connect() as connection:
                connection.execute(
                    "INSERT INTO cache_entries(cache_key, fingerprint, payload, updated_at) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(cache_key) DO UPDATE SET fingerprint=excluded.fingerprint, "
                    "payload=excluded.payload, updated_at=excluded.updated_at",
                    (key, fingerprint, encoded, updated_at if updated_at is not None else time.time()),
                )
                self._prune_connection(connection)
        except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
            self.issue = str(exc)
            self.available = False

    def _prune_connection(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            "DELETE FROM cache_entries WHERE cache_key IN ("
            "SELECT cache_key FROM cache_entries ORDER BY updated_at DESC LIMIT -1 OFFSET ?)",
            (self.max_entries,),
        )

    def status(self) -> dict[str, object]:
        result: dict[str, object] = {
            "enabled": self.path is not None,
            "available": self.available,
            "schemaVersion": self.schema_version,
            "maxEntries": self.max_entries,
        }
        if self.path is not None:
            result["path"] = str(self.path)
            try:
                result["mode"] = oct(self.path.stat().st_mode & 0o777)
                result["bytes"] = self.path.stat().st_size
            except OSError:
                result["mode"] = None
        if self.issue:
            result["issue"] = self.issue
            result["code"] = "index_degraded"
        return result

    def close(self) -> None:
        return


class ObservationCache:
    """L1/L2 stale-while-revalidate cache with request single-flight."""

    def __init__(self, *, sqlite_path: Path | None, max_entries: int, max_bytes: int, sqlite_max_entries: int, ttl_seconds: float = 3.0) -> None:
        self.memory = BoundedMemoryCache(max_entries=max_entries, max_bytes=max_bytes)
        self.sqlite = SQLiteCache(sqlite_path, max_entries=sqlite_max_entries)
        self.ttl_seconds = max(0.5, ttl_seconds)
        self._refreshing: set[str] = set()
        self._locks = tuple(threading.Lock() for _ in range(128))
        self._lock = threading.RLock()
        self._executors = {name: ThreadPoolExecutor(max_workers=count, thread_name_prefix=f"cache-{name}") for name, count in {"list": 1, "browse": 2, "review": 1}.items()}
        self._permits = {name: threading.BoundedSemaphore(16) for name in self._executors}
        self._failures: OrderedDict[str, str] = OrderedDict()
        self._closed = False

    def _key_lock(self, key: str) -> threading.Lock:
        return self._locks[hash(key) % len(self._locks)]

    @staticmethod
    def _with_metadata(value: CachedValue, *, state: str, refreshing: bool = False) -> dict[str, object]:
        payload = dict(value.payload)
        observation = dict(payload.get("observation") or {})
        observation.update({
            "cacheState": state,
            "cacheAgeMs": max(0, round((time.time() - value.updated_at) * 1000)),
            "refreshing": refreshing,
            "lastSuccessfulAt": observation.get("lastSuccessfulAt") or (observation.get("observedAt") if observation.get("state", "ready") == "ready" else None),
        })
        payload["observation"] = observation
        return payload

    def read(self, key: str, fingerprint: str, producer: Callable[[], Mapping[str, object]], *, cold_fallback: Callable[[], Mapping[str, object]] | None = None) -> dict[str, object]:
        memory = self.memory.get(key, fingerprint=fingerprint)
        if memory is not None and time.time() - memory.updated_at <= self.ttl_seconds:
            return self._with_metadata(memory, state="fresh")
        persistent = self.sqlite.get(key, fingerprint=fingerprint)
        if persistent is not None and time.time() - persistent.updated_at <= self.ttl_seconds:
            self.memory.put(key, persistent.payload, fingerprint=persistent.fingerprint, updated_at=persistent.updated_at)
            return self._with_metadata(persistent, state="fresh")
        latest = self.memory.latest(key) or self.sqlite.latest(key)
        if latest is not None:
            self._schedule_refresh(key, fingerprint, producer)
            return self._with_metadata(latest, state="refreshing", refreshing=True)
        if cold_fallback is not None:
            self._schedule_refresh(key, fingerprint, producer)
            return dict(cold_fallback())
        with self._key_lock(key):
            memory = self.memory.get(key, fingerprint=fingerprint)
            if memory is not None and time.time() - memory.updated_at <= self.ttl_seconds:
                return self._with_metadata(memory, state="fresh")
            value = dict(producer())
            now = time.time()
            self._store(key, value, fingerprint, now)
            return self._with_metadata(CachedValue(value, fingerprint, now), state="fresh")

    def _store(self, key: str, value: dict[str, object], fingerprint: str, now: float) -> None:
        observation = value.get("observation") or {}
        if isinstance(observation, Mapping) and observation.get("state", "ready") != "ready":
            with self._lock:
                self._failures[key] = str(observation.get("state"))
                while len(self._failures) > 256:
                    self._failures.popitem(last=False)
            previous = self.memory.latest(key) or self.sqlite.latest(key)
            if previous and observation.get("state") == "partial":
                merged = dict(value)
                for field, identity in (("repositories", "repoPath"), ("workspaces", "id")):
                    if not isinstance(value.get(field), list):
                        continue
                    old = {item.get(identity): item for item in previous.payload.get(field, [])}
                    rows = []
                    for item in value[field]:
                        issues = [*item.get("issues", []), *item.get("changeIssues", [])]
                        transient = any(issue.get("code") in {"git_timeout", "observation_timeout", "observer_busy"} for issue in issues)
                        rows.append({**old[item.get(identity)], "observationStale": True} if transient and item.get(identity) in old else item)
                    merged[field] = rows
                merged["observation"] = {**observation, "lastSuccessfulAt": (previous.payload.get("observation") or {}).get("observedAt")}
                self.memory.put(key, merged, fingerprint=fingerprint, updated_at=previous.updated_at)
            elif not previous and observation.get("state") == "partial":
                # Retain partial observations in L1 only; never claim a success
                # timestamp or persist them as the last successful snapshot.
                self.memory.put(key, value, fingerprint=fingerprint, updated_at=0)
            return
        self.memory.put(key, value, fingerprint=fingerprint, updated_at=now)
        self.sqlite.put(key, value, fingerprint=fingerprint, updated_at=now)
        with self._lock:
            self._failures.pop(key, None)

    def _schedule_refresh(self, key: str, fingerprint: str, producer: Callable[[], Mapping[str, object]]) -> None:
        with self._lock:
            channel = "list" if "workspace.list" in key else "review" if "review-set" in key else "browse"
            if self._closed or key in self._refreshing or not self._permits[channel].acquire(blocking=False):
                return
            self._refreshing.add(key)

        def refresh() -> None:
            try:
                value = dict(producer())
                now = time.time()
                self._store(key, value, fingerprint, now)
            except Exception as error:
                if getattr(error, "code", "") in {"file_not_changed", "path_invalid", "worktree_missing", "commit_missing", "base_missing"}:
                    self.memory.delete(key)
                    self.sqlite.delete(key)
                with self._lock:
                    self._failures[key] = str(getattr(error, "code", "refresh_failed"))
                    while len(self._failures) > 256:
                        self._failures.popitem(last=False)
            finally:
                with self._lock:
                    self._refreshing.discard(key)
                self._permits[channel].release()

        self._executors[channel].submit(refresh)

    def status(self) -> dict[str, object]:
        with self._lock:
            refreshing = len(self._refreshing)
            lock_count = len(self._locks)
        return {"memory": self.memory.status(), "sqlite": self.sqlite.status(), "refreshing": refreshing, "failedRefreshes": len(self._failures), "issueCodes": sorted(set(self._failures.values())), "keyLocks": lock_count, "ttlSeconds": self.ttl_seconds}

    def close(self) -> None:
        with self._lock:
            self._closed = True
        for executor in self._executors.values():
            executor.shutdown(wait=True)
        self.memory.clear()
        self.sqlite.close()
