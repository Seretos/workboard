"""
Workboard backend server entry point.

Binds uvicorn to 127.0.0.1:0 (OS-assigned port), prints
BACKEND_PORT=<n> as the very first stdout line (flushed), then serves.

Run in development:
    python -m src.main          (from backend/)

Packaged binary: PyInstaller calls this module directly.
"""

import logging
import sys

import uvicorn
from fastapi import FastAPI

from src.api.health import router as health_router
from src.api.tickets import router as tickets_router
from src.api.worktrees import router as worktrees_router

# INFO-level, timestamped logging to stderr. The Electron main process relays
# every backend stderr line into a persistent log file (see main.ts), so this
# is the only logging configuration needed to get diagnosable, on-disk output
# for hangs/slow requests — there was previously no way to see what a stuck
# poll or worktree operation was doing after the fact.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)

app = FastAPI(title="Workboard Backend")
app.include_router(health_router)
app.include_router(tickets_router)
app.include_router(worktrees_router)


def main() -> None:
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)

    # Bind to an OS-assigned port before starting the server so we can
    # read the actual port number and print it before blocking on serve().
    sock = config.bind_socket()
    port: int = sock.getsockname()[1]

    print(f"BACKEND_PORT={port}", flush=True)

    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
