import { type ChildProcess, execFileSync, spawn } from "child_process";
import { createServer } from "net";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { SidecarClient, type HealthResponse } from "./client";

export interface SidecarLaunchSpec {
	/** Python interpreter inside the bootstrapped uv venv. */
	pythonPath: string;
	/** Working dir for `python -m uru_sidecar` (the sidecar repo root in dev). */
	cwd: string;
	dbPath: string;
	llamaServerPath: string;
	chatModelPath: string;
	embedModelPath: string;
	embeddingDimension: number;
	namespaceId: string | null;
	/** Path for the single-instance lockfile. */
	lockPath: string;
}

type StatusListener = (status: HealthResponse["status"], detail: string) => void;

const READY_TIMEOUT_MS = 120_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Picks a free 127.0.0.1 TCP port by binding to :0 and releasing it. */
function pickPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const { port } = addr;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("could not determine port")));
			}
		});
	});
}

/** Owns the sidecar child process: spawn, readiness, crash-restart, shutdown. */
export class SidecarManager {
	private proc: ChildProcess | null = null;
	private port = 0;
	private token = "";
	private stoppedByUs = false;
	private restartAttempts = 0;
	private stderrRing: string[] = [];
	private listeners: StatusListener[] = [];
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	client: SidecarClient | null = null;

	constructor(private spec: SidecarLaunchSpec) {}

	onStatus(fn: StatusListener): void {
		this.listeners.push(fn);
	}

	private emit(status: HealthResponse["status"], detail = ""): void {
		for (const fn of this.listeners) fn(status, detail);
	}

	get diagnostics(): string {
		return this.stderrRing.join("\n");
	}

	/** Spawn the sidecar and resolve once /health reports a terminal state. */
	async start(): Promise<HealthResponse> {
		this.takeOverExisting(); // kill any prior sidecar group from a stale lock
		this.stoppedByUs = false;
		this.port = await pickPort();
		this.token = randomUUID();
		this.client = new SidecarClient(`http://127.0.0.1:${this.port}`, this.token);

		const args = [
			"-m", "uru_sidecar",
			"--port", String(this.port),
			"--token", this.token,
			"--db-path", this.spec.dbPath,
			"--llama-server", this.spec.llamaServerPath,
			"--chat-model", this.spec.chatModelPath,
			"--embed-model", this.spec.embedModelPath,
			"--embedding-dimension", String(this.spec.embeddingDimension),
			"--idle-timeout", "120",
		];
		if (this.spec.namespaceId) args.push("--namespace-id", this.spec.namespaceId);

		this.emit("starting", "launching backend");
		// POSIX detached: the sidecar leads its own process group, so killing -pid
		// takes down the sidecar AND its llama.cpp children together (no orphans).
		// On Windows detached does nothing useful here (killTree shells out to
		// taskkill /T, not a group kill) AND it forces python.exe to own no
		// console, so its console-subsystem llama children each pop a cmd window;
		// worse, windowsHide has never worked alongside detached. So: not detached
		// on Windows, windowsHide instead (a no-op on POSIX). The llama children's
		// own windows are separately suppressed via CREATE_NO_WINDOW in llama.py,
		// and their lifetime is bound by a kill-on-close Job Object there.
		const isWin = process.platform === "win32";
		this.proc = spawn(this.spec.pythonPath, args, {
			cwd: this.spec.cwd,
			env: { ...process.env, URU_TOKEN: this.token, PYTHONPATH: this.spec.cwd },
			detached: !isWin,
			windowsHide: true,
		});
		this.writeLock();
		this.wireProcessEvents();

		const health = await this.awaitReady();
		this.startHeartbeat();
		return health;
	}

