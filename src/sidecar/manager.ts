import { type ChildProcess, execFile, spawn } from "child_process";
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

// Must exceed the sidecar's own worst case, or we declare failure while it's
// still legitimately loading: llama.py waits up to 240s per model (chat+embed
// load in parallel), plus khora connect/migrations. Giving up early used to
// leave the (still-loading) sidecar alive to be idle-killed and restart-looped.
const READY_TIMEOUT_MS = 300_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Run a command and resolve with its stdout; rejects on spawn failure or non-zero exit. */
function execCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { encoding: "utf8", windowsHide: true }, (err, stdout) =>
			err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(stdout),
		);
	});
}

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
				srv.close(() => reject(new Error("Couldn't find a free port for the local AI service.")));
			}
		});
	});
}

/** Owns the sidecar child process: spawn, readiness, crash-restart, shutdown. */
export class SidecarManager {
	private proc: ChildProcess | null = null;
	private port = 0;
	private token = "";
	/** Set when spawn itself fails (binary gone, EACCES) — exitCode stays null
	 *  in that case, so awaitReady needs this to fail fast instead of timing out. */
	private spawnError: Error | null = null;
	private stoppedByUs = false;
	private restartAttempts = 0;
	private stderrRing: string[] = [];
	private listeners: StatusListener[] = [];
	private heartbeat: number | null = null;
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
		await this.takeOverExisting(); // kill any prior sidecar group from a stale lock
		this.stoppedByUs = false;
		this.spawnError = null;
		this.port = await pickPort();
		this.token = randomUUID();
		this.client = new SidecarClient(`http://127.0.0.1:${this.port}`, this.token);

		// The auth token travels ONLY via env (URU_TOKEN, read as config.py's
		// --token default) — as a CLI arg it would be world-readable in
		// /proc/<pid>/cmdline on Linux.
		const args = [
			"-m", "uru_sidecar",
			"--port", String(this.port),
			"--db-path", this.spec.dbPath,
			"--llama-server", this.spec.llamaServerPath,
			"--chat-model", this.spec.chatModelPath,
			"--embed-model", this.spec.embedModelPath,
			"--embedding-dimension", String(this.spec.embeddingDimension),
			"--idle-timeout", "120",
		];
		if (this.spec.namespaceId) args.push("--namespace-id", this.spec.namespaceId);

		this.emit("starting", "starting the local AI service");
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

		let health: HealthResponse;
		try {
			health = await this.awaitReady();
		} catch (e) {
			// Startup failed with the child still alive (ready timeout, or the
			// sidecar latched "error" after loading its models) — kill the whole
			// tree or it lingers at multi-GB RSS until Obsidian quits. Marked as
			// stopped-by-us so the exit handler doesn't crash-restart a boot we
			// just declared failed; the caller surfaces the error and the user
			// retries deliberately. (If the child already died on its own, the
			// exit handler has run and its crash-restart proceeds as before.)
			if (this.proc && this.proc.exitCode === null) {
				this.stoppedByUs = true;
				this.killGroup("SIGTERM");
				const proc = this.proc;
				window.setTimeout(() => {
					if (proc.exitCode === null && proc.pid) {
						SidecarManager.killTree(proc.pid, "SIGKILL");
					}
				}, 4_000);
			}
			throw e;
		}
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
	 * a PID recorded in a stale lockfile. Checks the live command line on every
	 * platform — a stale PID must NEVER be killed unverified, because after a
	 * crash/reboot the OS can hand the recorded PID to any innocent process.
	 */
	private static async looksLikeOurs(pid: number): Promise<boolean> {
		try {
			const cmd =
				process.platform === "win32"
					? // pid is validated as an integer by the caller, so interpolation is safe.
						await execCapture("powershell", [
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
						])
					: await execCapture("ps", ["-p", String(pid), "-o", "command="]);
			return /uru_sidecar|llama-server/.test(cmd);
		} catch {
			return false; // no such process — nothing to verify or kill
		}
	}

