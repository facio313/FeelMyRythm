from __future__ import annotations

import re
import secrets
import string
from typing import Literal

JOIN_CODE_ALPHABET = string.ascii_uppercase + string.digits
JOIN_CODE_LENGTH = 6
JOIN_CODE_PATTERN = re.compile(rf"^[{JOIN_CODE_ALPHABET}]{{{JOIN_CODE_LENGTH}}}$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

RoomRefKind = Literal["uuid", "join_code"]


def generate_join_code() -> str:
    return "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(JOIN_CODE_LENGTH))


def parse_room_ref(value: str) -> tuple[RoomRefKind, str] | None:
    token = value.strip()
    if UUID_PATTERN.fullmatch(token):
        return ("uuid", token.lower())
    compact = token.replace(" ", "").replace("-", "").upper()
    if JOIN_CODE_PATTERN.fullmatch(compact):
        return ("join_code", compact)
    return None
