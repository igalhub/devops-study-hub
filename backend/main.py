import os
from dotenv import load_dotenv
load_dotenv()

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from db import init_db
from routes.modules import router as modules_router
from routes.progress import router as progress_router
from routes.lessons import router as lessons_router
from routes.ai import router as ai_router
from routes.sandbox import router as sandbox_router
from routes.quiz import router as quiz_router
from routes.interview import router as interview_router
from routes.notes import router as notes_router
from routes.search import router as search_router
from routes.stats import router as stats_router
from routes.export import router as export_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title='DevOps Study Hub API', lifespan=lifespan)

_cors_origins = os.getenv('CORS_ORIGINS', 'http://localhost:5173').split(',')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins],
    allow_methods=['*'],
    allow_headers=['*'],
)


app.include_router(modules_router)
app.include_router(progress_router)
app.include_router(lessons_router)
app.include_router(ai_router)
app.include_router(sandbox_router)
app.include_router(quiz_router)
app.include_router(interview_router)
app.include_router(notes_router)
app.include_router(search_router)
app.include_router(stats_router)
app.include_router(export_router)


@app.get('/health')
def health():
    return {'status': 'ok'}
