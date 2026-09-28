from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest

from teideal import TeidealClient, TeidealError, TeidealValidationError

CUSTOMER_ID = "00000000-0000-4000-8000-000000000001"


class CapturingLogger:
    def __init__(self) -> None:
        self.records: list[tuple[str, str]] = []

    def debug(self, message: object, *args: object, **_kwargs: object) -> None:
        self.records.append(("debug", str(message) % args if args else str(message)))

    def info(self, message: object, *args: object, **_kwargs: object) -> None:
        self.records.append(("info", str(message) % args if args else str(message)))

    def warning(self, message: object, *args: object, **_kwargs: object) -> None:
        self.records.append(("warning", str(message) % args if args else str(message)))

    def error(self, message: object, *args: object, **_kwargs: object) -> None:
        self.records.append(("error", str(message) % args if args else str(message)))


class ScriptedClient(TeidealClient):
    responses: list[tuple[int, Any] | Exception] = []
    requests: list[dict[str, Any]] = []

    def _post_usage(self, payload: dict[str, Any]) -> tuple[int, Any]:
        self.requests.append(dict(payload))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def client(
    path: Path,
    responses: list[tuple[int, Any] | Exception],
    logger: CapturingLogger | None = None,
) -> ScriptedClient:
    ScriptedClient.responses = responses
    ScriptedClient.requests = []
    instance = ScriptedClient(
        "http://unused",
        "key",
        logger=logger,
        buffer_path=path,
        retry_backoffs=(0, 0),
        flush_interval=3600,
    )
    return instance


def success(payload_id: str = "event-1") -> tuple[int, dict[str, Any]]:
    return 201, {
        "id": payload_id,
        "customer_id": CUSTOMER_ID,
        "event_type": "api.call",
        "quantity": 1,
        "idempotency_key": "server-echo",
        "occurred_at": "2026-09-28T00:00:00Z",
    }


def test_teid_59_t2_retries_three_times_with_one_idempotency_key(tmp_path: Path) -> None:
    logger = CapturingLogger()
    sdk = client(tmp_path / "buffer.db", [(500, {"error": "down"}), (500, {"error": "down"}), success()[0:2]], logger)
    result = sdk.send_event(CUSTOMER_ID, "api.call", 1)

    assert result.id == "event-1"
    assert len(sdk.requests) == 3
    assert len({request["idempotency_key"] for request in sdk.requests}) == 1
    assert any(level == "warning" and "retry attempt" in message for level, message in logger.records)
    sdk.close()


def test_best_effort_never_blocks_existing_billing_call_and_logs(tmp_path: Path) -> None:
    logger = CapturingLogger()
    sdk = client(tmp_path / "buffer.db", [(500, {}), (500, {}), (500, {})], logger)
    billing_calls: list[str] = []

    sdk.send_event_best_effort(CUSTOMER_ID, "api.call", 1)
    billing_calls.append("succeeded")

    assert billing_calls == ["succeeded"]
    sdk.close()
    assert any(level == "error" and "best-effort" in message for level, message in logger.records)


@pytest.mark.parametrize(
    ("customer_id", "event_type"),
    [("not-a-uuid", "api.call"), (CUSTOMER_ID, "")],
)
def test_teid_59_t9_validation_never_transmits_or_buffers(
    tmp_path: Path, customer_id: str, event_type: str
) -> None:
    buffer_path = tmp_path / "buffer.db"
    sdk = client(buffer_path, [])
    with pytest.raises(TeidealValidationError):
        sdk.send_event(customer_id, event_type, 1)
    assert sdk.requests == []
    with sqlite3.connect(buffer_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
    sdk.close()


def test_pending_event_survives_restart_and_flushes_with_same_key(tmp_path: Path) -> None:
    buffer_path = tmp_path / "buffer.db"
    first = client(buffer_path, [TeidealError("offline"), TeidealError("offline"), TeidealError("offline")])
    with pytest.raises(TeidealError):
        first.send_event(CUSTOMER_ID, "api.call", 1)
    original_key = first.requests[0]["idempotency_key"]
    first.close()

    second = client(buffer_path, [(200, {"status": "duplicate", "id": "event-1", "idempotency_key": original_key})])
    deadline = time.monotonic() + 2
    while second._buffer.has_pending() and time.monotonic() < deadline:
        second.flush()
        time.sleep(0.01)
    assert not second._buffer.has_pending()
    assert second.requests[0]["idempotency_key"] == original_key
    second.close()


def test_teid_59_t7_logs_retry_and_buffer_flush_activity(tmp_path: Path) -> None:
    logger = CapturingLogger()
    buffer_path = tmp_path / "buffer.db"
    first = client(buffer_path, [TeidealError("offline"), TeidealError("offline"), TeidealError("offline")], logger)
    first.send_event_best_effort(CUSTOMER_ID, "api.call", 1)
    first.close()

    second = client(buffer_path, [success()], logger)
    second.flush()
    assert any("retry attempt" in message for _, message in logger.records)
    assert any("buffer flush" in message for _, message in logger.records)
    second.close()


def test_teid_59_t4_best_effort_flushes_automatically_after_recovery(tmp_path: Path) -> None:
    logger = CapturingLogger()
    sdk = client(
        tmp_path / "buffer.db",
        [TeidealError("offline"), TeidealError("offline"), TeidealError("offline"), success()],
        logger,
    )
    sdk.flush_interval = 0.01
    sdk.send_event_best_effort(CUSTOMER_ID, "api.call", 1)

    deadline = time.monotonic() + 2
    while sdk._buffer.has_pending() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not sdk._buffer.has_pending()
    assert len({request["idempotency_key"] for request in sdk.requests}) == 1
    sdk.close()
