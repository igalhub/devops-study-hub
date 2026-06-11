#!/bin/bash
# Start DevOps Study Hub: backend (uvicorn) + frontend (Vite dev server).
# Ctrl-C stops both.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
    trap - EXIT INT TERM  # prevent re-entry on cascading signals
    echo ""
    echo "Stopping DevOps Study Hub..."
    [[ -n "$MONITOR_PID" ]] && kill "$MONITOR_PID" 2>/dev/null
    [[ -n "$BACKEND_PID" ]]  && kill "$BACKEND_PID"  2>/dev/null
    if [[ -n "$FRONTEND_PID" ]]; then
        kill "$FRONTEND_PID" 2>/dev/null
        # Kill grandchildren too (covers npm → sh → vite hierarchy)
        pkill -P "$FRONTEND_PID" 2>/dev/null
        grandchildren=$(pgrep -P "$FRONTEND_PID" 2>/dev/null)
        [[ -n "$grandchildren" ]] && pkill -P "$grandchildren" 2>/dev/null
    fi
    [[ -n "$BACKEND_PID" ]]  && wait "$BACKEND_PID"  2>/dev/null
    [[ -n "$FRONTEND_PID" ]] && wait "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM


echo "Starting backend..."
cd "$PROJECT_DIR/backend"
"$PROJECT_DIR/.venv/bin/uvicorn" main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

# Probe the root path (/docs) — returns 200 as long as uvicorn is alive,
# regardless of application errors on individual routes
backend_ready=0
for i in {1..20}; do
    if curl -sf http://localhost:8000/docs >/dev/null 2>&1; then
        backend_ready=1
        break
    fi
    sleep 0.5
done

if [[ $backend_ready -eq 0 ]]; then
    echo "ERROR: Backend failed to start after 10s. Check that .venv exists and port 8000 is free."
    exit 1
fi
# Confirm it's our process that's serving — another process may have answered the probe
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "ERROR: Port 8000 is already in use by another process. Stop it and try again."
    exit 1
fi

echo "Starting frontend..."
cd "$PROJECT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

# Wait for Vite to be ready before opening browser (same pattern as backend)
frontend_ready=0
for i in {1..20}; do
    if curl -sf http://localhost:5173 >/dev/null 2>&1; then
        frontend_ready=1
        break
    fi
    sleep 0.5
done

if [[ $frontend_ready -eq 0 ]]; then
    echo "WARNING: Frontend did not respond after 10s — browser will open when Vite is ready."
fi
# Confirm it's our Vite process serving — another process may have answered the probe
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "ERROR: Port 5173 is already in use by another process. Stop it and try again."
    exit 1
fi

# Open browser (xdg-open on Linux, open on macOS)
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:5173 2>/dev/null &
elif command -v open &>/dev/null; then
    open http://localhost:5173 2>/dev/null &
fi

echo "DevOps Study Hub is running at http://localhost:5173"
echo "Press Ctrl-C to stop."

# Background monitor: notify if backend dies while frontend is still running
(
    while kill -0 "$BACKEND_PID" 2>/dev/null; do sleep 2; done
    echo ""
    echo "WARNING: Backend stopped unexpectedly. API calls will fail. Press Ctrl-C to exit."
) &
MONITOR_PID=$!

wait "$BACKEND_PID" "$FRONTEND_PID"
kill "$MONITOR_PID" 2>/dev/null
