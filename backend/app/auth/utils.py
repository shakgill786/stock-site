# app/auth/utils.py
from datetime import datetime, timedelta, timezone
from typing import Optional
from os import getenv
import hashlib
import re

import bcrypt  # manual verify for bcrypt_sha256
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth.models import User

# ----- build marker so you can verify deployment -----
UTILS_MARKER = "2025-10-04-bcryptsha256-manual+identify"

# ----- passlib context (hash with bcrypt_sha256; accept legacy bcrypt) -----
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
)

# passlib bcrypt_sha256 format:
# $bcrypt-sha256$v=2,t=2b,r=12$<22char salt>$<31char checksum>
_BCRYPT_SHA256_RE = re.compile(
    r"^\$bcrypt-sha256\$v=(?P<v>\d+),t=(?P<ident>2[aby]),r=(?P<rounds>\d+)\$(?P<salt>[A-Za-z0-9./]{22})\$(?P<chk>[A-Za-z0-9./]{31})$"
)

def bcrypt_sha256_manual_verify(plain: str, hashed: str) -> Optional[bool]:
    """
    Manually verify passlib's bcrypt_sha256 using the 'bcrypt' package.
    Returns True/False if pattern matches, or None if 'hashed' isn't bcrypt_sha256.
    """
    m = _BCRYPT_SHA256_RE.match(hashed or "")
    if not m:
        return None  # not a bcrypt_sha256 hash

    ident  = m.group("ident")   # '2b', '2a', '2y'
    rounds = int(m.group("rounds"))
    salt   = m.group("salt")
    chk    = m.group("chk")

    # Assemble a standard bcrypt MCF so bcrypt.checkpw can evaluate
    assembled = f"${ident}${rounds:02d}${salt}{chk}".encode("ascii")

    # bcrypt_sha256 pre-hashes the password with SHA-256 (raw 32 bytes)
    pw32 = hashlib.sha256((plain or "").encode("utf-8")).digest()

    try:
        return bool(bcrypt.checkpw(pw32, assembled))
    except Exception:
        return False

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain or "")

def verify_password(plain: str, hashed: str) -> bool:
    """
    Prefer manual path for bcrypt_sha256. Fall back to passlib otherwise.
    """
    if hashed and hashed.startswith("$bcrypt-sha256$"):
        manu = bcrypt_sha256_manual_verify(plain, hashed)
        if manu is True:
            return True
        if manu is False:
            return False
        # manu is None => odd format; let passlib try

    try:
        return pwd_context.verify(plain or "", hashed or "")
    except Exception:
        return False

def identify_hash(hashed: Optional[str]) -> str:
    if not hashed:
        return "none"
    if hashed.startswith("$bcrypt-sha256$"):
        return "bcrypt_sha256"
    if hashed.startswith("$2a$") or hashed.startswith("$2b$") or hashed.startswith("$2y$"):
        return "bcrypt"
    return "unknown"

# ----- JWT settings -----
SECRET_KEY = getenv("SECRET_KEY", "CHANGE_ME_IN_ENV")
ALGORITHM = getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

def create_access_token(sub: str, expires_delta: Optional[timedelta] = None) -> str:
    now = datetime.now(tz=timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {"sub": sub, "iat": int(now.timestamp()), "exp": int(expire.timestamp())}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

# ----- Auth dependencies -----
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

async def _token_from_request(
    request: Request, bearer: Optional[str] = Depends(oauth2_scheme)
) -> Optional[str]:
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
