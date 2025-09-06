import os
from datetime import datetime, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from app.db import get_db
from app.auth.models import User

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# envs (set a real secret in production!)
SECRET_KEY = os.getenv("JWT_SECRET", "dev-insecure-secret")
ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = int(os.getenv("JWT_EXPIRE_MIN", "60"))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def hash_password(p: str) -> str:
    return pwd_ctx.hash(p)

def verify_password(p: str, h: str) -> bool:
    return pwd_ctx.verify(p, h)

def create_access_token(sub: str) -> str:
    now = datetime.utcnow()
    exp = now + timedelta(minutes=ACCESS_TOKEN_MINUTES)
    to_encode = {"sub": sub, "iat": int(now.timestamp()), "exp": int(exp.timestamp())}
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    cred_exc = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if not email:
            raise cred_exc
    except JWTError:
        raise cred_exc

    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise cred_exc
    return user
