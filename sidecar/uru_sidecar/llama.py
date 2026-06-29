"""Supervise local llama.cpp ``llama-server`` processes.

We run **two single-model** servers — one chat/extraction model, one embedding
model — so each stays resident in memory; a thin proxy (``proxy.py``) fronts both
so khora needs only a single ``OPENAI_API_BASE``.

These are the **official prebuilt llama.cpp binaries** (ggml-org/llama.cpp
releases), not ``llama-cpp-python``: that package is sdist-only and has no
Python-3.13 wheels, so it would compile from source on every install. The
prebuilt binary needs no toolchain and ships per-platform (Metal on macOS arm64,
CPU elsewhere).
"""

from __future__ import annotations

import socket
import subprocess
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
    """A single-model ``llama-server`` subprocess (OpenAI-compatible)."""

    server_bin: Path
    model_path: Path
    work_dir: Path
    alias: str
    embedding: bool = False
    n_ctx: int = 8192
    n_gpu_layers: int = 999  # offload all (ignored by CPU-only builds)
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

    def _args(self) -> list[str]:
        args = [
            str(self.server_bin),
            "--model", str(self.model_path),
            "--host", self.host,
            "--port", str(self.port),
            "--ctx-size", str(self.n_ctx),
            "--n-gpu-layers", str(self.n_gpu_layers),
            "--alias", self.alias,
        ]
        if self.embedding:
            args += ["--embeddings", "--pooling", "mean"]
        return args

    def start(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._log_path = self.work_dir / f"llama-{self.alias}.log"
        log = open(self._log_path, "w")  # noqa: SIM115 — handle owned by the child
        self._proc = subprocess.Popen(self._args(), stdout=log, stderr=subprocess.STDOUT)

    def log_tail(self, n: int = 25) -> str:
        if not self._log_path or not self._log_path.exists():
            return "(no log)"
        return "\n".join(self._log_path.read_text(errors="replace").splitlines()[-n:])

    def wait_ready(self, timeout: float = 240.0) -> None:
        """Block until /health reports the model is loaded."""
        deadline = time.time() + timeout
        url = f"{self.base_url}/health"
        while time.time() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError(
                    f"llama-server '{self.alias}' exited early "
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
            f"llama-server '{self.alias}' not ready in {timeout}s:\n{self.log_tail()}"
        )

    def is_alive(self) -> bool:
        """True while the child process is running."""
        return self._proc is not None and self._proc.poll() is None

    def restart(self) -> None:
        """Re-spawn the server on the same port and block until it's ready.

        Reuses ``self.port`` so the proxy's cached base_url stays valid — callers
        don't have to rewire the OpenAI proxy after a crash recovery.
        """
        self.stop()
        self.start()
        self.wait_ready()

    def stop(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
