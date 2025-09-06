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

# Namespace all endpoints under /auth
router = APIRouter(prefix="/auth", tags=["Auth"])

@router.post("/register", response_model=schemas.TokenOut, status_code=status.HTTP_201_CREATED, summary="Create account")
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    email = payload.email.lower()
    exists = db.query(User).filter(User.email == email).first()
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)  # ensure we have ID populated
    token = create_access_token(sub=user.email)
    return {"access_token": token, "token_type": "bearer"}

@router.post("/login", response_model=schemas.TokenOut, summary="Login (email+password)")
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    email = payload.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    token = create_access_token(sub=user.email)
    return {"access_token": token, "token_type": "bearer"}

@router.get("/me", response_model=schemas.UserOut, summary="Who am I?")
def me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}
