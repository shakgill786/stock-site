# app/auth/router.py
from fastapi import APIRouter, Depends, HTTPException, Request, status
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
    identify_hash,
    dbg_verify_for_email,
    verify_password_dual,   # NEW for deeper debug
    get_utils_marker,       # marker provided by utils (proves correct file is live)
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["Auth"])  # prefix applied in main.py

# -------- debug gates --------
def _auth_debug_enabled() -> bool:
    return str(os.getenv("AUTH_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}

DEBUG_AUTH_TOKEN = (os.getenv("DEBUG_AUTH_TOKEN") or "").strip()

def _require_debug(request: Request):
    if DEBUG_AUTH_TOKEN:
        hdr = request.headers.get("x-debug-auth", "")
        if hdr != DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=401, detail="Unauthorized (bad X-Debug-Auth)")
        return
    if not _auth_debug_enabled():
        raise HTTPException(status_code=404, detail="Not found")

def _safe_401(detail: str = "Invalid email or password"):
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

# -------- public endpoints --------
@router.post("/register", response_model=schemas.TokenOut, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    email = payload.email.lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    try:
        pwd_hash = hash_password(payload.password)
    except Exception:
        log.exception("hash_password() failed")
        raise HTTPException(status_code=500, detail="Password hashing failed")

    user = User(email=email, password_hash=pwd_hash)
    db.add(user); db.commit(); db.refresh(user)

    try:
        token = create_access_token(sub=user.email)
    except Exception:
        log.exception("create_access_token() failed during register")
        raise HTTPException(status_code=500, detail="Token mint failed")

    return {"access_token": token, "token_type": "bearer"}

@router.post("/login", response_model=schemas.TokenOut)
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    email = payload.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        _safe_401()

    try:
        ok = verify_password(payload.password, user.password_hash)
    except Exception as e:
        log.exception("verify_password() raised")
        if _auth_debug_enabled() or DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=500, detail=f"verify_password failed: {e.__class__.__name__}: {e}")
        _safe_401()

    if not ok:
        _safe_401()

    try:
        token = create_access_token(sub=user.email)
        return {"access_token": token, "token_type": "bearer"}
    except Exception as e:
        log.exception("create_access_token() raised")
        if _auth_debug_enabled() or DEBUG_AUTH_TOKEN:
            raise HTTPException(status_code=500, detail=f"create_access_token failed: {e.__class__.__name__}: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

@router.get("/me", response_model=schemas.UserOut)
def me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}

# -------- health / debug --------
@router.get("/_health", include_in_schema=False)
def _health():
    return {"ok": True}

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
def _dbg_version(request: Request):
    _require_debug(request)
    return {"router": "auth-router", "utils_marker": get_utils_marker()}

@router.post("/_dbg/check_password", include_in_schema=False)
def _dbg_check_password(body: _DbgLogin, request: Request, db: Session = Depends(get_db)):
    _require_debug(request)
    info = dbg_verify_for_email(db, body.email, body.password)
    info["identified_by"] = identify_hash(info.get("hash", "") or "")
    # deep dive: show both raw & retry behavior
    dual = verify_password_dual(body.password, info.get("hash", "") or "")
    info["dual"] = dual
    return info

@router.post("/_dbg/mint", include_in_schema=False)
def _dbg_mint(body: _DbgMint, request: Request, db: Session = Depends(get_db)):
    _require_debug(request)
    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        token = create_access_token(sub=user.email, minutes_override=body.minutes)
        return {"access_token": token, "token_type": "bearer"}
    except Exception as e:
        return {"error": f"{e.__class__.__name__}: {e}", "trace": traceback.format_exc().splitlines()[-4:]}

@router.post("/_dbg/reset_password", include_in_schema=False)
def _dbg_reset_password(body: _DbgReset, request: Request, db: Session = Depends(get_db)):
    _require_debug(request)
    email = body.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        user.password_hash = hash_password(body.new_password)
        db.add(user); db.commit()
        return {"ok": True, "email": user.email, "hash_scheme": identify_hash(user.password_hash)}
    except Exception:
        log.exception("reset_password failed")
        raise HTTPException(status_code=500, detail="Reset failed")
