"""REST + WS 통합 스모크 테스트: 가입 → 그룹/프로젝트/곡 → 템포맵 revision → 동기 세션"""

from fastapi.testclient import TestClient

from app.main import app


def _register(client: TestClient, email: str, name: str) -> dict:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "password1", "displayName": name},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _recv_until(ws, msg_type: str, limit: int = 10) -> dict:
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == msg_type:
            return msg
    raise AssertionError(f"{msg_type} 메시지를 받지 못함")


def test_full_flow() -> None:
    with TestClient(app) as client:
        # 1) 가입 + 로그인
        leader = _register(client, "leader@test.com", "리더")
        member = _register(client, "member@test.com", "멤버")
        lh = _headers(leader["token"])
        mh = _headers(member["token"])

        r = client.post(
            "/api/auth/login", json={"email": "leader@test.com", "password": "password1"}
        )
        assert r.status_code == 200

        # 2) 그룹 → 멤버 추가 → 프로젝트 → 곡
        group = client.post("/api/groups", json={"name": "우리 앙상블"}, headers=lh).json()
        r = client.post(
            f"/api/groups/{group['id']}/members",
            json={"email": "member@test.com", "role": "member"},
            headers=lh,
        )
        assert r.status_code == 200
        project = client.post(
            f"/api/groups/{group['id']}/projects", json={"name": "정기연주회"}, headers=lh
        ).json()
        rep = client.post(
            f"/api/projects/{project['id']}/repertoire",
            json={"title": "교향곡 5번", "composer": "베토벤"},
            headers=lh,
        ).json()

        # 멤버도 접근 가능
        r = client.get(f"/api/repertoire/{rep['id']}", headers=mh)
        assert r.status_code == 200

        # 3) 템포맵: 생성(rev 1) → 낙관적 잠금 충돌 감지
        tempo_map = {
            "id": "tm1",
            "revision": 0,
            "totalMeasures": 32,
            "sections": [
                {
                    "id": "a",
                    "startMeasure": 1,
                    "endMeasure": 25,
                    "timeSignature": {"num": 4, "denom": 4},
                    "bpm": 100,
                    "beatUnit": "quarter",
                },
                {
                    "id": "b",
                    "startMeasure": 26,
                    "endMeasure": 32,
                    "timeSignature": {"num": 4, "denom": 4},
                    "bpm": 130,
                    "beatUnit": "quarter",
                },
            ],
            "jumps": [],
            "countIn": {"measures": 1, "useSectionMeter": True},
        }
        r = client.put(
            f"/api/repertoire/{rep['id']}/tempomap",
            json={"baseRevision": 0, "data": tempo_map},
            headers=lh,
        )
        assert r.status_code == 200
        assert r.json()["revision"] == 1

        r = client.put(
            f"/api/repertoire/{rep['id']}/tempomap",
            json={"baseRevision": 0, "data": tempo_map},
            headers=mh,
        )
        assert r.status_code == 409  # 이미 rev 1

        # 4) 연습일지 + 할일
        r = client.post(
            f"/api/repertoire/{rep['id']}/logs",
            json={"content": "26마디 crescendo 주의", "anchors": [{"measureNumber": 26}]},
            headers=mh,
        )
        assert r.status_code == 200
        todo = client.post(
            f"/api/repertoire/{rep['id']}/todos", json={"content": "활 정리"}, headers=lh
        ).json()
        assert client.patch(f"/api/todos/{todo['id']}", headers=lh).json()["done"] is True

        # 5) 동기 세션: 방 개설 → 리더/멤버 접속 → PING/PONG → 동기 시작
        room = client.post("/api/rooms", json={"repertoireId": rep["id"]}, headers=lh).json()
        room_id = room["roomId"]

        with client.websocket_connect(f"/ws/rooms/{room_id}?token={leader['token']}") as ws_l:
            transport = _recv_until(ws_l, "TRANSPORT")
            assert transport["state"]["status"] == "idle"
            assert transport["state"]["tempoMapRevision"] == 1

            with client.websocket_connect(f"/ws/rooms/{room_id}?token={member['token']}") as ws_m:
                _recv_until(ws_m, "TRANSPORT")
                roster = _recv_until(ws_m, "ROOM_ROSTER")
                assert len(roster["members"]) == 2

                # 시계 동기 PING → t1은 서버 epoch ms
                ws_m.send_json({"type": "PING", "t0": 111})
                pong = _recv_until(ws_m, "PONG")
                assert pong["t0"] == 111
                assert pong["t1"] > 1_000_000_000_000

                # 멤버는 시작 권한 없음
                ws_m.send_json({"type": "CMD_START", "measure": 26})
                err = _recv_until(ws_m, "ERROR")
                assert "리더" in err["message"]

                # 리더가 26마디부터 시작 → 전원에게 미래 serverStartTime 브로드캐스트
                ws_l.send_json({"type": "CMD_START", "measure": 26, "countIn": True})
                for ws in (ws_l, ws_m):
                    t = _recv_until(ws, "TRANSPORT")
                    assert t["state"]["status"] == "playing"
                    assert t["state"]["anchor"] == {"measure": 26, "pass": 1}
                    assert t["state"]["serverStartTime"] >= pong["t1"] + 2000

                # 템포맵 수정 → 방에 TEMPOMAP_UPDATED 푸시
                r = client.put(
                    f"/api/repertoire/{rep['id']}/tempomap",
                    json={"baseRevision": 1, "data": tempo_map},
                    headers=lh,
                )
                assert r.status_code == 200
                upd = _recv_until(ws_m, "TEMPOMAP_UPDATED")
                assert upd["revision"] == 2


def test_score_upload_and_measure_map() -> None:
    with TestClient(app) as client:
        user = _register(client, "solo@test.com", "솔로")
        h = _headers(user["token"])
        group = client.post("/api/groups", json={"name": "개인"}, headers=h).json()
        project = client.post(f"/api/groups/{group['id']}/projects", json={"name": "연습"}, headers=h).json()
        rep = client.post(
            f"/api/projects/{project['id']}/repertoire", json={"title": "에튀드"}, headers=h
        ).json()

        r = client.post(
            f"/api/repertoire/{rep['id']}/scores",
            files={"file": ("score.pdf", b"%PDF-1.4 fake", "application/pdf")},
            data={"kind": "part", "instrument": "violin"},
            headers=h,
        )
        assert r.status_code == 200, r.text
        score = r.json()
        assert score["hasMeasureMap"] is False

        r = client.put(
            f"/api/scores/{score['id']}/measure-map",
            json={
                "regions": [
                    {"page": 1, "measureNumber": 1, "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}}
                ],
                "measureNumberOffset": 0,
            },
            headers=h,
        )
        assert r.status_code == 200

        r = client.get(f"/api/scores/{score['id']}/file", headers=h)
        assert r.status_code == 200
        assert r.content.startswith(b"%PDF")

        # 필기 저장/조회
        r = client.put(
            f"/api/scores/{score['id']}/annotations",
            json={"scope": "private", "data": {"strokes": [[0.1, 0.2, 0.3, 0.4]]}},
            headers=h,
        )
        assert r.status_code == 200
        r = client.get(f"/api/scores/{score['id']}/annotations", headers=h)
        assert len(r.json()) == 1
