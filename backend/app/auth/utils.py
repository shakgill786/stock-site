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

# ================== Password hashing / verification ==================

# IMPORTANT: bcrypt_sha256 *must* be first so Passlib routes $bcrypt-sha256$ hashes to it.
# Keep bcrypt second to accept old $2b$ hashes.
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
    # ensure we're not accidentally using old 2a/2y identifiers
    bcrypt__ident="2b",
)

def hash_password(plain: str) -> str:
    """Hash a password with bcrypt_sha256 (handles long/unicode safely)."""
    return pwd_context.hash(plain or "")

def identify_hash(hashed: str) -> str:
    """
    Return the scheme Passlib thinks this hash uses, e.g. 'bcrypt_sha256', 'bcrypt', or None.
    """
    try:
        return pwd_context.identify(hashed) or "unknown"
    except Exception:
        return "unknown"

def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify against either $bcrypt-sha256$ or legacy $2b$ hashes.
    - Prefer native Passlib routing.
    - If a bcrypt ValueError about 72 bytes ever occurs, retry with truncated input.
    """
    plain = plain or ""
    hashed = hashed or ""
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError as e:
        # Some environments raise for bcrypt when input >72 bytes. Be defensive:
        msg = str(e).lower()
        if "longer than 72 bytes" in msg or "72 bytes" in msg:
            return pwd_context.verify(plain[:72], hashed)
        raise

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

# ============== Small debug helpers (router uses these) ==============

def dbg_verify_for_email(db: Session, email: str, password: str) -> dict:
    out = {"email": email, "exists": False}
    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        return out
    out["exists"] = True
    out["hash"] = user.password_hash
    out["hash_scheme"] = identify_hash(user.password_hash)
    try:
        ok = verify_password(password, user.password_hash)
        out["verify_ok"] = bool(ok)
    except Exception as e:
        out["verify_exception"] = f"{type(e).__name__}: {e}"
    return out
