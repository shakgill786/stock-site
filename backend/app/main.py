# backend/app/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import router
from app.db import init_db
from app.auth.router import router as auth_router

app = FastAPI(title="Stock & Crypto API", version="1.0.0")

# =========================
# CORS for SPA + Bearer tokens (NO cookies)
# =========================
# - We don't use cookies right now, so allow_credentials MUST be False.
# - You can keep "*" during development; lock it down later if you want.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,   # ← important: no cookies now
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------------------------------------------
# ❄️ FUTURE: Cookie-based sessions / OAuth (commented out for now)
# -------------------------------------------------------------------
"""
import os
FRONTEND = os.getenv("FRONTEND_ORIGIN", "https://stock-frontend-d1lq.onrender.com")

# If you switch to cookie auth, replace the middleware above with this block:
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND],  # must be explicit, not "*"
    allow_credentials=True,    # cookies on
    allow_methods=["*"],
    allow_headers=["*"],
)

# Example of setting a secure session cookie after login:
# from fastapi import Response
# @app.post("/auth/login")
# def login(creds: LoginModel, response: Response):
#     token = issue_session_token(creds)   # your logic
#     response.set_cookie(
#         "session",
#         value=token,
#         httponly=True,
#         secure=True,
#         samesite="none",   # required for cross-site cookies with https
#         max_age=60*60*24*7
#     )
#     return {"ok": True}
#
# In the frontend, fetch with: credentials: "include".
"""

# ---- lifecycle ----
@app.on_event("startup")
def on_startup():
    init_db()  # create tables if they don't exist

# ---- health / root ----
@app.get("/", include_in_schema=False)
def root():
    return {"ok": True, "service": "stock-backend"}

@app.get("/health", include_in_schema=False)
def health():
    return {"ok": True}

# ---- routers ----
app.include_router(auth_router, prefix="/auth", tags=["Auth"])
app.include_router(router)
