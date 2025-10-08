# app/auth/utils.py
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from os import getenv

from app.db import get_db
from app.auth.models import User

# ================== Utils marker (so we can prove this file is live) ==================
def get_utils_marker() -> str:
    return "2025-10-03-bcryptsha256-retry2"

# ================== Password hashing / verification ==================

# Keep bcrypt_sha256 FIRST so $bcrypt-sha256$ hashes route correctly.
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
    bcrypt__ident="2b",
)

def identify_hash(hashed: str) -> str:
    try:
        return pwd_context.identify(hashed or "") or "unknown"
    except Exception:
        return "unknown"

def hash_password(plain: str) -> str:
    """Hash a password with bcrypt_sha256 (handles long/unicode safely)."""
    return pwd_context.hash(plain or "")

def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify against either $bcrypt-sha256$ or legacy $2b$ hashes.
    If some env throws 'longer than 72 bytes' for bcrypt, retry with truncated input.
    """
    plain = plain or ""
    hashed = hashed or ""
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError as e:
        msg = str(e).lower()
        if "72 bytes" in msg:
            # Defensive retry: bcrypt backend can complain about input >72 bytes.
            # bcrypt_sha256 shouldn't, but if the backend raises anyway, retry.
            try:
                return pwd_context.verify(plain[:72], hashed)
            except Exception:
                pass
        raise

def verify_password_dual(plain: str, hashed: str) -> dict:
    """
    Debug helper: run a raw verify and a retry-with-truncation verify, returning details.
    """
    out = {"scheme": identify_hash(hashed or ""), "raw_ok": None, "retry_ok": None, "raw_error": None, "retry_error": None}
    try:
        out["raw_ok"] = bool(pwd_context.verify(plain or "", hashed or ""))
    except Exception as e:
        out["raw_error"] = f"{type(e).__name__}: {e}"
    # retry path
    try:
        out["retry_ok"] = bool(pwd_context.verify((plain or "")[:72], hashed or ""))
    except Exception as e:
        out["retry_error"] = f"{type(e).__name__}: {e}"
    return out

# ================== JWT ==================

SECRET_KEY = getenv("SECRET_KEY", "CHANGE_ME_IN_ENV")
ALGORITHM = getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

def create_access_token(sub: str, expires_delta: Optional[timedelta] = None, minutes_override: Optional[int] = None) -> str:
    now = datetime.now(tz=timezone.utc)
    minutes = minutes_override if minutes_override is not None else ACCESS_TOKEN_EXPIRE_MINUTES
    expire = now + (expires_delta or timedelta(minutes=minutes))
    to_encode = {"sub": sub, "iat": int(now.timestamp()), "exp": int(expire.timestamp())}
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

# ================== Auth dependencies ==================

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

async def _token_from_request(request: Request, bearer: Optional[str] = Depends(oauth2_scheme)) -> Optional[str]:
    # allow SSE / query usage: ?token=...
    if bearer:
        return bearer
    return request.query_params.get("token")

def _auth_error(detail: str = "Invalid credentials"):
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )

def _decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        if not sub:
            _auth_error("Token missing subject")
        return str(sub)
    except JWTError:
        _auth_error("Invalid token")

async def get_current_user(
    token: Optional[str] = Depends(_token_from_request),
    db: Session = Depends(get_db),
) -> User:
    if not token:
        _auth_error("Missing token")
    email = _decode_token(token)
    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        _auth_error("User not found")
    return user

# ============== Small debug helpers (used by router debug endpoints) ==============

def dbg_verify_for_email(db: Session, email: str, password: str) -> dict:
    out = {"email": email, "exists": False}
    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        return out
    out["exists"] = True
    out["hash"] = user.password_hash
    out["hash_scheme"] = identify_hash(user.password_hash)
    # Use our normal verify() which includes the safe retry.
    try:
        ok = verify_password(password, user.password_hash)
        out["verify_ok"] = bool(ok)
    except Exception as e:
        out["verify_exception"] = f"{type(e).__name__}: {e}"
    return out
