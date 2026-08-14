from __future__ import annotations

from collections.abc import Iterable

from ..config import Settings
from ..dependencies import DbSession
from ..models import Score
from ..storage_lifecycle import enqueue_score_deletions


def enqueue_score_cleanup(
    db: DbSession,
    scores: Iterable[Score],
    settings: Settings,
    *,
    reason: str,
) -> None:
    enqueue_score_deletions(db, scores, settings, reason=reason)
