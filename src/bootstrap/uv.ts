import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface BackendPaths {
	pythonPath: string;
	sidecarCwd: string;
	chatModelPath: string;
	embedModelPath: string;
	embeddingDimension: number;
}

export interface BootstrapContext {
	/** Absolute path to the `sidecar/` package (resolved through the plugin symlink). */
	sidecarDir: string;
	/** Absolute path to the repo root (holds the vendored `khora/`). */
	repoRoot: string;
	/** Writable dir for a created venv / downloaded models (plugin data dir). */
	dataDir: string;
	log: (line: string) => void;
}

// Known model filenames. The embedding model fixes the vector dimension.
const CHAT_GGUF = "Qwen2.5-3B-Instruct-Q4_K_M.gguf";
const EMBED_FILE = "gguf/mxbai-embed-large-v1-f16.gguf";
const EMBED_CANDIDATES: Array<{ file: string; dim: number }> = [
	{ file: EMBED_FILE, dim: 1024 }, // mxbai-embed-large-v1
	{ file: "nomic-embed-text-v1.5.f16.gguf", dim: 768 }, // fallback (dev cache)
];
const CHAT_REPO = "bartowski/Qwen2.5-3B-Instruct-GGUF";
const EMBED_REPO = "mixedbread-ai/mxbai-embed-large-v1";

function run(
	cmd: string,
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv },
	onLine: (s: string) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
		const cap = (b: Buffer) => b.toString().split("\n").forEach((l) => l && onLine(l));
		p.stdout.on("data", cap);
		p.stderr.on("data", cap);
		p.on("error", reject);
		p.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`)),
		);
	});
}

/** Locate a usable `uv` binary (system install or a previously downloaded one). */
function findUv(dataDir: string): string | null {
	const candidates = [
		join(dataDir, "bin", "uv"),
		join(homedir(), ".local", "bin", "uv"),
		"/opt/homebrew/bin/uv",
		"/usr/local/bin/uv",
	];
	return candidates.find(existsSync) ?? null;
}

function findModels(modelsDir: string): Omit<BackendPaths, "pythonPath" | "sidecarCwd"> | null {
	const chat = join(modelsDir, CHAT_GGUF);
	if (!existsSync(chat)) return null;
	for (const cand of EMBED_CANDIDATES) {
		const embed = join(modelsDir, cand.file);
		if (existsSync(embed)) {
			return { chatModelPath: chat, embedModelPath: embed, embeddingDimension: cand.dim };
		}
	}
	return null;
}

const venvPython = (venvDir: string) =>
	process.platform === "win32"
		? join(venvDir, "Scripts", "python.exe")
		: join(venvDir, "bin", "python");

/**
 * Resolve a working backend, bootstrapping with uv if needed.
 *
 * Fast paths first: a dev venv shipped in the repo (`sidecar/.venv`) and cached
 * models (`sidecar/.models`) are reused as-is. Otherwise a venv is created in the
 * plugin data dir and dependencies + models are installed via uv.
 */
export async function ensureBackend(ctx: BootstrapContext): Promise<BackendPaths> {
	const { sidecarDir, repoRoot, dataDir, log } = ctx;

	// 1) Dev fast path — repo-local venv + cached models.
	const devVenvPy = venvPython(join(sidecarDir, ".venv"));
	const devModels = findModels(join(sidecarDir, ".models"));
	if (existsSync(devVenvPy) && devModels) {
		log("Using repo-local venv and cached models.");
		return { pythonPath: devVenvPy, sidecarCwd: sidecarDir, ...devModels };
	}

	// 2) uv bootstrap into the plugin data dir.
	const uv = findUv(dataDir);
	if (!uv) {
		throw new Error(
			"uv not found. Install it (https://docs.astral.sh/uv/) or place it under the plugin data dir, then re-run setup.",
		);
	}
	const venvDir = join(dataDir, "sidecar-venv");
	const py = venvPython(venvDir);
	const env = { ...process.env, SETUPTOOLS_SCM_PRETEND_VERSION: "0.13.0" };

	if (!existsSync(py)) {
		log("Installing Python 3.13 (uv)…");
		await run(uv, ["python", "install", "3.13"], { env }, log);
		log("Creating virtual environment…");
		await run(uv, ["venv", "--python", "3.13", venvDir], { env }, log);
		log("Installing khora + sidecar (this can take a few minutes)…");
		await run(
			uv,
			[
				"pip", "install", "--python", py,
				"-e", `${join(repoRoot, "khora")}[sqlite-lance]`,
				"-e", sidecarDir,
			],
			{ env },
			log,
		);
	}

	// 3) Models.
	const modelsDir = join(dataDir, "models");
	let models = findModels(modelsDir);
	if (!models) {
		log("Downloading models (chat + embedding, ~2.5 GB on first run)…");
		await run(
			py,
			[
				"-c",
				[
					"from huggingface_hub import hf_hub_download as d",
					`d(${JSON.stringify(CHAT_REPO)}, ${JSON.stringify(CHAT_GGUF)}, local_dir=${JSON.stringify(modelsDir)})`,
					`d(${JSON.stringify(EMBED_REPO)}, ${JSON.stringify(EMBED_FILE)}, local_dir=${JSON.stringify(modelsDir)})`,
				].join("; "),
			],
			{ env },
			log,
		);
		models = findModels(modelsDir);
	}
	if (!models) throw new Error("Model download failed; check diagnostics.");

	log("Backend ready.");
	return { pythonPath: py, sidecarCwd: sidecarDir, ...models };
}
