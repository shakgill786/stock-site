# app/auth/router.py
import os
import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

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

# ⚠️ No prefix here; main.py mounts with prefix="/auth"
router = APIRouter(tags=["Auth"])


@router.post(
    "/register",
    response_model=schemas.TokenOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create account",
)
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    email = (payload.email or "").strip().lower()
    if not email or not payload.password:
        raise HTTPException(status_code=400, detail="Email and password required")

    exists = db.query(User).filter(User.email == email).first()
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered")

    # Hash password with guardrails
    try:
        pw_hash = hash_password(payload.password)
        if not isinstance(pw_hash, str) or len(pw_hash) < 10:
            raise RuntimeError("hash_password returned an invalid value")
    except Exception as e:
        log.error("REGISTER: hash_password failed for %s: %r", email, e)
        raise HTTPException(
            status_code=500, detail="Unable to create account (password hashing)"
        )

    user = User(email=email, password_hash=pw_hash)
    db.add(user)
    db.commit()
    db.refresh(user)

    # Issue token with guardrails
    try:
        token = create_access_token(sub=user.email)
    except Exception as e:
        log.error("REGISTER: create_access_token failed for %s: %r", email, e)
        raise HTTPException(status_code=500, detail="Unable to create account (token)")

    return {"access_token": token, "token_type": "bearer"}


@router.post(
    "/login",
    response_model=schemas.TokenOut,
    summary="Login (email+password)",
)
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    email = (payload.email or "").strip().lower()
    if not email or not payload.password:
        # Keep user enumeration parity
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    user = db.query(User).filter(User.email == email).first()
    if not user:
        # Uniform 401 to avoid leaking which emails exist
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Verify password; ensure exceptions don’t bubble as 500s
    try:
        ok = verify_password(payload.password, user.password_hash)
    except Exception as e:
        # Common culprit: malformed/legacy hash, backend lib mismatch, etc.
        log.warning(
            "LOGIN: verify_password raised for %s (prefix=%s…): %r",
            email,
            (user.password_hash or "")[:8],
            e,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Create JWT; guard against missing SECRET_KEY/ALGORITHM env, etc.
    try:
        token = create_access_token(sub=user.email)
    except Exception as e:
        log.error("LOGIN: create_access_token failed for %s: %r", email, e)
        raise HTTPException(status_code=500, detail="Unable to issue token")

    return {"access_token": token, "token_type": "bearer"}


@router.get("/me", response_model=schemas.UserOut, summary="Who am I?")
def me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}


# -------- TEMP DEBUG (remove after you fix the issue) --------
@router.get("/_debug_user", include_in_schema=False)
def _debug_user(email: str, db: Session = Depends(get_db)):
    """
    Returns limited, non-sensitive shape info to diagnose login 500s.
    Only enabled if AUTH_DEBUG=1 is set in the environment.
    """
    if os.getenv("AUTH_DEBUG") != "1":
        raise HTTPException(status_code=404, detail="Not found")

    e = (email or "").strip().lower()
    user = db.query(User).filter(User.email == e).first()
    if not user:
        return {"exists": False, "email": e}

    h = user.password_hash or ""
    return {
        "exists": True,
        "email": user.email,
        "hash_len": len(h),
        "hash_prefix": h[:7],      # e.g., "$2b$12", "$argon2"
        "hash_suffix_len": len(h[7:]),
    }
