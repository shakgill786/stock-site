# backend/app/auth/utils.py
import os
from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth.models import User

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# --- JWT config ---
# Prefer SECRET_KEY, fall back to JWT_SECRET for backwards compatibility
SECRET_KEY = os.getenv("SECRET_KEY") or os.getenv("JWT_SECRET")
if not SECRET_KEY:
    # Fail fast in production so you don't accidentally run with a dev default
    raise RuntimeError(
        "SECRET_KEY (or JWT_SECRET) is not set. "
        "Set a long random value in your service environment."
    )

ALGORITHM = os.getenv("JWT_ALG", "HS256")
ACCESS_TOKEN_MINUTES = int(os.getenv("JWT_EXPIRE_MIN", "60"))
ISSUER = os.getenv("JWT_ISS", "stock-backend")  # can be any stable string/URL for your service

# This is just for the OpenAPI “Authorize” button; your /auth/login returns a JWT as JSON.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def hash_password(p: str) -> str:
    return pwd_ctx.hash(p)

def verify_password(p: str, h: str) -> bool:
    return pwd_ctx.verify(p, h)

def create_access_token(sub: str) -> str:
    """
    Create a short-lived access token with standard claims:
    - sub: subject (user email)
    - iat: issued at (epoch seconds)
    - exp: expiration (epoch seconds)
    - iss: issuer (optional but recommended)
    """
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=ACCESS_TOKEN_MINUTES)
    claims = {
        "sub": sub,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "iss": ISSUER,
    }
    return jwt.encode(claims, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    cred_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        # Require core claims; also verify issuer
        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM],
            options={"require": ["sub", "exp", "iat"]},
            issuer=ISSUER,
        )
        email: str = payload.get("sub")
        if not email:
            raise cred_exc
    except JWTError:
        # Includes ExpiredSignatureError, JWTClaimsError, etc.
        raise cred_exc

    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        raise cred_exc
    return user
