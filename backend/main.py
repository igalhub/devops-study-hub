from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from db import init_db
from routes.modules import router as modules_router
from routes.progress import router as progress_router
from routes.lessons import router as lessons_router

app = FastAPI(title='DevOps Study Hub API')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5173'],
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.on_event('startup')
def startup():
    init_db()


app.include_router(modules_router)
app.include_router(progress_router)
app.include_router(lessons_router)


@app.get('/health')
def health():
    return {'status': 'ok'}