	/**
	 * POSIX: the llama children are spawned into the sidecar's process group and
	 * survive an uncleaned sidecar death (SIGKILL from the OOM killer, a native
	 * crash) — Linux reaps them via PDEATHSIG, but macOS has no equivalent, so
	 * the group of a dead leader can still hold multi-GB llama servers. If it
	 * still contains our processes (verified by command line), kill the group.
	 * Uses `ps ax` rather than `pgrep -g`, which can't match by pgid on macOS.
	 */
	private static async killOrphanedGroup(pgid: number): Promise<void> {
		if (process.platform === "win32") return; // covered by the kill-on-close Job Object
		try {
			const out = await execCapture("ps", ["ax", "-o", "pgid=,command="]);
			const stillOurs = out.split("\n").some((line) => {
				const m = line.match(/^\s*(\d+)\s+(.*)$/);
				return m !== null && Number(m[1]) === pgid && /uru_sidecar|llama-server/.test(m[2]);
			});
			if (!stillOurs) return;
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				/* group vanished between the check and the kill */
			}
		} catch {
			/* ps unavailable — nothing safe to do */
		}
	}

	/**
	 * Find any live process still referencing this vault's db path, regardless
	 * of the lockfile. Backstop for when the lockfile is stale or missing (e.g.
	 * Obsidian force-quit before the lock could be written or cleared) — without
	 * this, a leftover sidecar+llama-server tree can coexist indefinitely with a
	 * fresh one instead of being replaced. POSIX-only (uses pgrep).
	 */
	private static async findOrphans(dbPath: string): Promise<number[]> {
		if (process.platform === "win32") return [];
		// pgrep -f treats the pattern as an ERE — escape the path's regex
		// metacharacters (".", and "("/"[" legal in vault names would otherwise
		// make the pattern invalid and silently disable this backstop).
		const pattern = dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		try {
			const out = await execCapture("pgrep", ["-f", pattern]);
			return out.split("\n").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
		} catch {
			return []; // pgrep exits non-zero when nothing matches
		}
	}

	/** On startup, terminate any leftover sidecar (+ llama children) for this vault. */
	private async takeOverExisting(): Promise<void> {
		if (existsSync(this.spec.lockPath)) {
			try {
				const { pid } = JSON.parse(readFileSync(this.spec.lockPath, "utf8"));
				if (Number.isInteger(pid)) {
					if (await SidecarManager.looksLikeOurs(pid)) {
						SidecarManager.killTree(pid, "SIGKILL");
					} else {
						// Leader already dead — its llama children may live on in
						// its process group (macOS: no PDEATHSIG).
						await SidecarManager.killOrphanedGroup(pid);
					}
				}
			} catch {
				/* unreadable lock */
			}
			this.clearLock();
		}
		// A matched command line merely *mentions* the db path (e.g. a user
		// inspecting it with sqlite3) — only kill processes verified as ours.
		for (const pid of await SidecarManager.findOrphans(this.spec.dbPath)) {
			if (await SidecarManager.looksLikeOurs(pid)) {
				SidecarManager.killTree(pid, "SIGKILL");
			}
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		// Keeps the sidecar's idle watchdog from self-terminating us, and reflects
		// the sidecar's real health (e.g. a crashed llama child the OS-level
		// process-exit handler can't see) onto the status bar.
		this.heartbeat = window.setInterval(() => void this.pollHealth(), 15_000);
	}

	private async pollHealth(): Promise<void> {
		if (this.stoppedByUs) return;
		const h = await this.client?.health();
		// A null/transient unreachable response is covered by the process-exit
		// handler; only act on an explicit terminal status from the sidecar.
		if (!h) return;
		if (h.status === "ok") this.emit("ok", "");
		else if (h.status === "error") this.emit("error", h.error ?? "service degraded");
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) {
			window.clearInterval(this.heartbeat);
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
		// Without this handler a failed spawn throws an *uncaught* error event in
		// the renderer, and awaitReady spins for the full timeout (exitCode never
		// leaves null when the process never started).
		this.proc?.on("error", (e) => {
			this.spawnError = e;
			this.stderrRing.push(`[manager] failed to launch backend: ${e.message}`);
		});
		const pid = this.proc?.pid;
		this.proc?.on("exit", (code, sig) => {
			// An uncleaned death (OOM SIGKILL, native crash) can leave the llama
			// children alive in the dead leader's group; the lock is cleared just
			// below, so this is the last place that still knows the pgid. Sweep it
			// or every crash-restart cycle stacks two more resident servers.
			if (pid) void SidecarManager.killOrphanedGroup(pid);
			this.clearLock();
			if (this.stoppedByUs) return;
			// Record HOW it died in the diagnostics ring: a signal death (SIGKILL →
			// likely the OOM killer; SIGSEGV/SIGILL → native crash in a compiled dep)
			// produces no Python traceback, so without this line a beta tester's log
			// just stops mid-boot with nothing to distinguish the failure modes.
			const how = `code ${code ?? "?"}${sig ? `, signal ${sig}` : ""}`;
			this.stderrRing.push(`[manager] backend exited (${how})`);
			this.emit("error", `service stopped (${how})`);
			void this.scheduleRestart();
		});
	}

	private async awaitReady(): Promise<HealthResponse> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.spawnError) {
				throw new Error(`The local AI service couldn't launch — ${this.spawnError.message}`);
			}
			if (!this.proc || this.proc.exitCode !== null) {
				throw new Error(`The local AI service stopped during startup:\n${this.diagnostics}`);
			}
			const h = await this.client!.health();
			if (h?.status === "ok") {
				this.restartAttempts = 0;
				this.emit("ok", "");
				return h;
			}
			if (h?.status === "error") {
				throw new Error(`The local AI service failed to start — ${h.error ?? "unknown"}`);
			}
			await sleep(400);
		}
		throw new Error("The local AI service didn't become ready in time.");
	}

	private async scheduleRestart(): Promise<void> {
		if (this.restartAttempts >= RESTART_BACKOFF_MS.length) {
			this.emit("error", `The local AI service crashed and couldn't be restarted:\n${this.diagnostics}`);
			return;
		}
		const delay = RESTART_BACKOFF_MS[this.restartAttempts++];
		this.emit("starting", `restarting in ${delay / 1000}s`);
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
			if (process.platform === "win32") {
				// Windows has no graceful signal — killTree there is taskkill /F,
				// instant death with writes potentially in flight. Give the
				// authenticated /shutdown route a bounded chance to run
				// runtime.stop() (khora disconnect, llama teardown) first. The
				// Promise.race keeps the old rule of never gating the kill on a
				// wedged HTTP round-trip: 2.5s, then we kill regardless.
				await Promise.race([this.client?.shutdown() ?? Promise.resolve(), sleep(2_500)]);
			}
			// Send the kill signal without gating it behind an HTTP round-trip.
			// requestUrl() has no timeout of its own, so if the sidecar's event
			// loop is ever wedged (e.g. a long-running extraction), awaiting
			// /shutdown could stall long enough that Obsidian's own quit sequence
			// moves on without ever giving us the chance to send this signal at
			// all — which is exactly how a detached child gets orphaned. (On
			// POSIX SIGTERM is itself the graceful path; /shutdown below is a
			// courtesy. If Windows' bounded race above already worked, this
			// taskkill lands on a dead pid — harmless.)
			this.killGroup("SIGTERM");
			const timer = window.setTimeout(() => this.killGroup("SIGKILL"), 4_000);
			// Best-effort courtesy so khora gets a clean disconnect if there's time;
			// client.shutdown() already swallows its own errors, and the sidecar's
			// lifespan shutdown handler no-ops a second stop() if SIGTERM's already
			// triggered one.
			if (process.platform !== "win32") void this.client?.shutdown();
			await exited;
			window.clearTimeout(timer);
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
	return new Promise((r) => window.setTimeout(r, ms));
}
