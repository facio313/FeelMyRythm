import os
from pathlib import Path

# app 모듈 임포트 전에 테스트용 DB 설정
_TEST_DB = Path(__file__).parent / "test.db"
if _TEST_DB.exists():
    _TEST_DB.unlink()
os.environ["FMR_DATABASE_URL"] = f"sqlite:///{_TEST_DB}"
os.environ["FMR_UPLOADS_DIR"] = str(Path(__file__).parent / "uploads")
