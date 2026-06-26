"""Entrypoint: `python -m uru_sidecar --port N --db-path ... --chat-model ... --embed-model ...`.

Serves /health immediately (status="starting") while the heavy stack (two
llama.cpp servers + khora) boots in the background, so the plugin can poll
readiness rather than block on a long startup.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn

from .app import build_app
from .config import SidecarConfig
from .lifecycle import SidecarRuntime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("uru.sidecar")


def main() -> None:
    config = SidecarConfig.from_args()
    runtime = SidecarRuntime(config)

    async def boot() -> None:
        try:
            await runtime.start()
        except Exception as exc:  # noqa: BLE001 — report via /health, don't crash silently
            log.exception("sidecar startup failed")
            runtime.status = "error"
            runtime.error = str(exc)

    @asynccontextmanager
    async def lifespan(app):
        boot_task = asyncio.create_task(boot())
        try:
            yield
        finally:
            boot_task.cancel()
            if runtime.status != "stopping":
                await runtime.stop()

    app = build_app(runtime)
    app.router.lifespan_context = lifespan

    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
