# app/auth/router.py
from fastapi import APIRouter, Depends, HTTPException, Request, status, Header
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from typing import Optional
import os, logging, traceback

from app.db import get_db
from app.auth import schemas
from app.auth.models import User
from app.auth.utils import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    dbg_verify_for_email,
    pwd_context,  # for needs_update()
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["Auth"])  # prefix added in main.py

# ---------- Debug gates ----------
def _auth_debug_enabled() -> bool:
    return str(os.getenv("AUTH_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}

DEBUG_AUTH_TOKEN = (os.getenv("DEBUG_AUTH_TOKEN") or "").strip()

def _require_debug(request: Request, x_debug_auth: Optional[str] = None):
    if DEBUG_AUTH_TOKEN:
        if (x_debug_auth or "") != DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=401, detail="Unauthorized (bad X-Debug-Auth)")
        return
    if not _auth_debug_enabled():
        raise HTTPException(status_code=404, detail="Not found")

def _safe_401(detail: str = "Invalid email or password"):
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

# ---------- Public endpoints ----------
@router.post("/register", response_model=schemas.TokenOut, status_code=status.HTTP_201_CREATED)
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
        return {"access_token": token, "token_type": "bearer"}
    except Exception:
        log.exception("create_access_token() failed during register")
        raise HTTPException(status_code=500, detail="Token mint failed")

@router.post("/login", response_model=schemas.TokenOut)
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    email = payload.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        _safe_401()

    # verify (with utils’ fallback handling)
    try:
        ok = verify_password(payload.password, user.password_hash)
    except Exception as e:
        log.exception("verify_password() raised")
        if _auth_debug_enabled() or DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=500, detail=f"verify_password failed: {type(e).__name__}: {e}")
        _safe_401()
    if not ok:
        _safe_401()

    # Optional: opportunistic rehash to bcrypt_sha256 if the hash is legacy or policy changed
    try:
        if user.password_hash and pwd_context.needs_update(user.password_hash):
            user.password_hash = hash_password(payload.password)
            db.add(user)
            db.commit()
    except Exception:
        log.warning("needs_update/rehash failed", exc_info=True)

    try:
        token = create_access_token(sub=user.email)
        return {"access_token": token, "token_type": "bearer"}
    except Exception as e:
        log.exception("create_access_token() raised")
        if _auth_debug_enabled() or DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=500, detail=f"create_access_token failed: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

@router.get("/me", response_model=schemas.UserOut)
def me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}

@router.get("/_health", include_in_schema=False)
def _health():
    return {"ok": True}

# ---------- Debug endpoints ----------
class _DbgLogin(BaseModel):
    email: EmailStr
    password: str

class _DbgMint(BaseModel):
    email: EmailStr
    minutes: Optional[int] = None

class _DbgReset(BaseModel):
    email: EmailStr
    new_password: str

@router.get("/_dbg/version", include_in_schema=False)
def _dbg_version(
    request: Request,
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
):
    _require_debug(request, x_debug_auth)
    return {"router": "auth-router", "utils_marker": "2025-10-02-truncate72+noerr"}

@router.post("/_dbg/check_password", include_in_schema=False)
def _dbg_check_password(
    body: _DbgLogin,
    request: Request,
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
    db: Session = Depends(get_db),
):
    _require_debug(request, x_debug_auth)
    return dbg_verify_for_email(db, body.email, body.password)

@router.post("/_dbg/mint", include_in_schema=False)
def _dbg_mint(
    body: _DbgMint,
    request: Request,
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
    db: Session = Depends(get_db),
):
    _require_debug(request, x_debug_auth)
    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        token = create_access_token(sub=user.email, minutes_override=body.minutes)
        return {"access_token": token, "token_type": "bearer"}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc().splitlines()[-4:]}

@router.post("/_dbg/reset_password", include_in_schema=False)
def _dbg_reset_password(
    body: _DbgReset,
    request: Request,
    x_debug_auth: Optional[str] = Header(default=None, alias="X-Debug-Auth"),
    db: Session = Depends(get_db),
):
    _require_debug(request, x_debug_auth)
    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        user.password_hash = hash_password(body.new_password)
        db.add(user)
        db.commit()
        return {"ok": True, "email": user.email}
    except Exception:
        log.exception("reset_password failed")
        raise HTTPException(status_code=500, detail="Reset failed")
