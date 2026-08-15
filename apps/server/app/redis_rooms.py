from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import redis
import redis.asyncio as async_redis

from .config import Settings

logger = logging.getLogger(__name__)

RoomEventHandler = Callable[[dict[str, Any]], Awaitable[None]]


class RoomLockTimeoutError(TimeoutError):
    pass


class RedisRoomBackend:
    _RELEASE_LOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""
    _REGISTER_PARTICIPANT_SCRIPT = """
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return previous
"""
    _UPDATE_PARTICIPANT_SCRIPT = """
local previous = redis.call('GET', KEYS[1])
if not previous then
  return 0
end
local decoded = cjson.decode(previous)
if decoded['connectionId'] ~= ARGV[1] then
  return -1
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
"""
    _REMOVE_PARTICIPANT_SCRIPT = """
local previous = redis.call('GET', KEYS[1])
if not previous then
  redis.call('SREM', KEYS[2], ARGV[2])
  return 0
end
local decoded = cjson.decode(previous)
if decoded['connectionId'] ~= ARGV[1] then
  return -1
end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
"""

    def __init__(self, settings: Settings, handler: RoomEventHandler) -> None:
        if settings.redis_url is None:
            raise ValueError("redis_url is required")
        self.settings = settings
        self.handler = handler
        self.instance_id = str(uuid.uuid4())
        self.prefix = settings.redis_key_prefix.strip(":")
        self.sync: Any = redis.Redis.from_url(settings.redis_url, decode_responses=True)
        self.async_client: Any = async_redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
        )
        self._subscriber_task: asyncio.Task[None] | None = None
        self._subscriber_ready = asyncio.Event()
        self._stopping = False

    async def start(self) -> None:
        await self.async_client.ping()
        self._stopping = False
        self._subscriber_ready.clear()
        self._subscriber_task = asyncio.create_task(self._subscriber_loop())
        await asyncio.wait_for(self._subscriber_ready.wait(), timeout=5)

    async def stop(self) -> None:
        self._stopping = True
        if self._subscriber_task is not None:
            self._subscriber_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._subscriber_task
            self._subscriber_task = None
        await self.async_client.aclose()
        self.sync.close()

    def save_room(self, room_id: str, state: dict[str, Any]) -> None:
        expires_at_ns = int(state["expiresAtNs"])
        logical_ttl_seconds = max(
            1,
            math.ceil((expires_at_ns - time.time_ns()) / 1_000_000_000),
        )
        ttl_seconds = logical_ttl_seconds + self.settings.room_presence_ttl_seconds
        pipeline = self.sync.pipeline(transaction=True)
        pipeline.set(self._room_key(room_id), json.dumps(state), ex=ttl_seconds)
        pipeline.hset(self._room_index_key(), room_id, str(state["sessionId"]))
        pipeline.zadd(self._room_expiry_key(), {room_id: expires_at_ns})
        pipeline.execute()

    def load_room(self, room_id: str) -> dict[str, Any] | None:
        raw = self.sync.get(self._room_key(room_id))
        if not isinstance(raw, str):
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None

    def remove_room(self, room_id: str) -> str | None:
        session_id = self.sync.hget(self._room_index_key(), room_id)
        pipeline = self.sync.pipeline(transaction=True)
        pipeline.delete(self._room_key(room_id), self._members_key(room_id))
        pipeline.hdel(self._room_index_key(), room_id)
        pipeline.zrem(self._room_expiry_key(), room_id)
        pipeline.execute()
        return session_id if isinstance(session_id, str) else None

    def due_room_ids(self, now_ns: int) -> list[str]:
        values = self.sync.zrangebyscore(self._room_expiry_key(), 0, now_ns)
        return [str(value) for value in values] if isinstance(values, list) else []

    def register_participant(self, room_id: str, participant: dict[str, Any]) -> dict[str, Any] | None:
        user_id = str(participant["userId"])
        previous = self.sync.eval(
            self._REGISTER_PARTICIPANT_SCRIPT,
            2,
            self._participant_key(room_id, user_id),
            self._members_key(room_id),
            json.dumps(participant),
            str(self.settings.room_presence_ttl_seconds),
            user_id,
            str(self.settings.room_ttl_seconds + self.settings.room_presence_ttl_seconds),
        )
        if not isinstance(previous, str):
            return None
        value = json.loads(previous)
        return value if isinstance(value, dict) else None

    def update_participant(self, room_id: str, participant: dict[str, Any]) -> bool:
        user_id = str(participant["userId"])
        result = self.sync.eval(
            self._UPDATE_PARTICIPANT_SCRIPT,
            2,
            self._participant_key(room_id, user_id),
            self._members_key(room_id),
            str(participant["connectionId"]),
            json.dumps(participant),
            str(self.settings.room_presence_ttl_seconds),
            user_id,
            str(self.settings.room_ttl_seconds + self.settings.room_presence_ttl_seconds),
        )
        return isinstance(result, (int, str)) and int(result) == 1

    def remove_participant(self, room_id: str, user_id: str, connection_id: str) -> bool:
        result = self.sync.eval(
            self._REMOVE_PARTICIPANT_SCRIPT,
            2,
            self._participant_key(room_id, user_id),
            self._members_key(room_id),
            connection_id,
            user_id,
        )
        return isinstance(result, (int, str)) and int(result) == 1

    def roster(self, room_id: str) -> list[dict[str, Any]]:
        raw_user_ids = self.sync.smembers(self._members_key(room_id))
        user_ids = [str(value) for value in raw_user_ids] if isinstance(raw_user_ids, set) else []
        if not user_ids:
            return []
        keys = [self._participant_key(room_id, user_id) for user_id in user_ids]
        raw_values = self.sync.mget(keys)
        values = raw_values if isinstance(raw_values, list) else []
        roster: list[dict[str, Any]] = []
        missing: list[str] = []
        for user_id, raw in zip(user_ids, values, strict=True):
            if not isinstance(raw, str):
                missing.append(user_id)
                continue
            value = json.loads(raw)
            if isinstance(value, dict):
                roster.append(value)
        if missing:
            self.sync.srem(self._members_key(room_id), *missing)
        return roster

    async def publish(self, room_id: str, kind: str, payload: dict[str, Any]) -> None:
        event = {
            "eventId": str(uuid.uuid4()),
            "sourceInstanceId": self.instance_id,
            "roomId": room_id,
            "kind": kind,
            "payload": payload,
        }
        await self.async_client.publish(self._events_channel(), json.dumps(event))

    @asynccontextmanager
    async def room_lock(self, room_id: str) -> AsyncIterator[None]:
        token = str(uuid.uuid4())
        deadline = time.monotonic() + self.settings.room_lock_wait_seconds
        key = self._lock_key(room_id)
        acquired = False
        try:
            while True:
                acquired = bool(
                    await self.async_client.set(
                        key,
                        token,
                        nx=True,
                        px=self.settings.room_lock_seconds * 1000,
                    )
                )
                if acquired:
                    break
                if time.monotonic() >= deadline:
                    raise RoomLockTimeoutError("room state is busy")
                await asyncio.sleep(0.025)
            yield
        finally:
            with contextlib.suppress(redis.RedisError):
                # Keep release cancellation-safe: a disconnected WebSocket can cancel its handler
                # while unwinding, but must never strand the distributed lock until its TTL.
                if acquired:
                    self.sync.eval(self._RELEASE_LOCK_SCRIPT, 1, key, token)

    async def _subscriber_loop(self) -> None:
        delay = 0.25
        while not self._stopping:
            pubsub = self.async_client.pubsub(ignore_subscribe_messages=True)
            try:
                await pubsub.subscribe(self._events_channel())
                self._subscriber_ready.set()
                delay = 0.25
                async for message in pubsub.listen():
                    if self._stopping:
                        return
                    raw = message.get("data")
                    if not isinstance(raw, str):
                        continue
                    event = json.loads(raw)
                    if not isinstance(event, dict) or event.get("sourceInstanceId") == self.instance_id:
                        continue
                    await self.handler(event)
            except asyncio.CancelledError:
                raise
            except (redis.RedisError, ValueError, TypeError):
                logger.exception("Redis room event subscriber disconnected")
                await asyncio.sleep(delay)
                delay = min(5.0, delay * 2)
            finally:
                await pubsub.aclose()

    def _room_key(self, room_id: str) -> str:
        return f"{self.prefix}:rooms:{room_id}:state"

    def _members_key(self, room_id: str) -> str:
        return f"{self.prefix}:rooms:{room_id}:members"

    def _participant_key(self, room_id: str, user_id: str) -> str:
        return f"{self.prefix}:rooms:{room_id}:participant:{user_id}"

    def _lock_key(self, room_id: str) -> str:
        return f"{self.prefix}:rooms:{room_id}:lock"

    def _room_index_key(self) -> str:
        return f"{self.prefix}:rooms:index"

    def _room_expiry_key(self) -> str:
        return f"{self.prefix}:rooms:expiry"

    def _events_channel(self) -> str:
        return f"{self.prefix}:rooms:events"
