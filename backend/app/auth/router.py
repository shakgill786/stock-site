# app/auth/router.py
import logging, os, traceback
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status, Header
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth import schemas
from app.auth.models import User
from app.auth.utils import (
    hash_password,
    verify_password,
    needs_rehash,
    create_access_token,
    get_current_user,
    dbg_verify_for_email,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["Auth"])  # prefix is added in main.py

# ---------- Debug gates ----------
def _auth_debug_enabled() -> bool:
    return str(os.getenv("AUTH_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}

DEBUG_AUTH_TOKEN = (os.getenv("DEBUG_AUTH_TOKEN") or "").strip()

def _require_debug(request: Request, x_debug_auth: Optional[str] = None):
    """
    Gate for debug endpoints:
    - If DEBUG_AUTH_TOKEN is set, require header X-Debug-Auth to match it.
    - Else fall back to AUTH_DEBUG=1|true|yes|on.
    """
    token = x_debug_auth or request.headers.get("x-debug-auth")
    if DEBUG_AUTH_TOKEN:
        if token != DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=401, detail="Unauthorized (bad X-Debug-Auth)")
        return
    if not _auth_debug_enabled():
        raise HTTPException(status_code=404, detail="Not found")

def _safe_401(detail: str = "Invalid email or password"):
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

# ---------- Public auth endpoints ----------
@router.post(
    "/register",
    response_model=schemas.TokenOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create account",
)
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    email = payload.email.lower()
    exists = db.query(User).filter(User.email == email).first()
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered")

    try:
        pwd_hash = hash_password(payload.password)
    except Exception:
        log.exception("hash_password() failed")
        raise HTTPException(status_code=500, detail="Password hashing failed")

    user = User(email=email, password_hash=pwd_hash)
    db.add(user)
    db.commit()
    db.refresh(user)

    try:
        token = create_access_token(sub=user.email)
    except Exception:
        log.exception("create_access_token() failed during register")
        raise HTTPException(status_code=500, detail="Token mint failed")

    return {"access_token": token, "token_type": "bearer"}

@router.post("/login", response_model=schemas.TokenOut, summary="Login (email+password)")
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    """
    - Verifies password against bcrypt_sha256 (or legacy bcrypt).
    - If legacy/weak params are detected, transparently rehash to bcrypt_sha256.
    """
    email = payload.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        _safe_401()

    # 1) Password check
    try:
        ok = verify_password(payload.password, user.password_hash)
    except Exception as e:
        log.exception("verify_password() raised")
        if _auth_debug_enabled() or DEBUG_AUTH_TOKEN:
            raise HTTPException(
                status_code=500,
                detail=f"verify_password failed: {e.__class__.__name__}: {str(e)}",
            )
        _safe_401()

    if not ok:
        _safe_401()

    # 2) Opportunistic upgrade: rehash to bcrypt_sha256 if needed
    try:
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(payload.password)
            db.add(user)
            db.commit()
    except Exception:
        # Non-fatal; just log
        log.warning("Password rehash skipped due to error", exc_info=True)
        db.rollback()

    # 3) Mint token
    try:
        token = create_access_token(sub=user.email)
    except Exception as e:
        log.exception("create_access_token() raised")
        if _auth_debug_enabled() or DEBUG_AUTH_TOKEN:
            raise HTTPException(
                status_code=500,
                detail=f"create_access_token failed: {e.__class__.__name__}: {str(e)}",
            )
        raise HTTPException(status_code=500, detail="Internal Server Error")

    return {"access_token": token, "token_type": "bearer"}

@router.get("/me", response_model=schemas.UserOut, summary="Who am I?")
def me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}

# ---------- Lightweight health ----------
@router.get("/_health", include_in_schema=False)
def _health():
    return {"ok": True}

# ---------- Debug-only endpoints ----------
class _DbgLogin(BaseModel):
    email: EmailStr
    password: str

class _DbgMint(BaseModel):
    email: EmailStr
    minutes: Optional[int] = None  # override token minutes

class _DbgReset(BaseModel):
    email: EmailStr
    new_password: str

@router.post("/_dbg/check_password", include_in_schema=False)
def _dbg_check_password(
    body: _DbgLogin,
    request: Request,
    db: Session = Depends(get_db),
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
):
    _require_debug(request, x_debug_auth)
    return dbg_verify_for_email(db, body.email, body.password)

@router.post("/_dbg/mint", include_in_schema=False)
def _dbg_mint(
    body: _DbgMint,
    request: Request,
    db: Session = Depends(get_db),
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
):
    _require_debug(request, x_debug_auth)
    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    token = create_access_token(sub=user.email, minutes_override=body.minutes)
    return {"access_token": token, "token_type": "bearer"}

@router.post("/_dbg/reset_password", include_in_schema=False)
def _dbg_reset_password(
    body: _DbgReset,
    request: Request,
    db: Session = Depends(get_db),
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
):
    _require_debug(request, x_debug_auth)
    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.password_hash = hash_password(body.new_password)
    db.add(user)
    db.commit()
    return {"ok": True, "email": user.email}
