import { type ChildProcess, spawn } from "child_process";
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
	chatModelPath: string;
	embedModelPath: string;
	embeddingDimension: number;
	namespaceId: string | null;
	extractEntities: boolean;
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
		if (this.lockHeldByLiveProcess()) {
			throw new Error(
				"Another Uru sidecar is already running for this vault (lockfile present). " +
					"Close other windows of this vault or remove the lockfile.",
			);
		}
		this.stoppedByUs = false;
		this.port = await pickPort();
		this.token = randomUUID();
		this.client = new SidecarClient(`http://127.0.0.1:${this.port}`, this.token);

		const args = [
			"-m", "uru_sidecar",
			"--port", String(this.port),
			"--token", this.token,
			"--db-path", this.spec.dbPath,
			"--chat-model", this.spec.chatModelPath,
			"--embed-model", this.spec.embedModelPath,
			"--embedding-dimension", String(this.spec.embeddingDimension),
		];
		if (this.spec.namespaceId) args.push("--namespace-id", this.spec.namespaceId);
		if (!this.spec.extractEntities) args.push("--no-extract-entities");

		this.emit("starting", "launching backend");
		this.proc = spawn(this.spec.pythonPath, args, {
			cwd: this.spec.cwd,
			env: { ...process.env, URU_TOKEN: this.token, PYTHONPATH: this.spec.cwd },
		});
		this.writeLock();
		this.wireProcessEvents();

		return this.awaitReady();
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
		this.proc?.on("exit", (code) => {
			this.clearLock();
			if (this.stoppedByUs) return;
			this.emit("error", `backend exited (code ${code ?? "?"})`);
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
				throw new Error(`backend failed to start: ${h.error ?? "unknown"}`);
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

	/** Graceful shutdown: ask the sidecar to flush + exit, then force-kill. */
	async stop(): Promise<void> {
		this.stoppedByUs = true;
		if (this.client) await this.client.shutdown();
		const proc = this.proc;
		if (proc && proc.exitCode === null) {
			const exited = new Promise<void>((res) => proc.once("exit", () => res()));
			const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
			await exited;
			clearTimeout(timer);
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

	private lockHeldByLiveProcess(): boolean {
		if (!existsSync(this.spec.lockPath)) return false;
		try {
			const { pid } = JSON.parse(readFileSync(this.spec.lockPath, "utf8"));
			if (typeof pid !== "number") return false;
			process.kill(pid, 0); // throws if the pid is gone
			return true;
		} catch {
			this.clearLock(); // stale lock
			return false;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
