from __future__ import annotations

from typing import Any


class TeidealError(Exception):
    """A Teideal delivery or API error."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class TeidealValidationError(TeidealError, ValueError):
    """An event that fails the local usage-event contract."""

