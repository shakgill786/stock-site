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

# ------------------------------------------------------------------
# Password hashing
# ------------------------------------------------------------------
# Default to bcrypt_sha256 to avoid bcrypt's 72-byte limit.
# Also accept legacy bcrypt ($2b$...) so existing users can still log in.
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
)

def hash_password(plain: str) -> str:
    # bcrypt_sha256 safely handles long/unicode passwords
    return pwd_context.hash(plain or "")

def _truncate_to_72_bytes(s: str) -> str:
    """
    For legacy bcrypt verification ONLY: bcrypt ignores data past 72 bytes.
    Some backends error out instead of truncating, so we pre-truncate.
    """
    b = (s or "").encode("utf-8")
    if len(b) <= 72:
        return s or ""
    # truncate to 72 bytes, drop partial codepoint if needed
    b = b[:72]
    return b.decode("utf-8", errors="ignore")

def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify password against either bcrypt_sha256 (preferred) or legacy bcrypt.
    If the stored hash is legacy bcrypt, pre-truncate plaintext to 72 bytes.
    """
    hashed = hashed or ""
    scheme = None
    try:
        scheme = pwd_context.identify(hashed)
    except Exception:
        # Unknown hash → let passlib raise below
        pass

    candidate = plain or ""
    if scheme == "bcrypt":
        candidate = _truncate_to_72_bytes(candidate)

    return pwd_context.verify(candidate, hashed)

def needs_rehash(hashed: str) -> bool:
    """
    True if the stored hash should be upgraded to our current policy
    (e.g., it's legacy 'bcrypt' or params outdated).
    """
    try:
        if pwd_context.needs_update(hashed):
            return True
        scheme = pwd_context.identify(hashed) or ""
        return scheme != "bcrypt_sha256"
    except Exception:
        # unknown/odd hash → upgrade after a successful verify
        return True

# ------------------------------------------------------------------
# JWT config
# ------------------------------------------------------------------
SECRET_KEY = getenv("SECRET_KEY", "")
ALGORITHM = getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60") or "60")

def create_access_token(sub: str, minutes_override: Optional[int] = None) -> str:
    if not SECRET_KEY:
        raise RuntimeError("SECRET_KEY missing")
    minutes = minutes_override if minutes_override is not None else ACCESS_TOKEN_EXPIRE_MINUTES
    now = datetime.now(tz=timezone.utc)
    exp = now + timedelta(minutes=minutes)
    payload = {"sub": sub, "iat": int(now.timestamp()), "exp": int(exp.timestamp())}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

# ------------------------------------------------------------------
# Auth dependencies
# ------------------------------------------------------------------
# tokenUrl must match how the router is mounted (/auth/login)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

def _auth_error(detail: str = "Invalid credentials"):
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )

async def _token_from_request(
    request: Request,
    bearer: Optional[str] = Depends(oauth2_scheme),
) -> Optional[str]:
    """
    Pull token from Authorization: Bearer ... or from ?token=... (handy for SSE).
    """
    if bearer:
        return bearer
    q = request.query_params.get("token")
    return q or None

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
        _auth_error("Invalid credentials")
    return user

# ------------------------------------------------------------------
# Debug helper (used by router _dbg/check_password)
# ------------------------------------------------------------------
def dbg_verify_for_email(db: Session, email: str, password: str) -> dict:
    out = {"email": email, "exists": False}
    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        return out
    out["exists"] = True
    out["hash"] = user.password_hash
    try:
        scheme = pwd_context.identify(user.password_hash)
        out["hash_scheme"] = scheme
        out["passwd_len_bytes"] = len((password or "").encode("utf-8"))
        out["verify_ok"] = verify_password(password, user.password_hash)
        out["needs_rehash"] = needs_rehash(user.password_hash)
    except Exception as e:
        out["verify_exception"] = f"{type(e).__name__}: {e}"
    return out