	/** Kill an entire process tree by pid (sidecar + its llama children). */
	private static killTree(pid: number, signal: NodeJS.Signals): void {
		if (process.platform === "win32") {
			// No process groups on Windows; taskkill walks the tree (/T).
			// windowsHide keeps taskkill.exe from flashing its own console window.
			try {
				spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			} catch {
				/* already gone */
			}
			return;
		}
		try {
			process.kill(-pid, signal); // negative pid = process group (detached)
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				/* already gone */
			}
		}
	}

	/** Kill the entire sidecar process group/tree (sidecar + llama children). */
	private killGroup(signal: NodeJS.Signals): void {
		const pid = this.proc?.pid;
		if (pid) SidecarManager.killTree(pid, signal);
	}

	/**
	 * True if `pid` is actually one of our own processes (uru_sidecar or its
	 * llama-server children), not some unrelated process that happens to reuse
	 * a PID recorded in a stale lockfile. POSIX-only — Windows' taskkill /T
	 * walks the real parent/child tree instead of trusting a bare PID match.
	 */
	private static looksLikeOurs(pid: number): boolean {
		try {
			const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
			return /uru_sidecar|llama-server/.test(cmd);
		} catch {
			return false; // no such process — nothing to verify or kill
		}
	}

	/**
	 * Find any live process still referencing this vault's db path, regardless
	 * of the lockfile. Backstop for when the lockfile is stale or missing (e.g.
	 * Obsidian force-quit before the lock could be written or cleared) — without
	 * this, a leftover sidecar+llama-server tree can coexist indefinitely with a
	 * fresh one instead of being replaced. POSIX-only (uses pgrep).
	 */
	private static findOrphans(dbPath: string): number[] {
		if (process.platform === "win32") return [];
		try {
			const out = execFileSync("pgrep", ["-f", dbPath], { encoding: "utf8" });
			return out.split("\n").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
		} catch {
			return []; // pgrep exits non-zero when nothing matches
		}
	}

	/** On startup, terminate any leftover sidecar (+ llama children) for this vault. */
	private takeOverExisting(): void {
		if (existsSync(this.spec.lockPath)) {
			try {
				const { pid } = JSON.parse(readFileSync(this.spec.lockPath, "utf8"));
				if (typeof pid === "number" && (process.platform === "win32" || SidecarManager.looksLikeOurs(pid))) {
					SidecarManager.killTree(pid, "SIGKILL");
				}
			} catch {
				/* unreadable lock */
			}
			this.clearLock();
		}
		for (const pid of SidecarManager.findOrphans(this.spec.dbPath)) {
			SidecarManager.killTree(pid, "SIGKILL");
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		// Keeps the sidecar's idle watchdog from self-terminating us, and reflects
		// the sidecar's real health (e.g. a crashed llama child the OS-level
		// process-exit handler can't see) onto the status bar.
		this.heartbeat = setInterval(() => void this.pollHealth(), 15_000);
	}

	private async pollHealth(): Promise<void> {
		if (this.stoppedByUs) return;
		const h = await this.client?.health();
		// A null/transient unreachable response is covered by the process-exit
		// handler; only act on an explicit terminal status from the sidecar.
		if (!h) return;
		if (h.status === "ok") this.emit("ok", `namespace ${h.namespace_id ?? "?"}`);
		else if (h.status === "error") this.emit("error", h.error ?? "backend degraded");
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}

	private wireProcessEvents(): void {
		const capture = (buf: Buffer) => {
			for (const line of buf.toString().split("\n")) {
				if (!line) continue;
				this.stderrRing.push(line);
				if (this.stderrRing.length > 400) this.stderrRing.shift();
			}
		};
		this.proc?.stdout?.on("data", capture);
		this.proc?.stderr?.on("data", capture);
		this.proc?.on("exit", (code, sig) => {
			this.clearLock();
			if (this.stoppedByUs) return;
			// Record HOW it died in the diagnostics ring: a signal death (SIGKILL →
			// likely the OOM killer; SIGSEGV/SIGILL → native crash in a compiled dep)
			// produces no Python traceback, so without this line a beta tester's log
			// just stops mid-boot with nothing to distinguish the failure modes.
			const how = `code ${code ?? "?"}${sig ? `, signal ${sig}` : ""}`;
			this.stderrRing.push(`[manager] backend exited (${how})`);
			this.emit("error", `backend exited (${how})`);
			void this.scheduleRestart();
		});
	}

	private async awaitReady(): Promise<HealthResponse> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (!this.proc || this.proc.exitCode !== null) {
				throw new Error(`backend exited during startup:\n${this.diagnostics}`);
			}
			const h = await this.client!.health();
			if (h?.status === "ok") {
				this.restartAttempts = 0;
				this.emit("ok", `namespace ${h.namespace_id ?? "?"}`);
				return h;
			}
			if (h?.status === "error") {
				throw new Error(`the local AI service failed to start: ${h.error ?? "unknown"}`);
			}
			await sleep(400);
		}
		throw new Error("backend did not become ready in time");
	}

	private async scheduleRestart(): Promise<void> {
		if (this.restartAttempts >= RESTART_BACKOFF_MS.length) {
			this.emit("error", `backend crashed and could not be restarted:\n${this.diagnostics}`);
			return;
		}
		const delay = RESTART_BACKOFF_MS[this.restartAttempts++];
		this.emit("starting", `restarting backend in ${delay / 1000}s`);
		await sleep(delay);
		if (this.stoppedByUs) return;
		try {
			await this.start();
		} catch {
			void this.scheduleRestart();
		}
	}

	/** Graceful shutdown: ask the sidecar to flush + exit, then kill the group. */
	async stop(): Promise<void> {
		this.stoppedByUs = true;
		this.stopHeartbeat();
		const proc = this.proc;
		if (proc && proc.exitCode === null) {
			const exited = new Promise<void>((res) => proc.once("exit", () => res()));
			// Send the kill signal FIRST and synchronously — don't gate it behind
			// an HTTP round-trip. requestUrl() has no timeout of its own, so if the
			// sidecar's event loop is ever wedged (e.g. a long-running extraction),
			// awaiting /shutdown first could stall long enough that Obsidian's own
			// quit sequence moves on without ever giving us the chance to send this
			// signal at all — which is exactly how a detached child gets orphaned.
			this.killGroup("SIGTERM");
			const timer = setTimeout(() => this.killGroup("SIGKILL"), 4_000);
			// Best-effort courtesy so khora gets a clean disconnect if there's time;
			// client.shutdown() already swallows its own errors, and the sidecar's
			// lifespan shutdown handler no-ops a second stop() if SIGTERM's already
			// triggered one.
			void this.client?.shutdown();
			await exited;
			clearTimeout(timer);
		} else if (this.client) {
			await this.client.shutdown();
		}
		this.proc = null;
		this.clearLock();
	}

	// ---- single-instance lock -------------------------------------------

	private writeLock(): void {
		writeFileSync(
			this.spec.lockPath,
			JSON.stringify({ pid: this.proc?.pid, port: this.port }),
		);
	}

	private clearLock(): void {
		try {
			if (existsSync(this.spec.lockPath)) unlinkSync(this.spec.lockPath);
		} catch {
			/* ignore */
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
