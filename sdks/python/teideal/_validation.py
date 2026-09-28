from __future__ import annotations

import math
import re
import uuid
from numbers import Real

from .errors import TeidealValidationError

EVENT_TYPE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
MAX_QUANTITY = 1_000_000_000_000


def validate_event(customer_id: str, event_type: str, quantity: int | float) -> None:
    try:
        uuid.UUID(customer_id)
    except (ValueError, AttributeError, TypeError) as exc:
        raise TeidealValidationError("customer_id must be a UUID") from exc

    if not isinstance(event_type, str) or EVENT_TYPE_RE.fullmatch(event_type) is None:
        raise TeidealValidationError(
            "event_type must match ^[A-Za-z0-9_.:-]{1,128}$"
        )

    if isinstance(quantity, bool) or not isinstance(quantity, Real):
        raise TeidealValidationError("quantity must be a finite number")
    if isinstance(quantity, float) and not math.isfinite(quantity):
        raise TeidealValidationError("quantity must be a finite number")
    if quantity < 0:
        raise TeidealValidationError("quantity must be a non-negative number")
    if quantity > MAX_QUANTITY:
        raise TeidealValidationError(
            "quantity must not exceed 1000000000000 (one trillion)"
        )
