from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import Settings
from app.mailer import AccountDeletionMessage, MailDeliveryError, MailDeliveryManager
from app.models import (
    Annotation,
    DeviceCalibration,
    Group,
    GroupMember,
    MeasureMap,
    PracticeLog,
    PracticeSession,
    Project,
    RefreshSession,
    RepertoireItem,
    Score,
    StorageDeletionJob,
    TempoMapRevision,
    Todo,
    User,
)
from app.security import GoogleIdentity
from app.storage_lifecycle import StorageLifecycleWorker

from .conftest import FakeGoogleVerifier, FakeMailSender, auth, register


class FakeDeleteStorage:
    def __init__(self, failing_keys: set[str] | None = None) -> None:
        self.failing_keys = failing_keys or set()
        self.deleted_keys: list[str] = []

    def delete(self, storage_key: str) -> None:
        self.deleted_keys.append(storage_key)
        if storage_key in self.failing_keys:
            raise RuntimeError("object service unavailable")


def _seed_account_data(client: TestClient) -> dict[str, Any]:
    target = register(client, "delete-me@example.com", "Delete Me")
    other = register(client, "keeper@example.com", "Keeper")
    target_id = str(target["user"]["id"])
    other_id = str(other["user"]["id"])
    with client.app.state.database.session_factory() as db:
        owned_group = Group(name="Owned group", description="")
        other_group = Group(name="Other group", description="")
        db.add_all([owned_group, other_group])
        db.flush()
        db.add_all(
            [
                GroupMember(group_id=owned_group.id, user_id=target_id, role="owner"),
                GroupMember(group_id=other_group.id, user_id=other_id, role="owner"),
                GroupMember(group_id=other_group.id, user_id=target_id, role="leader"),
            ]
        )
        owned_project = Project(group_id=owned_group.id, name="Owned project", description="")
        other_project = Project(group_id=other_group.id, name="Other project", description="")
        db.add_all([owned_project, other_project])
        db.flush()
        owned_repertoire = RepertoireItem(
            project_id=owned_project.id,
            title="Owned repertoire",
            composer="",
            notes="",
        )
        other_repertoire = RepertoireItem(
            project_id=other_project.id,
            title="Other repertoire",
            composer="",
            notes="",
        )
        db.add_all([owned_repertoire, other_repertoire])
        db.flush()
        owned_scores = [
            Score(
                repertoire_id=owned_repertoire.id,
                kind="full",
                instrument="",
                filename="z.pdf",
                content_type="application/pdf",
                storage_key="scores/owned/z.pdf",
                size_bytes=10,
                upload_status="ready",
                created_by_id=target_id,
            ),
            Score(
                repertoire_id=owned_repertoire.id,
                kind="part",
                instrument="violin",
                filename="a.pdf",
                content_type="application/pdf",
                storage_key="scores/owned/a.pdf",
                size_bytes=10,
                upload_status="ready",
                created_by_id=target_id,
            ),
        ]
        shared_score = Score(
            repertoire_id=other_repertoire.id,
            kind="part",
            instrument="cello",
            filename="shared.pdf",
            content_type="application/pdf",
            storage_key="scores/shared/keep.pdf",
            size_bytes=10,
            upload_status="ready",
            created_by_id=target_id,
        )
        db.add_all([*owned_scores, shared_score])
        db.flush()
        target_annotation = Annotation(
            score_id=shared_score.id,
            author_id=target_id,
            scope="private",
            data={"kind": "text", "page": 1, "payload": {"text": "remove"}},
        )
        kept_annotation = Annotation(
            score_id=shared_score.id,
            author_id=other_id,
            scope="project",
            data={"kind": "text", "page": 1, "payload": {"text": "keep"}},
        )
        target_log = PracticeLog(
            repertoire_id=other_repertoire.id,
            author_id=target_id,
            content="remove",
            anchors=[],
        )
        kept_log = PracticeLog(
            repertoire_id=other_repertoire.id,
            author_id=other_id,
            content="keep",
            anchors=[],
        )
        todo = Todo(
            repertoire_id=other_repertoire.id,
            practice_log_id=None,
            content="keep audit reference",
            assignee_id=target_id,
            due_date=None,
            done=False,
            created_by_id=target_id,
        )
        tempo_map = TempoMapRevision(
            repertoire_id=other_repertoire.id,
            revision=1,
            data={"revision": 1},
            created_by_id=target_id,
        )
        measure_map = MeasureMap(
            score_id=shared_score.id,
            revision=1,
            regions=[],
            measure_number_offset=0,
            updated_by_id=target_id,
        )
        practice_session = PracticeSession(
            room_id="deleted-user-audit-room",
            repertoire_id=other_repertoire.id,
            leader_id=target_id,
            tempo_map_revision=1,
            status="stopped",
        )
        calibration = DeviceCalibration(
            user_id=target_id,
            device_fingerprint="delete-device",
            output_label="speaker",
            offset_ms=4.0,
        )
        db.add_all(
            [
                target_annotation,
                kept_annotation,
                target_log,
                kept_log,
                todo,
                tempo_map,
                measure_map,
                practice_session,
                calibration,
            ]
        )
        db.commit()
        return {
            "target": target,
            "targetId": target_id,
            "ownedGroupId": owned_group.id,
            "otherGroupId": other_group.id,
            "ownedScoreIds": [score.id for score in owned_scores],
            "ownedKeys": {score.storage_key for score in owned_scores},
            "sharedScoreId": shared_score.id,
            "targetAnnotationId": target_annotation.id,
            "keptAnnotationId": kept_annotation.id,
            "targetLogId": target_log.id,
            "keptLogId": kept_log.id,
            "todoId": todo.id,
            "tempoMapId": tempo_map.id,
            "measureMapId": measure_map.id,
            "practiceSessionId": practice_session.id,
        }


