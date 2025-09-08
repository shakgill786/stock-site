# app/db.py
import os
import importlib.util
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# 1) Read from env. On Render, set Environment Variable:
#    DATABASE_URL = postgresql://<user>:<pass>@<host>/<db>
RAW_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

def _normalize_db_url(url: str) -> str:
    """
    Make sure SQLAlchemy knows which driver to use for Postgres.
    - Prefer psycopg2 if installed, else psycopg (psycopg3).
    - Accept postgres:// or postgresql:// and rewrite to postgresql+<driver>://
    """
    if url.startswith("sqlite"):
        return url

    # Decide driver dynamically
    driver = "psycopg2" if importlib.util.find_spec("psycopg2") else (
        "psycopg" if importlib.util.find_spec("psycopg") else None
    )

    # If we don't find a driver, leave as-is; engine creation will error with a clear message.
    if not driver:
        return url

    # Normalize scheme for SQLAlchemy
    if url.startswith("postgres://"):
        url = url.replace("postgres://", f"postgresql+{driver}://", 1)
    elif url.startswith("postgresql://") and "+psycopg" not in url and "+psycopg2" not in url:
        url = url.replace("postgresql://", f"postgresql+{driver}://", 1)

    return url

DATABASE_URL = _normalize_db_url(RAW_URL)

# 2) Connect args: only needed for SQLite's threading limitation
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

# 3) Engine with sensible Render defaults
# - pool_pre_ping: avoid stale connections after idling/sleep
# - pool_recycle: recycle connections periodically (in seconds)
engine = create_engine(
    DATABASE_URL,
    future=True,
    echo=False,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_recycle=300,   # 5 minutes
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    """
    Create tables on startup. Make sure ALL your models import Base from this module:
        from app.db import Base
    so the metadata is shared.
    """
    # Import models so they register with Base.metadata before create_all runs
    from app.auth import models as _auth_models  # noqa: F401
    # import other model modules as needed, e.g. from app.stocks import models as _stock_models

    Base.metadata.create_all(bind=engine)
