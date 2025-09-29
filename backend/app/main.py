# app/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import router as api_router
from app.db import init_db
from app.auth.router import router as auth_router

app = FastAPI(title="Stock & Crypto API", version="1.0.0")

# Token/Bearer mode (no cookies)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,   # no cookies
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,
)

# If you later move to cookie-based sessions, replace the block above with:
"""
from os import getenv
FRONTEND = getenv("FRONTEND_ORIGIN", "https://stock-frontend-d1lq.onrender.com")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND],     # must be explicit when allow_credentials=True
    allow_credentials=True,       # cookies allowed
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,
)
"""


@app.on_event("startup")
def on_startup():
    init_db()

@app.get("/", include_in_schema=False)
def root():
    return {"ok": True, "service": "stock-backend"}

@app.get("/health", include_in_schema=False)
def health():
    return {"ok": True}

# 🔑 Mount once, with prefix here (router itself has no prefix)
app.include_router(auth_router, prefix="/auth", tags=["Auth"])
app.include_router(api_router)

# 🔍 Quick debug to list all mounted routes (remove later if you want)
@app.get("/__routes", include_in_schema=False)
def __routes():
    return [{"path": r.path, "methods": sorted(list(r.methods or []))}
            for r in app.router.routes]

# ===== Optional cookie-based session / OAuth scaffold (commented) =====
"""
from fastapi import Request, Response, Depends
from fastapi.security import OAuth2AuthorizationCodeBearer
from starlette.responses import RedirectResponse
# Example cookie helper:
def set_session_cookie(resp: Response, token: str):
    resp.set_cookie(
        key="session",
        value=token,
        httponly=True,
        secure=True,
        samesite="None",  # required for cross-site cookies with HTTPS
        max_age=60*60*12,
        path="/",
    )

def clear_session_cookie(resp: Response):
    resp.delete_cookie("session", path="/")

# Example OAuth setup (fill in your provider details)
oauth_scheme = OAuth2AuthorizationCodeBearer(
    authorizationUrl="https://provider.example.com/authorize",
    tokenUrl="https://provider.example.com/token",
    scopes={"openid": "OpenID", "email": "Email"},
)

@app.get("/auth/oauth/login", include_in_schema=False)
def oauth_login():
    # redirect user to your provider (build URL with client_id, redirect_uri, scope, state)
    return RedirectResponse("https://provider.example.com/authorize?...")

@app.get("/auth/oauth/callback", include_in_schema=False)
def oauth_callback(request: Request):
    # exchange code for tokens, create local user, issue internal token
    internal_jwt = "..."  # create_access_token(...)
    resp = RedirectResponse("/")  # back to your SPA
    set_session_cookie(resp, internal_jwt)
    return resp

@app.post("/auth/logout", include_in_schema=False)
def logout():
    resp = {"ok": True}
    # If using Response object, clear cookie and return
    # r = JSONResponse(resp); clear_session_cookie(r); return r
    return resp
"""
