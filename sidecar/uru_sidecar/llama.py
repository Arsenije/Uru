"""Supervise local llama.cpp OpenAI-compatible inference servers.

We run **two single-model** ``llama_cpp.server`` processes — one chat/extraction
model, one embedding model — so each stays resident in memory. (A single
multi-model server is unusable here: ``llama_cpp.server.LlamaProxy`` evicts and
reloads the model on every alias switch, and khora's extraction interleaves chat
and embedding calls, which would thrash the 2 GB chat model off the GPU on every
call.)

A thin proxy (see ``app.py``) fronts both so khora — which sends every LiteLLM
call to one ``OPENAI_API_BASE`` and never passes a per-call ``api_base`` — needs
only a single base URL.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


def free_port() -> int:
    """Grab an unused 127.0.0.1 TCP port and release it for immediate reuse."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = int(s.getsockname()[1])
    s.close()
    return port


@dataclass
class LlamaServer:
    """A single-model llama.cpp OpenAI-compatible server subprocess."""

    model_path: Path
    work_dir: Path
    alias: str
    embedding: bool = False
    n_ctx: int = 8192
    n_gpu_layers: int = -1  # offload all layers (Metal on Apple Silicon)
    host: str = "127.0.0.1"
    port: int = 0

    _proc: subprocess.Popen | None = None
    _log_path: Path | None = None

    def __post_init__(self) -> None:
        if not self.port:
            self.port = free_port()

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def _config(self) -> dict:
        model: dict = {
            "model": str(self.model_path),
            "model_alias": self.alias,
            "n_ctx": self.n_ctx,
            "n_gpu_layers": self.n_gpu_layers,
        }
        if self.embedding:
            model["embedding"] = True
        # host/port must live in the config file: with --config_file the
        # llama_cpp.server CLI ignores --host/--port and falls back to :8000.
        return {"host": self.host, "port": self.port, "models": [model]}

    def start(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        config_path = self.work_dir / f"llama-{self.alias}.json"
        config_path.write_text(json.dumps(self._config(), indent=2))
        self._log_path = self.work_dir / f"llama-{self.alias}.log"
        log = open(self._log_path, "w")  # noqa: SIM115 — handle owned by the child
        self._proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "llama_cpp.server",
                "--config_file",
                str(config_path),
                "--host",
                self.host,
                "--port",
                str(self.port),
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
        )

    def log_tail(self, n: int = 25) -> str:
        if not self._log_path or not self._log_path.exists():
            return "(no log)"
        return "\n".join(self._log_path.read_text(errors="replace").splitlines()[-n:])

    def wait_ready(self, timeout: float = 240.0) -> None:
        """Block until the HTTP server answers /v1/models (model loads lazily)."""
        deadline = time.time() + timeout
        url = f"{self.base_url}/v1/models"
        while time.time() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError(
                    f"llama server '{self.alias}' exited early "
                    f"(code {self._proc.returncode}):\n{self.log_tail()}"
                )
            try:
                with urllib.request.urlopen(url, timeout=2) as r:  # noqa: S310 — localhost
                    if r.status == 200:
                        return
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.5)
        raise TimeoutError(
            f"llama server '{self.alias}' not ready in {timeout}s:\n{self.log_tail()}"
        )

    def stop(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
