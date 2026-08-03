from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import create_token, hash_password, verify_password
from ..db import get_db
from ..models import User
from ..schemas import AuthResponse, LoginIn, RegisterIn, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _to_user_out(user: User) -> UserOut:
    return UserOut(id=user.id, email=user.email, display_name=user.display_name)


@router.post("/register", response_model=AuthResponse)
def register(body: RegisterIn, db: Session = Depends(get_db)) -> AuthResponse:
    exists = db.execute(select(User).where(User.email == body.email)).scalar_one_or_none()
    if exists:
        raise HTTPException(409, "이미 가입된 이메일입니다")
    user = User(email=body.email, password_hash=hash_password(body.password), display_name=body.display_name)
    db.add(user)
    db.commit()
    return AuthResponse(token=create_token(user.id), user=_to_user_out(user))


@router.post("/login", response_model=AuthResponse)
def login(body: LoginIn, db: Session = Depends(get_db)) -> AuthResponse:
    user = db.execute(select(User).where(User.email == body.email)).scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    return AuthResponse(token=create_token(user.id), user=_to_user_out(user))
