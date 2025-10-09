# app/auth/utils.py
from datetime import datetime, timedelta, timezone
from typing import Optional
from os import getenv

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth.models import User

# ---- marker (prove this file is live) ----
def get_utils_marker() -> str:
    return "2025-10-03-bcryptsha256-retry3"

# ---- passlib context (make bcrypt/bcrypt_sha256 tolerant) ----
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
    # ensure bcrypt family uses 2b id
    bcrypt__ident="2b",
    # the important knobs: never raise on >72; truncate internally
    bcrypt__truncate_error=False,
    bcrypt_sha256__truncate_error=False,
)

def identify_hash(hashed: str) -> str:
    try:
        return pwd_context.identify(hashed or "") or "unknown"
    except Exception:
        return "unknown"

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain or "")

def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify against bcrypt_sha256 / bcrypt, with belt-and-suspenders fallbacks:
    - context set to not raise on >72
    - still retry with [:72] if some backend raises anyway
    """
    plain = plain or ""
    hashed = hashed or ""
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError as e:
        # last-ditch safety if a backend *still* complains
        msg = str(e).lower()
        if "72 bytes" in msg:
            try:
                return pwd_context.verify(plain[:72], hashed)
            except Exception:
                pass
        raise

def verify_password_dual(plain: str, hashed: str) -> dict:
    out = {
        "scheme": identify_hash(hashed or ""),
        "raw_ok": None, "retry_ok": None,
        "raw_error": None, "retry_error": None
    }
    try:
        out["raw_ok"] = bool(pwd_context.verify(plain or "", hashed or ""))
    except Exception as e:
        out["raw_error"] = f"{type(e).__name__}: {e}"
    try:
        out["retry_ok"] = bool(pwd_context.verify((plain or "")[:72], hashed or ""))
    except Exception as e:
        out["retry_error"] = f"{type(e).__name__}: {e}"
    return out

# ---- JWT ----
SECRET_KEY = getenv("SECRET_KEY", "CHANGE_ME_IN_ENV")
ALGORITHM = getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

def create_access_token(sub: str, expires_delta: Optional[timedelta] = None, minutes_override: Optional[int] = None) -> str:
    now = datetime.now(tz=timezone.utc)
    minutes = minutes_override if minutes_override is not None else ACCESS_TOKEN_EXPIRE_MINUTES
    expire = now + (expires_delta or timedelta(minutes=minutes))
    payload = {"sub": sub, "iat": int(now.timestamp()), "exp": int(expire.timestamp())}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

# ---- auth deps ----
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

async def _token_from_request(request: Request, bearer: Optional[str] = Depends(oauth2_scheme)) -> Optional[str]:
    if bearer:
        return bearer
    return request.query_params.get("token")

def _auth_error(detail: str = "Invalid credentials"):
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"})

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

# ---- debug helper used by router ----
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