def _delete_body(current_password: str | None = "correct-horse-battery-staple") -> dict[str, str]:
    body = {"email": "delete-me@example.com"}
    if current_password is not None:
        body["currentPassword"] = current_password
    return body


def test_password_account_deletion_requires_exact_confirmation_and_anonymizes_audit_references(
    client: TestClient,
) -> None:
    seeded = _seed_account_data(client)
    headers = auth(seeded["target"]["accessToken"])
    fake_storage = FakeDeleteStorage()
    client.app.state.storage = fake_storage

    wrong_email = client.request(
        "DELETE",
        "/api/users/me",
        headers=headers,
        json={"email": "someone-else@example.com", "currentPassword": "correct-horse-battery-staple"},
    )
    missing_password = client.request(
        "DELETE",
        "/api/users/me",
        headers=headers,
        json=_delete_body(None),
    )
    wrong_password = client.request(
        "DELETE",
        "/api/users/me",
        headers=headers,
        json=_delete_body("wrong-password"),
    )
    assert wrong_email.status_code == 400
    assert missing_password.status_code == 400
    assert wrong_password.status_code == 400
    assert fake_storage.deleted_keys == []

    response = client.request("DELETE", "/api/users/me", headers=headers, json=_delete_body())

    assert response.status_code == 204, response.text
    assert fake_storage.deleted_keys == []
    with client.app.state.database.session_factory() as db:
        tombstone = db.get(User, seeded["targetId"])
        assert tombstone is not None
        assert tombstone.email == f"deleted-{seeded['targetId']}@deleted.invalid"
        assert tombstone.display_name == "Deleted user"
        assert tombstone.password_hash is None
        assert tombstone.google_subject is None
        assert tombstone.email_verified_at is None
        assert tombstone.is_active is False
        assert tombstone.auth_generation == 3
        assert db.get(Group, seeded["ownedGroupId"]) is None
        assert db.get(Group, seeded["otherGroupId"]) is not None
        assert all(db.get(Score, score_id) is None for score_id in seeded["ownedScoreIds"])
        assert db.get(Score, seeded["sharedScoreId"]) is not None
        assert db.get(Annotation, seeded["targetAnnotationId"]) is None
        assert db.get(Annotation, seeded["keptAnnotationId"]) is not None
        assert db.get(PracticeLog, seeded["targetLogId"]) is None
        assert db.get(PracticeLog, seeded["keptLogId"]) is not None
        assert (
            db.scalar(
                select(func.count())
                .select_from(DeviceCalibration)
                .where(DeviceCalibration.user_id == seeded["targetId"])
            )
            == 0
        )
        assert (
            db.scalar(
                select(func.count()).select_from(GroupMember).where(GroupMember.user_id == seeded["targetId"])
            )
            == 0
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(RefreshSession.user_id == seeded["targetId"])
            )
            == 0
        )
        todo = db.get(Todo, seeded["todoId"])
        assert todo is not None
        assert todo.assignee_id is None
        assert todo.created_by_id == seeded["targetId"]
        tempo_map = db.get(TempoMapRevision, seeded["tempoMapId"])
        measure_map = db.get(MeasureMap, seeded["measureMapId"])
        practice_session = db.get(PracticeSession, seeded["practiceSessionId"])
        assert tempo_map is not None
        assert measure_map is not None
        assert practice_session is not None
        assert tempo_map.created_by_id == seeded["targetId"]
        assert measure_map.updated_by_id == seeded["targetId"]
        assert practice_session.leader_id == seeded["targetId"]
        queued_keys = set(db.scalars(select(StorageDeletionJob.storage_key)).all())
        assert queued_keys == seeded["ownedKeys"]
    assert client.get("/api/users/me", headers=headers).status_code == 401

    worker = StorageLifecycleWorker(
        client.app.state.database,
        fake_storage,
        client.app.state.settings,
    )
    assert worker.run_once() == len(seeded["ownedKeys"])
    assert fake_storage.deleted_keys == sorted(seeded["ownedKeys"])
    assert "scores/shared/keep.pdf" not in fake_storage.deleted_keys


