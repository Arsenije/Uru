"""Entrypoint: `python -m uru_sidecar --port N --db-path ... --chat-model ... --embed-model ...`.

Serves /health immediately (status="starting") while the heavy stack (two
llama.cpp servers + khora) boots in the background, so the plugin can poll
readiness rather than block on a long startup.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
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
    # The Obsidian/Electron process that spawned us. We're launched detached (own
    # process group) so we survive plugin *reloads* — but that also means a
    # force-quit or crash of Obsidian would orphan us. getppid() flips to 1
    # (launchd/init) the instant we're reparented, so watching it lets us die
    # immediately when Obsidian goes away, without relying on its shutdown path.
    parent_pid = os.getppid()

    async def boot() -> None:
        try:
            await runtime.start()
        except Exception as exc:  # noqa: BLE001 — report via /health, don't crash silently
            log.exception("sidecar startup failed")
            runtime.status = "error"
            runtime.error = str(exc)

    async def parent_watchdog() -> None:
        """Tear down the instant our spawning process (Obsidian) exits.

        Fires on clean quit, force-quit, and crash alike — none of which are
        guaranteed to run the plugin's onunload/stop path. ~2s detection replaces
        the up-to-idle_timeout lag before an orphaned backend would self-clean.
        """
        if parent_pid <= 1:
            return  # already orphaned at startup — nothing meaningful to watch
        while True:
            await asyncio.sleep(2)
            if os.getppid() != parent_pid:
                log.warning("parent %d exited — shutting down backend immediately", parent_pid)
                await runtime.stop()
                os.kill(os.getpid(), signal.SIGTERM)
                return

    async def watchdog() -> None:
        timeout = config.idle_timeout
        if timeout <= 0:
            return
        interval = min(15, timeout)
        while True:
            before = time.time()
            await asyncio.sleep(interval)
            # Wall-clock jump ≫ our sleep ⇒ the machine was suspended (OS sleep).
            # Forgive the gap and skip this cycle's check — otherwise the first
            # tick after wake sees a huge idle span and kills the backend before
            # the plugin's ~15s heartbeat can touch it. time.monotonic()'s
            # behavior across macOS sleep is version-dependent, so trust the wall.
            if time.time() - before > interval * 3:
                runtime.touch()
                continue
            # Never shut down while a request is in flight (e.g. a Deep-mode note
            # whose extraction runs longer than the idle window).
            if runtime.status == "ok" and not runtime.has_inflight() and runtime.idle_seconds() > timeout:
                log.warning("idle %.0fs > %ds — shutting down", runtime.idle_seconds(), timeout)
                await runtime.stop()
                os.kill(os.getpid(), signal.SIGTERM)
                return

    @asynccontextmanager
    async def lifespan(app):
        boot_task = asyncio.create_task(boot())
        dog_task = asyncio.create_task(watchdog())
        parent_task = asyncio.create_task(parent_watchdog())
        sup_task = asyncio.create_task(runtime.run_supervisor())
        try:
            yield
        finally:
            boot_task.cancel()
            dog_task.cancel()
            parent_task.cancel()
            sup_task.cancel()
            if runtime.status != "stopping":
                await runtime.stop()

    app = build_app(runtime)
    app.router.lifespan_context = lifespan

    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
