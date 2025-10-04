# app/auth/utils.py
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from os import getenv

from app.db import get_db
from app.auth.models import User

# ---- Password hashing ----
# bcrypt has a 72-byte input limit; bcrypt_sha256 safely hashes long / unicode inputs first.
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],  # accept legacy $2x/$2b too
    deprecated="auto",
)

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain or "")

def verify_password(plain: str, hashed: str) -> bool:
    # bcrypt_sha256 path prevents the old "password longer than 72 bytes" error
    return pwd_context.verify(plain or "", hashed or "")

# ---- JWT settings ----
SECRET_KEY = getenv("SECRET_KEY", "CHANGE_ME_IN_ENV")
ALGORITHM = getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

def create_access_token(sub: str, minutes_override: Optional[int] = None, expires_delta: Optional[timedelta] = None) -> str:
    now = datetime.now(tz=timezone.utc)
    if minutes_override is not None:
        expires_delta = timedelta(minutes=int(minutes_override))
    expire = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode = {"sub": sub, "iat": int(now.timestamp()), "exp": int(expire.timestamp())}
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

# ---- Auth dependencies ----
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

async def _token_from_request(request: Request, bearer: Optional[str] = Depends(oauth2_scheme)) -> Optional[str]:
    if bearer:
        return bearer
    q = request.query_params.get("token")
    return q or None

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

# ---- Debug helper used by router’s dbg endpoints ----
def dbg_verify_for_email(db: Session, email: str, password: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"email": email, "exists": False}
    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        return out
    hashed = user.password_hash or ""
    out.update(
        exists=True,
        hash=hashed,
        hash_scheme=("bcrypt" if hashed.startswith("$2") else "unknown"),
        passwd_len_bytes=len((password or "").encode("utf-8")),
    )
    try:
        ok = verify_password(password, hashed)
        out["verify_ok"] = bool(ok)
        # Suggest rehash if it’s pure $2b (not bcrypt_sha256)
        out["needs_rehash"] = hashed.startswith("$2b$")
    except Exception as e:
        out["verify_exception"] = f"{type(e).__name__}: {e}"
    return out
