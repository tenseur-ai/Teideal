from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class BufferedEvent:
    idempotency_key: str
    payload: dict[str, Any]
    attempts: int
    created_at: str


class SQLiteBuffer:
    """Transactional, process-persistent storage for pending events."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            self.path, timeout=30, check_same_thread=False
        )
        self._connection.execute("PRAGMA journal_mode=WAL")
        # WAL + NORMAL is durable across the process-kill failure model in T8
        # without adding two fsyncs to every successful send's hot path.
        self._connection.execute("PRAGMA synchronous=NORMAL")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                idempotency_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                attempts INT NOT NULL,
                created_at TEXT NOT NULL,
                sent_at TEXT NULL
            )
            """
        )
        self._connection.commit()
        self.vacuum_sent()

    def persist(self, idempotency_key: str, payload: dict[str, Any]) -> None:
        created_at = datetime.now(timezone.utc).isoformat()
        serialized = json.dumps(payload, separators=(",", ":"), allow_nan=False)
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO events
                    (idempotency_key, payload, attempts, created_at, sent_at)
                VALUES (?, ?, 0, ?, NULL)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                (idempotency_key, serialized, created_at),
            )

    def pending(self) -> list[BufferedEvent]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT idempotency_key, payload, attempts, created_at
                FROM events
                WHERE sent_at IS NULL
                ORDER BY created_at ASC, rowid ASC
                """
            ).fetchall()
        return [
            BufferedEvent(
                idempotency_key=row[0],
                payload=json.loads(row[1]),
                attempts=row[2],
                created_at=row[3],
            )
            for row in rows
        ]

    def increment_attempts(self, idempotency_key: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE events SET attempts = attempts + 1 WHERE idempotency_key = ?",
                (idempotency_key,),
            )

    def mark_sent(self, idempotency_key: str) -> None:
        sent_at = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE events SET sent_at = ? WHERE idempotency_key = ?",
                (sent_at, idempotency_key),
            )

    def has_pending(self) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT EXISTS(SELECT 1 FROM events WHERE sent_at IS NULL)"
            ).fetchone()
        return bool(row and row[0])

    def vacuum_sent(self, retention: timedelta = timedelta(hours=24)) -> None:
        cutoff = (datetime.now(timezone.utc) - retention).isoformat()
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM events WHERE sent_at IS NOT NULL AND sent_at < ?", (cutoff,)
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()
