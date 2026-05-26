#!/bin/bash
cd "$(dirname "$0")/backend"
../.venv/bin/uvicorn main:app --reload --port 8000
