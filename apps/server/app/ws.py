"""WebSocket 게이트웨이 — 시계 동기(PING/PONG) + 트랜스포트(START/STOP).

시퀀스는 설계문서 §6.4 참조. PONG의 t1은 수신 직후 즉시 캡처한다.
"""

from uuid import uuid4

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from .access import is_leader_for_repertoire, require_repertoire
from .auth import decode_token
from .db import SessionLocal
from .models import User
from .rooms import LEAD_MS, Member, manager, server_ms

router = APIRouter()


@router.websocket("/ws/rooms/{room_id}")
async def room_ws(ws: WebSocket, room_id: str, token: str = Query(...)) -> None:
    user_id = decode_token(token)
    if user_id is None:
        await ws.close(code=4401)
        return

    room = manager.get(room_id)
    if room is None:
        await ws.close(code=4404)
        return

    # 접속 시 1회만 DB 조회 (권한·표시 이름) — 이후 메시지 루프는 DB 무접근
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            await ws.close(code=4401)
            return
        try:
            require_repertoire(db, user, room.repertoire_id)
        except Exception:
            await ws.close(code=4403)
            return
        is_leader = room.creator_id == user.id or is_leader_for_repertoire(db, user, room.repertoire_id)
        display_name = user.display_name

    await ws.accept()
    conn_id = uuid4().hex
    room.members[conn_id] = Member(
        conn_id=conn_id, user_id=user_id, display_name=display_name, is_leader=is_leader, ws=ws
    )

    # 입장 직후 현재 트랜스포트 상태 전달 → 늦은 합류자도 즉시 위치 계산 가능 (§6.3)
    await ws.send_json({"type": "TRANSPORT", "state": room.transport_state().model_dump(by_alias=True)})
    await manager.broadcast_roster(room)

    try:
        while True:
            msg = await ws.receive_json()
            t1 = server_ms()  # 수신 즉시 캡처 (PING 처리 정확도)
            msg_type = msg.get("type")

            if msg_type == "PING":
                await ws.send_json({"type": "PONG", "t0": msg.get("t0"), "t1": t1})

            elif msg_type == "CMD_START":
                member = room.members.get(conn_id)
                if not member or not member.is_leader:
                    await ws.send_json({"type": "ERROR", "message": "리더만 시작할 수 있습니다"})
                    continue
                room.status = "playing"
                room.anchor = {
                    "measure": int(msg.get("measure", 1)),
                    "pass": int(msg.get("pass", 1) or 1),
                }
                room.count_in = bool(msg.get("countIn", True))
                room.server_start_time = server_ms() + LEAD_MS
                await manager.broadcast_transport(room)

            elif msg_type == "CMD_STOP":
                member = room.members.get(conn_id)
                if not member or not member.is_leader:
                    await ws.send_json({"type": "ERROR", "message": "리더만 정지할 수 있습니다"})
                    continue
                room.status = "idle"
                room.anchor = None
                room.server_start_time = None
                await manager.broadcast_transport(room)

            elif msg_type == "REPORT_RTT":
                member = room.members.get(conn_id)
                if member:
                    member.rtt_ms = float(msg.get("rttMs", 0))
                    await manager.broadcast_roster(room)

            else:
                await ws.send_json({"type": "ERROR", "message": f"알 수 없는 메시지: {msg_type}"})

    except WebSocketDisconnect:
        pass
    finally:
        room.members.pop(conn_id, None)
        if room.members:
            await manager.broadcast_roster(room)
        manager.remove_if_empty(room)
