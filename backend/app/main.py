# app/main.py
from fastapi import FastAPI, Response, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app.routes import router as api_router
from app.db import init_db, get_db
from app.auth.router import router as auth_router, login as _login, register as _register
from app.auth import schemas
from app.auth.utils import get_current_user
from app.auth.models import User

# NEW: mount sentiment endpoints
from app.routes_sentiment import router as sentiment_router

app = FastAPI(title="Stock & Crypto API", version="1.0.0")

# ---------------- CORS (Token/Bearer mode: no cookies) ----------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # wide open for token mode
    allow_credentials=False,    # no cookies in token mode
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,
)

# Universal preflight so OPTIONS never 405s behind proxies/CDNs
@app.options("/{rest_of_path:path}", include_in_schema=False)
def _cors_preflight_ok(rest_of_path: str = ""):
    # Starlette's CORSMiddleware adds ACA* headers; we simply return 204.
    return Response(status_code=204)

# ---------------- Lifecycle ----------------
@app.on_event("startup")
def on_startup():
    init_db()

# ---------------- Basic probes ----------------
@app.get("/", include_in_schema=False)
def root():
    return {"ok": True, "service": "stock-backend"}

@app.get("/health", include_in_schema=False)
def health():
    return {"ok": True}

# ---------------- Routers ----------------
# Auth router has NO prefix inside app/auth/router.py; we mount it once here.
app.include_router(auth_router, prefix="/auth", tags=["Auth"])
app.include_router(api_router)
app.include_router(sentiment_router)  # ← sentiment endpoints (/sentiment/*)

# ---------------- Debug (remove later if you like) ----------------
@app.get("/__routes", include_in_schema=False)
def __routes():
    return [{"path": r.path, "methods": sorted(list(r.methods or []))}
            for r in app.router.routes]

# ---------------- TEMP legacy aliases for stale /auth/auth/* ----------------
# These keep older frontend bundles working while caches clear.
# Remove this block once the SPA is confirmed to call /auth/* paths.
@app.post("/auth/auth/login", include_in_schema=False)
def legacy_login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    return _login(payload, db)

@app.post("/auth/auth/register", include_in_schema=False)
def legacy_register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    return _register(payload, db)

@app.post("/__echo", include_in_schema=False)
def __echo(payload: dict):
    # simple success response to test POST + CORS
    return {"ok": True, "got": payload}

@app.get("/auth/auth/me", include_in_schema=False)
def legacy_me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}

# ---------------- Cookie/OAuth scaffold (commented) ----------------
"""
from os import getenv
from fastapi import Request
from fastapi.security import OAuth2AuthorizationCodeBearer
from starlette.responses import RedirectResponse

# If you ever switch to cookie sessions, swap CORS to allow_credentials=True and a single origin:
FRONTEND = getenv("FRONTEND_ORIGIN", "https://stock-frontend-d1lq.onrender.com")
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=[FRONTEND],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
#     max_age=600,
# )

def set_session_cookie(resp: Response, token: str):
    resp.set_cookie(
        key="session", value=token, httponly=True, secure=True,
        samesite="None", max_age=60*60*12, path="/",
    )

def clear_session_cookie(resp: Response):
    resp.delete_cookie("session", path="/")

oauth_scheme = OAuth2AuthorizationCodeBearer(
    authorizationUrl="https://provider.example.com/authorize",
    tokenUrl="https://provider.example.com/token",
    scopes={"openid": "OpenID", "email": "Email"},
)

@app.get("/auth/oauth/login", include_in_schema=False)
def oauth_login():
    return RedirectResponse("https://provider.example.com/authorize?...")

@app.get("/auth/oauth/callback", include_in_schema=False)
def oauth_callback(request: Request):
    internal_jwt = "..."  # create_access_token(...)
    resp = RedirectResponse("/")
    set_session_cookie(resp, internal_jwt)
    return resp

@app.post("/auth/logout", include_in_schema=False)
def logout():
    return {"ok": True}
"""
