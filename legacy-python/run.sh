#!/usr/bin/env bash
# Good Faith Finance — research agent demo.
# Requires Python 3.10+ and nothing else (standard library only).
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi

echo "Starting the research demo on http://localhost:8777 …"
exec "$PY" app.py