def test_google_only_account_requires_matching_google_reauthentication(client: TestClient) -> None:
    tokens = client.post("/api/auth/google", json={"idToken": "valid-google-token"}).json()
    assert tokens["user"]["hasPassword"] is False
    missing = client.request(
        "DELETE",
        "/api/users/me",
        headers=auth(tokens["accessToken"]),
        json={"email": "GOOGLE@example.com"},
    )
    assert missing.status_code == 400

    verifier = client.app.state.google_verifier
    assert isinstance(verifier, FakeGoogleVerifier)
    verifier.identities["other-google-token"] = GoogleIdentity(
        subject="different-google-subject",
        email="google@example.com",
        display_name="Different Google User",
        email_verified=True,
    )
    verifier.identities["unverified-delete-token"] = GoogleIdentity(
        subject="google-subject-1",
        email="google@example.com",
        display_name="Google User",
        email_verified=False,
    )
    different = client.request(
        "DELETE",
        "/api/users/me",
        headers=auth(tokens["accessToken"]),
        json={"email": "google@example.com", "googleIdToken": "other-google-token"},
    )
    unverified = client.request(
        "DELETE",
        "/api/users/me",
        headers=auth(tokens["accessToken"]),
        json={"email": "google@example.com", "googleIdToken": "unverified-delete-token"},
    )
    assert different.status_code == unverified.status_code == 400

    response = client.request(
        "DELETE",
        "/api/users/me",
        headers=auth(tokens["accessToken"]),
        json={"email": "GOOGLE@example.com", "googleIdToken": "valid-google-token"},
    )
    assert response.status_code == 204, response.text
    with client.app.state.database.session_factory() as db:
        tombstone = db.get(User, tokens["user"]["id"])
        assert tombstone is not None
        assert tombstone.is_active is False
        assert tombstone.google_subject is None


