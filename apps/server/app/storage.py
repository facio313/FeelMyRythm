from __future__ import annotations

import mimetypes
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import boto3
from botocore.exceptions import ClientError

from .config import Settings
from .models import utcnow
from .security import make_upload_token


@dataclass(frozen=True)
class UploadTarget:
    url: str
    method: str
    headers: dict[str, str]
    fields: dict[str, str]
    expires_at: datetime


class ObjectStorage(Protocol):
    def create_upload_target(self, storage_key: str, content_type: str, size_bytes: int) -> UploadTarget: ...
    def create_download_url(self, storage_key: str) -> tuple[str, datetime]: ...
    def exists(self, storage_key: str, expected_size: int) -> bool: ...
    def promote(self, staging_key: str, storage_key: str, expected_size: int) -> None: ...
    def delete(self, storage_key: str) -> None: ...
    def download_to(self, storage_key: str, target: Path) -> None: ...


class ObjectStoragePromotionError(RuntimeError):
    pass


class LocalObjectStorage:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = settings.local_uploads_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve_key(self, storage_key: str) -> Path:
        candidate = (self.root / storage_key).resolve()
        if self.root not in candidate.parents:
            raise ValueError("invalid storage key")
        return candidate

    @property
    def temporary_root(self) -> Path:
        return self.root / ".uploading"

    def create_temporary_upload_path(self) -> Path:
        self.temporary_root.mkdir(parents=True, exist_ok=True)
        return self.temporary_root / f"{uuid.uuid4()}.part"

    def publish_temporary_upload(self, temporary: Path, storage_key: str) -> None:
        candidate = temporary.resolve()
        if candidate.parent != self.temporary_root.resolve():
            raise ValueError("invalid temporary upload path")
        target = self.resolve_key(storage_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        candidate.replace(target)

    def cleanup_temporary_uploads(self, before: datetime) -> int:
        if not self.temporary_root.is_dir():
            return 0
        removed = 0
        threshold = before.timestamp()
        for candidate in self.temporary_root.iterdir():
            if candidate.is_file() and candidate.stat().st_mtime <= threshold:
                candidate.unlink(missing_ok=True)
                removed += 1
        return removed

    def create_upload_target(self, storage_key: str, content_type: str, size_bytes: int) -> UploadTarget:
        del size_bytes
        token = make_upload_token(self.settings, storage_key)
        base = self.settings.public_api_base_url.rstrip("/")
        encoded_key = quote(storage_key, safe="/")
        return UploadTarget(
            url=f"{base}/api/uploads/local/{encoded_key}?token={token}",
            method="PUT",
            headers={"Content-Type": content_type},
            fields={},
            expires_at=utcnow() + timedelta(seconds=self.settings.upload_url_ttl_seconds),
        )

    def create_download_url(self, storage_key: str) -> tuple[str, datetime]:
        token = make_upload_token(self.settings, storage_key)
        expires = utcnow() + timedelta(seconds=self.settings.upload_url_ttl_seconds)
        base = self.settings.public_api_base_url.rstrip("/")
        encoded_key = quote(storage_key, safe="/")
        return f"{base}/api/uploads/local/{encoded_key}?token={token}", expires

    def exists(self, storage_key: str, expected_size: int) -> bool:
        path = self.resolve_key(storage_key)
        return path.is_file() and path.stat().st_size == expected_size

    def promote(self, staging_key: str, storage_key: str, expected_size: int) -> None:
        target = self.resolve_key(storage_key)
        if target.is_file() and target.stat().st_size == expected_size:
            return
        source = self.resolve_key(staging_key)
        if not source.is_file() or source.stat().st_size != expected_size:
            raise ObjectStoragePromotionError("staging object is missing or has the wrong size")
        temporary = self.create_temporary_upload_path()
        try:
            shutil.copyfile(source, temporary)
            if temporary.stat().st_size != expected_size:
                raise ObjectStoragePromotionError("promoted object has the wrong size")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

    def delete(self, storage_key: str) -> None:
        self.resolve_key(storage_key).unlink(missing_ok=True)

    def download_to(self, storage_key: str, target: Path) -> None:
        source = self.resolve_key(storage_key)
        if not source.is_file():
            raise FileNotFoundError(storage_key)
        shutil.copyfile(source, target)


class S3ObjectStorage:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.bucket = settings.s3_bucket or ""
        self.client = boto3.client(
            "s3",
            region_name=settings.s3_region,
            endpoint_url=settings.s3_endpoint_url or None,
        )

    def create_upload_target(self, storage_key: str, content_type: str, size_bytes: int) -> UploadTarget:
        post = self.client.generate_presigned_post(
            Bucket=self.bucket,
            Key=storage_key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", size_bytes, size_bytes],
            ],
            ExpiresIn=self.settings.upload_url_ttl_seconds,
        )
        return UploadTarget(
            url=str(post["url"]),
            method="POST",
            headers={},
            fields={str(k): str(v) for k, v in post["fields"].items()},
            expires_at=utcnow() + timedelta(seconds=self.settings.upload_url_ttl_seconds),
        )

    def create_download_url(self, storage_key: str) -> tuple[str, datetime]:
        expires = utcnow() + timedelta(seconds=self.settings.upload_url_ttl_seconds)
        url = self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": storage_key},
            ExpiresIn=self.settings.upload_url_ttl_seconds,
        )
        return str(url), expires

    def exists(self, storage_key: str, expected_size: int) -> bool:
        try:
            response = self.client.head_object(Bucket=self.bucket, Key=storage_key)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return int(response["ContentLength"]) == expected_size

    def promote(self, staging_key: str, storage_key: str, expected_size: int) -> None:
        if self.exists(storage_key, expected_size):
            return
        if not self.exists(staging_key, expected_size):
            raise ObjectStoragePromotionError("staging object is missing or has the wrong size")
        self.client.copy_object(
            Bucket=self.bucket,
            CopySource={"Bucket": self.bucket, "Key": staging_key},
            Key=storage_key,
        )
        if not self.exists(storage_key, expected_size):
            raise ObjectStoragePromotionError("promoted object is missing or has the wrong size")

    def delete(self, storage_key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=storage_key)

    def download_to(self, storage_key: str, target: Path) -> None:
        self.client.download_file(self.bucket, storage_key, str(target))


def make_storage(settings: Settings) -> ObjectStorage:
    if settings.storage_backend == "s3":
        return S3ObjectStorage(settings)
    return LocalObjectStorage(settings)


def safe_filename(filename: str) -> str:
    name = Path(filename).name.strip().replace("\x00", "")
    return name[:180] or "score"


def content_type_for(filename: str, supplied: str) -> str:
    if supplied and supplied != "application/octet-stream":
        return supplied
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
