from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """환경변수 접두사 FMR_ (예: FMR_DATABASE_URL)"""

    # 로컬 개발 기본값은 SQLite. 운영은 postgresql+psycopg://... 로 교체 (docker-compose.yml 참고)
    database_url: str = "sqlite:///./dev.db"
    jwt_secret: str = "dev-secret-change-me"
    jwt_expires_days: int = 30
    uploads_dir: str = "./uploads"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    model_config = {"env_prefix": "FMR_"}


settings = Settings()
