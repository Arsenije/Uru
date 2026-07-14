"""Supervise local llama.cpp ``llama-server`` processes.

We run **two single-model** servers — one chat model, one embedding
model — so each stays resident in memory; a thin proxy (``proxy.py``) fronts both
so khora needs only a single ``OPENAI_API_BASE``.

These are the **official prebuilt llama.cpp binaries** (ggml-org/llama.cpp
releases), not ``llama-cpp-python``: that package is sdist-only and has no
Python-3.13 wheels, so it would compile from source on every install. The
prebuilt binary needs no toolchain and ships per-platform (Metal on macOS arm64,
CPU elsewhere).
"""

from __future__ import annotations

import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

# Linux: make each llama-server die with this process (PR_SET_PDEATHSIG). When
# this python process dies without running cleanup — SIGKILL from the OOM
# killer, a native SIGSEGV in a compiled dependency — both llama servers
# (several GB RSS) would otherwise outlive it as orphans: the plugin clears the
# lockfile on exit before restarting, and its pgrep backstop matches the vault
# db path, which never appears on a llama-server command line. Each
# crash-restart cycle then stacks two more resident servers, ratcheting memory
# pressure until startup can't succeed at all. The libc handle is loaded here
# in the parent because ``preexec_fn`` runs in the forked child before exec,
# where imports/allocations are unsafe. macOS has no PDEATHSIG; there the
# plugin's process-group kill covers every managed shutdown path.
if sys.platform == "linux":
    import ctypes

    _LIBC = ctypes.CDLL("libc.so.6", use_errno=True)
    _PR_SET_PDEATHSIG = 1  # linux/prctl.h

    def _die_with_parent() -> None:
        _LIBC.prctl(_PR_SET_PDEATHSIG, int(signal.SIGKILL))
else:
    # preexec_fn is POSIX-only; passing a non-None value on Windows raises.
    _die_with_parent = None


# Windows: llama-server is a console-subsystem exe, and the plugin spawns our
# python.exe with no console to inherit (see src/sidecar/manager.ts). Without
# CREATE_NO_WINDOW, Windows allocates a fresh console *window* for each server —
# one per model (chat + embed), plus a new one on every crash-restart. stdout
# and stderr already go to a logfile, so the console has no job to do;
# CREATE_NO_WINDOW still gives the child a console *object* (file redirection
# stays sane), just never a visible window. Zero elsewhere (a no-op flag).
_CREATION_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    # Windows equivalent of Linux PR_SET_PDEATHSIG (above): a Job Object with
    # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The kernel kills every process in the
    # job the moment the last handle to it closes — which happens when this
    # python process exits for ANY reason, including TerminateProcess or a native
    # crash that runs no cleanup. Without it, an uncleaned sidecar death orphans
    # the llama servers (several GB RSS each), and each crash-restart stacks two
    # more until startup can't succeed. This is strictly better than the plugin's
    # taskkill /T backstop, which can miss a tree that's already been reparented.
    # One shared job holds every llama child; the handle is kept referenced for
    # the process lifetime by the module global (closing it early would kill the
    # servers), and the OS closes it during process teardown.
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    _JobObjectExtendedLimitInformation = 9

    class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", _IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _kernel32 = ctypes.WinDLL("kernel32", use_errno=True)
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    _kernel32.SetInformationJobObject.restype = wintypes.BOOL
    _kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
    ]
    _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    _JOB_HANDLE: int | None = None

    def _job_handle() -> int | None:
        """Lazily create the shared kill-on-close job; None if unavailable."""
        global _JOB_HANDLE
        if _JOB_HANDLE is None:
            job = _kernel32.CreateJobObjectW(None, None)
            if not job:
                return None
            info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not _kernel32.SetInformationJobObject(
                job, _JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
            ):
                _kernel32.CloseHandle(job)
                return None
            _JOB_HANDLE = job
        return _JOB_HANDLE

    def _assign_to_job(proc: subprocess.Popen) -> None:
        """Best-effort: put a spawned llama child in the kill-on-close job.

        On Win8+ a process can belong to nested jobs, so this composes with the
        job libuv puts our python.exe in. Failure is non-fatal — the plugin's
        taskkill /T shutdown path still covers the managed case.
        """
        job = _job_handle()
        if job:
            _kernel32.AssignProcessToJobObject(job, int(proc._handle))

else:
    def _assign_to_job(proc: subprocess.Popen) -> None:  # noqa: ARG001 — POSIX no-op
        pass


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
            # bge-m3 is trained with [CLS]-token pooling for its dense embedding,
            # not mean pooling — using mean here would silently degrade retrieval
            # quality without erroring.
            #
            # --ubatch-size matters more than the model's own context limit: llama-server
            # processes an embedding request's whole input in one non-causal physical
            # batch (unlike causal chat prefill, which it can chunk across micro-batches
            # transparently), and defaults --ubatch-size to 512 regardless of --ctx-size.
            # Without raising it here, any chunk over ~512 tokens is rejected outright —
            # this bit even bge-m3 (trained for 8192 tokens) until it was added.
            args += [
                "--embeddings", "--pooling", "cls",
                "--ubatch-size", str(self.n_ctx),
            ]
        return args

    def start(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._log_path = self.work_dir / f"llama-{self.alias}.log"
        log = open(self._log_path, "w")  # noqa: SIM115 — handle owned by the child
        self._proc = subprocess.Popen(
            self._args(),
            stdout=log,
            stderr=subprocess.STDOUT,
            preexec_fn=_die_with_parent,
            creationflags=_CREATION_FLAGS,
        )
        _assign_to_job(self._proc)

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
            self._proc.wait()  # reap — otherwise the child lingers as a zombie
