from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import router

app = FastAPI(title="Stock & Crypto API", version="1.0.0")

# CORS — keep permissive unless you want to lock to your frontend domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # you can swap this for your frontend URL later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health + tiny root
@app.get("/", include_in_schema=False)
def root():
    return {"ok": True, "service": "stock-backend"}

@app.get("/health", include_in_schema=False)
def health():
    return {"ok": True}

# Mount routers
app.include_router(router)
