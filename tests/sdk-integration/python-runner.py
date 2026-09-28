from __future__ import annotations

import json
import os
import sqlite3
import statistics
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from teideal import TeidealClient, TeidealError


def emit(value: object) -> None:
    print(json.dumps(value), flush=True)


def keys_in(path: Path) -> list[str]:
    with sqlite3.connect(path) as connection:
        return [row[0] for row in connection.execute("SELECT idempotency_key FROM events WHERE sent_at IS NULL ORDER BY created_at")]


def send() -> None:
    client = TeidealClient(
        sys.argv[2], sys.argv[3], buffer_path=sys.argv[5],
        retry_backoffs=(0, 0), flush_interval=3600, request_timeout=2,
    )
    result = client.send_event(sys.argv[4], "sdk.python", 1)
    emit({"id": result.id, "idempotencyKey": result.idempotency_key})
    client.close()


class CaptureLogger:
    def __init__(self) -> None:
        self.errors = 0

    def debug(self, *_args: object, **_kwargs: object) -> None: pass
    def info(self, *_args: object, **_kwargs: object) -> None: pass
    def warning(self, *_args: object, **_kwargs: object) -> None: pass
    def error(self, *_args: object, **_kwargs: object) -> None: self.errors += 1


def best_effort() -> None:
    logger = CaptureLogger()
    client = TeidealClient(
        sys.argv[2], sys.argv[3], logger=logger, buffer_path=sys.argv[5],
        retry_backoffs=(0, 0), flush_interval=3600, request_timeout=1,
    )
    client.send_event_best_effort(sys.argv[4], "sdk.python.best_effort", 1)
    client.close()
    emit({"errors": logger.errors})


def auto_recover() -> None:
    offline_url, online_url, api_key, customer_id, raw_path = sys.argv[2:7]
    path = Path(raw_path)
    client = TeidealClient(
        offline_url, api_key, buffer_path=path,
        retry_backoffs=(0, 0), flush_interval=0.05, request_timeout=0.05,
    )
    duration = int(os.getenv("SDK_OFFLINE_TEST_DURATION_MS", "600000")) / 1000
    deadline = time.monotonic() + duration
    sent = 0
    while time.monotonic() < deadline or sent == 0:
        client.send_event_best_effort(customer_id, f"sdk.python.offline.{sent}", 1)
        sent += 1
    pending_keys = keys_in(path)
    client.base_url = online_url.rstrip("/")
    deadline = time.monotonic() + 10
    while client._buffer.has_pending() and time.monotonic() < deadline:
        time.sleep(0.02)
    emit({"keys": pending_keys, "remaining": client._buffer.has_pending()})
    client.close()


def flush_existing() -> None:
    base_url, api_key, raw_path = sys.argv[2:5]
    client = TeidealClient(base_url, api_key, buffer_path=raw_path, retry_backoffs=(0, 0), flush_interval=3600)
    result = client.flush()
    emit({"attempted": result.attempted, "sent": result.sent, "failed": result.failed})
    client.close()


def crash_mid_flush() -> None:
    base_url, api_key, customer_id, raw_path = sys.argv[2:6]
    client = TeidealClient(
        base_url, api_key, buffer_path=raw_path,
        retry_backoffs=(0, 0), flush_interval=3600, request_timeout=60,
    )
    for index in range(3):
        threading.Thread(
            target=send_until_killed,
            args=(client, customer_id, index),
            daemon=True,
        ).start()
    while True:
        time.sleep(1)


def send_until_killed(client: TeidealClient, customer_id: str, index: int) -> None:
    try:
        client.send_event(customer_id, f"sdk.python.crash.{index}", 1)
    except TeidealError:
        pass


def benchmark() -> None:
    base_url, api_key, customer_id, raw_path = sys.argv[2:6]
    count = int(os.getenv("SDK_LATENCY_BENCHMARK_EVENTS_PER_MIN", "10000"))
    client = TeidealClient(base_url, api_key, buffer_path=raw_path, retry_backoffs=(0, 0), flush_interval=3600)
    raw_latencies: list[float] = []
    sdk_latencies: list[float] = []
    for index in range(count):
        payload: dict[str, Any] = {
            "customer_id": customer_id, "event_type": "sdk.python.raw",
            "quantity": 1, "idempotency_key": str(uuid.uuid4()),
        }
        request = urllib.request.Request(
            f"{base_url}/usage", data=json.dumps(payload).encode(), method="POST",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()
        raw_latencies.append((time.perf_counter() - started) * 1000)
        started = time.perf_counter()
        client.send_event(customer_id, "sdk.python.benchmark", 1)
        sdk_latencies.append((time.perf_counter() - started) * 1000)
    raw_ordered = sorted(raw_latencies)
    sdk_ordered = sorted(sdk_latencies)
    percentile_index = min(count - 1, max(0, int(count * 0.99) - 1))
    mean = max(0, statistics.mean(sdk_latencies) - statistics.mean(raw_latencies))
    p99 = max(0, sdk_ordered[percentile_index] - raw_ordered[percentile_index])
    emit({"mean": mean, "p99": p99, "count": count})
    client.close()


COMMANDS = {
    "send": send,
    "best-effort": best_effort,
    "auto-recover": auto_recover,
    "flush": flush_existing,
    "crash": crash_mid_flush,
    "benchmark": benchmark,
}

COMMANDS[sys.argv[1]]()
