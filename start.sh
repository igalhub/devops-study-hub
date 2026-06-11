#!/bin/bash
# Start DevOps Study Hub: backend (uvicorn) + frontend (Vite dev server).
# Ctrl-C stops both.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
    echo ""
    echo "Stopping DevOps Study Hub..."
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "Starting backend..."
cd "$PROJECT_DIR/backend"
"$PROJECT_DIR/.venv/bin/uvicorn" main:app --port 8000 &
BACKEND_PID=$!

# Wait for backend to be ready
for i in {1..20}; do
    if curl -sf http://localhost:8000/modules >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

echo "Starting frontend..."
cd "$PROJECT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

# Give Vite a moment then open the browser (xdg-open on Linux, open on macOS)
sleep 2
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:5173 2>/dev/null &
elif command -v open &>/dev/null; then
    open http://localhost:5173 2>/dev/null &
fi

echo "DevOps Study Hub is running at http://localhost:5173"
echo "Press Ctrl-C to stop."

wait "$BACKEND_PID" "$FRONTEND_PID"
