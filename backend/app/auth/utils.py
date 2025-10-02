# app/auth/utils.py
from datetime import datetime, timedelta, timezone
import os
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth.models import User

# -------------------- Password hashing --------------------
# Default to bcrypt_sha256 (safe for long inputs), still accept legacy bcrypt ($2b$)
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
    # bcrypt impl details / sane defaults:
    bcrypt__rounds=12,
    bcrypt__ident="2b",
    # If someone accidentally passes >72 bytes to *bcrypt*, don't crash.
    bcrypt__truncate_error=False,
)

def hash_password(password: str) -> str:
    """
    Hash a password for storage. Uses bcrypt_sha256 so there is no 72-byte limit footgun.
    """
    if not isinstance(password, str) or not password:
        raise ValueError("password required")
    return pwd_context.hash(password)  # default scheme = first in list (bcrypt_sha256)

def verify_password(plain_password: str, password_hash: str) -> bool:
    """
    Verify a password against a stored hash.
    - Works for both legacy bcrypt ($2b$…) and new bcrypt_sha256 hashes.
    - Does NOT append any pepper/secret to the user-entered password.
    """
    if not isinstance(plain_password, str) or not password_hash:
        return False
    try:
        return pwd_context.verify(plain_password, password_hash)
    except Exception:
        # Any unexpected error should be treated as a simple mismatch
        # to avoid 500s on login.
        return False

# -------------------- JWT / Auth --------------------
SECRET_KEY: str = os.getenv("SECRET_KEY") or "change-me-in-prod"
ALGORITHM: str = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def create_access_token(*, sub: str, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a short-lived access token with a subject (typically the user's email).
    """
    to_encode = {"sub": sub}
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def _get_user_by_email(db: Session, email: str) -> Optional[User]:
    if not email:
        return None
    return db.query(User).filter(User.email == email.lower()).first()

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """
    Bearer token -> current User (raises 401 if invalid).
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub: Optional[str] = payload.get("sub")
        if sub is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = _get_user_by_email(db, sub)
    if user is None:
        raise credentials_exception
    return user
