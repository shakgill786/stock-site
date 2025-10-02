# app/auth/router.py
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from typing import Optional
import os, traceback, logging

from app.db import get_db
from app.auth import schemas
from app.auth.models import User
from app.auth.utils import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
)

log = logging.getLogger(__name__)

# ⚠️ No prefix here; we add it in main.py with app.include_router(..., prefix="/auth")
router = APIRouter(tags=["Auth"])

# ---------- Helpers ----------
def _auth_debug_enabled() -> bool:
    return str(os.getenv("AUTH_DEBUG", "")).strip() in {"1", "true", "TRUE", "yes", "on"}

def _safe_401(detail: str = "Invalid email or password"):
    # Always return the same detail in prod to avoid leaking which field failed
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
    except Exception as e:
        log.exception("hash_password() failed")
        raise HTTPException(status_code=500, detail="Password hashing failed")

    user = User(email=email, password_hash=pwd_hash)
    db.add(user)
    db.commit()
    db.refresh(user)

    try:
        token = create_access_token(sub=user.email)
    except Exception as e:
        log.exception("create_access_token() failed during register")
        raise HTTPException(status_code=500, detail="Token mint failed")

    return {"access_token": token, "token_type": "bearer"}


@router.post("/login", response_model=schemas.TokenOut, summary="Login (email+password)")
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    """
    Typical failures that would cause 500s here:
      - bcrypt / passlib not available or misconfigured -> verify_password raises
      - JWT config missing/mis-typed (SECRET_KEY / ALGORITHM) -> create_access_token raises
    We catch & downgrade to 401 unless AUTH_DEBUG=1, where we surface the reason.
    """
    email = payload.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        _safe_401()

    # 1) Password check
    try:
        ok = verify_password(payload.password, user.password_hash)
    except Exception as e:
        # e.g., "Unknown hash algorithm", "bcrypt version mismatch", etc.
        log.exception("verify_password() raised")
        if _auth_debug_enabled():
            raise HTTPException(
                status_code=500,
                detail=f"verify_password failed: {e.__class__.__name__}: {str(e)}",
            )
        _safe_401()

    if not ok:
        _safe_401()

    # 2) Mint token
    try:
        token = create_access_token(sub=user.email)
    except Exception as e:
        log.exception("create_access_token() raised")
        if _auth_debug_enabled():
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

# ---------- Debug-only endpoints (require AUTH_DEBUG=1) ----------
class _DbgLogin(BaseModel):
    email: EmailStr
    password: str

class _DbgMint(BaseModel):
    email: EmailStr
    minutes: Optional[int] = None  # overrides ACCESS_TOKEN_EXPIRE_MINUTES if provided

@router.post("/_dbg/check_password", include_in_schema=False)
def _dbg_check_password(body: _DbgLogin, db: Session = Depends(get_db)):
    if not _auth_debug_enabled():
        raise HTTPException(status_code=404, detail="Not found")

    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        return {"email": email, "exists": False}

    try:
        ok = verify_password(body.password, user.password_hash)
    except Exception as e:
        return {
            "email": email,
            "exists": True,
            "hash": user.password_hash,
            "verify_exception": f"{e.__class__.__name__}: {str(e)}",
            "trace": traceback.format_exc().splitlines()[-4:],
        }

    return {
        "email": email,
        "exists": True,
        "hash": user.password_hash,
        "verify_ok": bool(ok),
    }

@router.post("/_dbg/mint", include_in_schema=False)
def _dbg_mint(body: _DbgMint, db: Session = Depends(get_db)):
    if not _auth_debug_enabled():
        raise HTTPException(status_code=404, detail="Not found")

    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        token = create_access_token(sub=user.email, minutes_override=body.minutes)
        return {"access_token": token, "token_type": "bearer"}
    except Exception as e:
        return {
            "error": f"{e.__class__.__name__}: {str(e)}",
            "trace": traceback.format_exc().splitlines()[-4:],
        }
