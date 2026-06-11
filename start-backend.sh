#!/bin/bash
cd "$(dirname "$0")/backend"
../.venv/bin/uvicorn main:app --host 127.0.0.1 --reload --port 8000
