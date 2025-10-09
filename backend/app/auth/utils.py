# app/auth/utils.py
from datetime import datetime, timedelta, timezone
from typing import Optional
from os import getenv
import re
import hashlib

import bcrypt  # from passlib[bcrypt] extra
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth.models import User

# ---- marker so we can see it's live ----
def get_utils_marker() -> str:
    return "2025-10-03-bcryptsha256-retry4-manual"

# ---- Passlib context (still used for hashing & non-bcrypt) ----
pwd_context = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],
    deprecated="auto",
    bcrypt__ident="2b",
    bcrypt__truncate_error=False,
    bcrypt_sha256__truncate_error=False,
)

# Recognize our bcrypt_sha256 envelope:
# $bcrypt-sha256$v=2,t=2b,r=12$<22 salt>$<31 checksum>
_BCRYPT_SHA256_RE = re.compile(
    r"^\$bcrypt-sha256\$v=\d+,t=(?P<t>\w+),r=(?P<r>\d+)\$(?P<salt>[A-Za-z0-9./]{22})\$(?P<chk>[A-Za-z0-9./]{31})$"
)

def identify_hash(hashed: str) -> str:
    try:
        return pwd_context.identify(hashed or "") or "unknown"
    except Exception:
        return "unknown"

def _verify_bcrypt_sha256_manual(password: str, full_hash: str) -> bool:
    """
    Manual verification for $bcrypt-sha256$:
    1) sha256(password).digest()  (raw 32 bytes)
    2) bcrypt.checkpw(digest, reconstructed_bcrypt_hash)
    """
    m = _BCRYPT_SHA256_RE.match(full_hash or "")
    if not m:
        return False
    t = m.group("t")          # usually '2b'
    r = int(m.group("r"))     # rounds (e.g. 12)
    salt = m.group("salt")    # 22 chars
    chk = m.group("chk")      # 31 chars

    # Build canonical bcrypt string: "$2b$12$" + 22 salt + 31 chk
    bcrypt_str = f"${t}${r:02d}${salt}{chk}"
    bcrypt_bytes = bcrypt_str.encode("utf-8")

    # Compute digest of the *password*
    digest = hashlib.sha256((password or "").encode("utf-8")).digest()
    try:
        return bool(bcrypt.checkpw(digest, bcrypt_bytes))
    except Exception:
        return False

def _verify_bcrypt_manual(password: str, full_hash: str) -> bool:
    """
    Manual verification for classic bcrypt ($2b$...):
    bcrypt only considers first 72 bytes.
    """
    try:
        return bool(bcrypt.checkpw((password or "")[:72].encode("utf-8"), (full_hash or "").encode("utf-8")))
    except Exception:
        return False

def hash_password(plain: str) -> str:
    # keep Passlib for *hashing* new passwords
    return pwd_context.hash(plain or "")

def verify_password(plain: str, hashed: str) -> bool:
    """
    Robust verification:
    - Prefer manual paths for bcrypt_sha256 / bcrypt to avoid the 72-byte exception
      coming from the environment's bcrypt build.
    - Fall back to Passlib if the hash isn't one of those.
    """
    h = hashed or ""
    if h.startswith("$bcrypt-sha256$"):
        ok = _verify_bcrypt_sha256_manual(plain or "", h)
        if ok is not False:
            return ok
        # last-chance fallback to passlib
        try:
            return pwd_context.verify(plain or "", h)
        except Exception:
            return False

    if h.startswith("$2b$") or h.startswith("$2a$") or h.startswith("$2y$"):
        ok = _verify_bcrypt_manual(plain or "", h)
        if ok is not False:
            return ok
        try:
            return pwd_context.verify(plain or "", h)
        except Exception:
            return False

    # Non-bcrypt scheme: use passlib normally
    try:
        return pwd_context.verify(plain or "", h)
    except Exception:
        return False

def verify_password_dual(plain: str, hashed: str) -> dict:
    """
    Debug helper so our /_dbg/check_password can show both manual & passlib results.
    """
    scheme = identify_hash(hashed or "")
    out = {
        "scheme": scheme,
        "manual_ok": None,
        "passlib_ok": None,
        "manual_error": None,
        "passlib_error": None,
    }

    # manual
    try:
        if scheme == "bcrypt_sha256" or (hashed or "").startswith("$bcrypt-sha256$"):
            out["manual_ok"] = _verify_bcrypt_sha256_manual(plain or "", hashed or "")
        elif scheme == "bcrypt" or (hashed or "").startswith(("$2b$", "$2a$", "$2y$")):
            out["manual_ok"] = _verify_bcrypt_manual(plain or "", hashed or "")
    except Exception as e:
        out["manual_error"] = f"{type(e).__name__}: {e}"

    # passlib
    try:
        out["passlib_ok"] = pwd_context.verify(plain or "", hashed or "")
    except Exception as e:
        out["passlib_error"] = f"{type(e).__name__}: {e}"

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

# ---- debug used by router ----
def dbg_verify_for_email(db: Session, email: str, password: str) -> dict:
    out = {"email": email, "exists": False}
    user = db.query(User).filter(User.email == email.lower()).first()
    if not user:
        return out
    out["exists"] = True
    out["hash"] = user.password_hash
    out["hash_scheme"] = identify_hash(user.password_hash)
    out["dual"] = verify_password_dual(password, user.password_hash)
    out["verify_ok"] = verify_password(password, user.password_hash)
    return out