def test_google_only_account_can_use_one_time_email_deletion_challenge(
    client: TestClient,
    mail_sender: FakeMailSender,
) -> None:
    verifier = client.app.state.google_verifier
    assert isinstance(verifier, FakeGoogleVerifier)
    verifier.identities["email-delete-google-token"] = GoogleIdentity(
        subject="email-delete-google-subject",
        email="email-delete@example.com",
        display_name="Email Delete",
        email_verified=True,
    )
    tokens = client.post(
        "/api/auth/google",
        json={"idToken": "email-delete-google-token"},
    ).json()
    headers = auth(tokens["accessToken"])
    first = client.post("/api/users/me/delete-challenge", headers=headers)
    repeated = client.post("/api/users/me/delete-challenge", headers=headers)
    assert first.status_code == repeated.status_code == 202
    assert first.json() == repeated.json()
    assert client.app.state.mail_delivery_manager.wait_until_idle(2)
    assert len(mail_sender.account_deletion_messages) == 1

    deletion_token = mail_sender.latest_account_delete_token_for("email-delete@example.com")
    response = client.request(
        "DELETE",
        "/api/users/me",
        headers=headers,
        json={
            "email": "email-delete@example.com",
            "accountDeleteToken": deletion_token,
        },
    )
    assert response.status_code == 204, response.text
    assert (
        client.request(
            "DELETE",
            "/api/users/me",
            headers=headers,
            json={
                "email": "email-delete@example.com",
                "accountDeleteToken": deletion_token,
            },
        ).status_code
        == 401
    )


def test_account_deletion_mail_failure_is_generic_and_throttled(
    client: TestClient,
    settings: Settings,
) -> None:
    tokens = client.post("/api/auth/google", json={"idToken": "valid-google-token"}).json()

    class FailingDeletionSender:
        attempts = 0

        def send_account_deletion(self, message: AccountDeletionMessage) -> None:
            self.attempts += 1
            raise MailDeliveryError(f"timeout: {message.recipient}")

    sender = FailingDeletionSender()
    original_manager = client.app.state.mail_delivery_manager
    replacement = MailDeliveryManager(sender, worker_count=1, queue_capacity=4)
    replacement.start()
    client.app.state.mail_delivery_manager = replacement
    headers = auth(tokens["accessToken"])
    try:
        first = client.post("/api/users/me/delete-challenge", headers=headers)
        repeated = client.post("/api/users/me/delete-challenge", headers=headers)

        assert first.status_code == repeated.status_code == 202
        assert first.json() == repeated.json()
        assert first.headers["Retry-After"] == str(settings.account_delete_request_seconds)
        assert replacement.wait_until_idle(2)
        assert sender.attempts == 1
    finally:
        replacement.close(2)
        client.app.state.mail_delivery_manager = original_manager


def test_owned_score_cleanup_failure_retries_after_account_transaction_commits(
    client: TestClient,
) -> None:
    seeded = _seed_account_data(client)
    failing_key = sorted(seeded["ownedKeys"])[0]
    fake_storage = FakeDeleteStorage({failing_key})
    client.app.state.storage = fake_storage
    headers = auth(seeded["target"]["accessToken"])

    response = client.request("DELETE", "/api/users/me", headers=headers, json=_delete_body())

    assert response.status_code == 204, response.text
    assert fake_storage.deleted_keys == []
    worker = StorageLifecycleWorker(
        client.app.state.database,
        fake_storage,
        client.app.state.settings,
    )
    assert worker.run_once() == len(seeded["ownedKeys"])
    assert fake_storage.deleted_keys == sorted(seeded["ownedKeys"])
    with client.app.state.database.session_factory() as db:
        account = db.get(User, seeded["targetId"])
        assert account is not None
        assert account.email == f"deleted-{seeded['targetId']}@deleted.invalid"
        assert account.is_active is False
        assert db.get(Group, seeded["ownedGroupId"]) is None
        assert all(db.get(Score, score_id) is None for score_id in seeded["ownedScoreIds"])
        failed = db.scalar(select(StorageDeletionJob).where(StorageDeletionJob.storage_key == failing_key))
        assert failed is not None
        assert failed.status == "pending"
        assert failed.attempt_count == 1
    assert client.get("/api/users/me", headers=headers).status_code == 401
