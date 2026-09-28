from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol, Sequence

from ._buffer import BufferedEvent, SQLiteBuffer
from ._validation import validate_event
from .errors import TeidealError

DEFAULT_BUFFER_PATH = Path.home() / ".teideal" / "buffer.db"
DEFAULT_RETRY_BACKOFFS: tuple[float, float] = (0.1, 0.3)
DEFAULT_FLUSH_INTERVAL = 30.0
DEFAULT_REQUEST_TIMEOUT = 5.0


class Logger(Protocol):
    def debug(self, msg: object, *args: object, **kwargs: object) -> None: ...
    def info(self, msg: object, *args: object, **kwargs: object) -> None: ...
    def warning(self, msg: object, *args: object, **kwargs: object) -> None: ...
    def error(self, msg: object, *args: object, **kwargs: object) -> None: ...


@dataclass(frozen=True)
class SendResult:
    id: str
    customer_id: str | None
    event_type: str | None
    quantity: int | float | None
    idempotency_key: str
    occurred_at: str | None
    duplicate: bool


@dataclass(frozen=True)
class FlushResult:
    attempted: int
    sent: int
    failed: int


class TeidealClient:
    """Durable synchronous client for Teideal's single-event usage API."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        logger: Logger | None = None,
        buffer_path: str | Path | None = None,
        *,
        retry_backoffs: Sequence[float] = DEFAULT_RETRY_BACKOFFS,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.logger = logger or logging.getLogger("teideal")
        self.retry_backoffs = tuple(retry_backoffs)
        if len(self.retry_backoffs) != 2:
            raise ValueError("retry_backoffs must contain exactly two delays")
        self.flush_interval = flush_interval
        self.request_timeout = request_timeout
        self._buffer = SQLiteBuffer(buffer_path or DEFAULT_BUFFER_PATH)
        self._flush_lock = threading.Lock()
        self._timer_lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._background_lock = threading.Lock()
        self._background_threads: set[threading.Thread] = set()
        self._closed = False
        if self._buffer.has_pending():
            self._schedule_flush(0.0)

    def send_event(
        self,
        customer_id: str,
        event_type: str,
        quantity: int | float,
        occurred_at: datetime | str | None = None,
    ) -> SendResult:
        idempotency_key, payload = self._prepare_event(
            customer_id, event_type, quantity, occurred_at
        )
        return self._send_persisted(idempotency_key, payload)

    def send_event_best_effort(
        self,
        customer_id: str,
        event_type: str,
        quantity: int | float,
        occurred_at: datetime | str | None = None,
    ) -> None:
        try:
            idempotency_key, payload = self._prepare_event(
                customer_id, event_type, quantity, occurred_at
            )
            thread = threading.Thread(
                target=self._run_best_effort,
                args=(idempotency_key, payload),
                daemon=True,
            )
            with self._background_lock:
                self._background_threads.add(thread)
            try:
                thread.start()
            except Exception:
                with self._background_lock:
                    self._background_threads.discard(thread)
                raise
        except Exception as exc:
            self.logger.error("Teideal best-effort queue failed: %s", exc)

    def _prepare_event(
        self,
        customer_id: str,
        event_type: str,
        quantity: int | float,
        occurred_at: datetime | str | None,
    ) -> tuple[str, dict[str, Any]]:
        validate_event(customer_id, event_type, quantity)
        idempotency_key = str(uuid.uuid4())
        payload: dict[str, Any] = {
            "customer_id": customer_id,
            "event_type": event_type,
            "quantity": quantity,
            "idempotency_key": idempotency_key,
        }
        if occurred_at is not None:
            payload["occurred_at"] = occurred_at.isoformat() if isinstance(occurred_at, datetime) else occurred_at

        self._buffer.persist(idempotency_key, payload)
        return idempotency_key, payload

    def _send_persisted(
        self, idempotency_key: str, payload: dict[str, Any]
    ) -> SendResult:
        try:
            result = self._deliver(idempotency_key, payload)
        except TeidealError:
            if self._buffer.has_pending():
                self._schedule_flush(self.flush_interval)
            raise
        self._buffer.mark_sent(idempotency_key)
        return result

    def _run_best_effort(
        self, idempotency_key: str, payload: dict[str, Any]
    ) -> None:
        try:
            self._send_persisted(idempotency_key, payload)
        except Exception as exc:
            self.logger.error("Teideal best-effort send failed: %s", exc)
        finally:
            current = threading.current_thread()
            with self._background_lock:
                self._background_threads.discard(current)

    def flush(self) -> FlushResult:
        if not self._flush_lock.acquire(blocking=False):
            return FlushResult(attempted=0, sent=0, failed=0)
        attempted = sent = failed = 0
        try:
            pending = self._buffer.pending()
            if pending:
                self.logger.info("Teideal buffer flush started: %d pending", len(pending))
            for event in pending:
                attempted += 1
                try:
                    self._deliver_buffered(event)
                    sent += 1
                    self.logger.info("Teideal buffer flush sent event %s", event.idempotency_key)
                except TeidealError as exc:
                    failed += 1
                    self.logger.error("Teideal buffer flush retained event %s: %s", event.idempotency_key, exc)
            return FlushResult(attempted=attempted, sent=sent, failed=failed)
        finally:
            self._flush_lock.release()
            if not self._closed and self._buffer.has_pending():
                self._schedule_flush(self.flush_interval)

    def close(self) -> None:
        self._closed = True
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        with self._background_lock:
            background = list(self._background_threads)
        for thread in background:
            thread.join()
        with self._flush_lock:
            self._buffer.close()

    def __enter__(self) -> TeidealClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def _deliver_buffered(self, event: BufferedEvent) -> SendResult:
        try:
            result = self._deliver(event.idempotency_key, event.payload)
        except TeidealError as exc:
            if exc.status_code in (400, 403, 409):
                self._buffer.mark_sent(event.idempotency_key)
            raise
        self._buffer.mark_sent(event.idempotency_key)
        return result

    def _deliver(self, idempotency_key: str, payload: dict[str, Any]) -> SendResult:
        last_error: TeidealError | None = None
        for attempt in range(1, 4):
            self._buffer.increment_attempts(idempotency_key)
            try:
                status, body = self._post_usage(payload)
                if status in (200, 201):
                    return self._to_result(body, payload, status == 200)
                error = self._response_error(status, body)
                if status < 500:
                    self._buffer.mark_sent(idempotency_key)
                    raise error
                last_error = error
            except TeidealError as exc:
                if exc.status_code is not None and exc.status_code < 500:
                    raise
                last_error = exc

            if attempt < 3:
                delay = self.retry_backoffs[attempt - 1]
                self.logger.warning(
                    "Teideal send retry attempt %d/3 for %s after error: %s",
                    attempt + 1,
                    idempotency_key,
                    last_error,
                )
                if delay > 0:
                    time.sleep(delay)

        assert last_error is not None
        raise last_error

    def _post_usage(self, payload: dict[str, Any]) -> tuple[int, Any]:
        request = urllib.request.Request(
            f"{self.base_url}/usage",
            data=json.dumps(payload, separators=(",", ":"), allow_nan=False).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.request_timeout) as response:
                raw = response.read().decode()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                body: Any = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                body = raw
            return exc.code, body
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise TeidealError(f"network error: {exc}") from exc

    @staticmethod
    def _response_error(status: int, body: Any) -> TeidealError:
        message = body.get("error") if isinstance(body, dict) else None
        return TeidealError(message or f"Teideal returned HTTP {status}", status_code=status, response=body)

    @staticmethod
    def _to_result(body: Any, payload: dict[str, Any], duplicate: bool) -> SendResult:
        if not isinstance(body, dict) or not isinstance(body.get("id"), str):
            raise TeidealError(
                "Teideal returned an invalid success response", status_code=200
            )
        return SendResult(
            id=body["id"], customer_id=body.get("customer_id"), event_type=body.get("event_type"),
            quantity=body.get("quantity"), idempotency_key=body.get("idempotency_key", payload["idempotency_key"]),
            occurred_at=body.get("occurred_at"), duplicate=duplicate,
        )

    def _schedule_flush(self, delay: float) -> None:
        if self._closed:
            return
        with self._timer_lock:
            if self._timer is not None and self._timer.is_alive():
                return
            timer = threading.Timer(delay, self._run_scheduled_flush)
            timer.daemon = True
            self._timer = timer
            timer.start()

    def _run_scheduled_flush(self) -> None:
        with self._timer_lock:
            self._timer = None
        if not self._closed:
            self.flush()
