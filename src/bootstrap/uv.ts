import { spawn } from "child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { requestUrl } from "obsidian";

export interface BackendPaths {
	pythonPath: string;
	sidecarCwd: string;
	llamaServerBin: string;
	chatModelPath: string;
	embedModelPath: string;
	embeddingDimension: number;
}

export interface BootstrapContext {
	/** Bundled sidecar source (`<pluginDir>/sidecar`) — also holds dev .venv/.models. */
	pluginSidecarDir: string;
	/** Shared app-data runtime (uv, venv, models, llama.cpp). */
	runtimeDir: string;
	log: (line: string) => void;
}

// Pinned versions.
const UV_VERSION = "0.11.4";
const LLAMA_BUILD = "b9838";
// Pinned khora release — keep in sync with sidecar/pyproject.toml. The dev
// fast-path verifies the repo-local venv matches this before reusing it, so a
// stale editable checkout can't silently stand in for the shipped version.
const KHORA_VERSION = "0.21.0";
// Bumped whenever the bundled `uru_sidecar` Python changes. The app-data venv is
// reinstalled when the installed copy differs, so pure-Python sidecar fixes reach
// existing users (khora alone wouldn't trigger it — its pin rarely moves).
const SIDECAR_VERSION = "0.2.8";

// Models. The embedding model fixes the vector dimension.
// Chat/extraction: Qwen2.5-3B. A 5-model bake-off (3B/7B, Qwen3-8B, Llama-3.1-8B,
// Gemma-3-1B) found the earlier extraction failures were caused entirely by too
// low an output-token cap, not the model — with a roomy budget the 3B produces
// clean JSON on every chunk while indexing 3-4x faster than any 8B (and staying
// well under the request timeout). The bigger models add only marginally more
// entities at 3-4x the wall-clock, so the 3B is the right default for a local vault.
const CHAT_REPO = "bartowski/Qwen2.5-3B-Instruct-GGUF";
const CHAT_GGUF = "Qwen2.5-3B-Instruct-Q4_K_M.gguf";
// Revision-pinned so a repo update can't silently swap the weights underneath us
// (the embedding model also fixes the vector dimension — drift would corrupt it).
const CHAT_REVISION = "f302c64a2269a69fb27b2f9473b362f5bb8e78d8";
// bge-m3: XLM-RoBERTa-based, 8192-token native context (vs. mxbai's 512) and
// still 1024-dim, so no DB migration needed when swapping from mxbai. Uses
// [CLS] pooling, not mean — see the --pooling flag in uru_sidecar/llama.py.
const EMBED_REPO = "lm-kit/bge-m3-gguf";
const EMBED_FILE = "bge-m3-Q8_0.gguf";
const EMBED_REVISION = "9379ce497e8814b200f2dc0d18eb4045426dcb8c";
const EMBED_CANDIDATES: Array<{ file: string; dim: number }> = [
	{ file: EMBED_FILE, dim: 1024 }, // bge-m3
	{ file: "nomic-embed-text-v1.5.f16.gguf", dim: 768 }, // dev cache fallback
];

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
const venvPython = (venvDir: string) =>
	process.platform === "win32"
		? join(venvDir, "Scripts", "python.exe")
		: join(venvDir, "bin", "python");

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

/** Run a command and resolve with its exit code + combined output (never rejects). */
function capture(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args);
		let out = "";
		const cap = (b: Buffer) => (out += b.toString());
		p.stdout.on("data", cap);
		p.stderr.on("data", cap);
		p.on("error", () => resolve({ code: -1, out }));
		p.on("exit", (code) => resolve({ code: code ?? -1, out }));
	});
}

/**
 * Probe a venv for a healthy install: all three packages importable, and report
 * the installed khora version. Returns null if the interpreter is missing or any
 * import fails — i.e. a partial/failed install that needs repair.
 */
async function probeVersions(py: string): Promise<{ khora: string; sidecar: string } | null> {
	if (!existsSync(py)) return null;
	// Sentinel-prefix the versions so we can pluck them out regardless of any
	// import-time log noise khora writes to stdout/stderr.
	const { code, out } = await capture(py, [
		"-c",
		"import uru_sidecar, huggingface_hub, khora; " +
			"print('KHORA_PROBE=' + khora.__version__); " +
			"print('SIDECAR_PROBE=' + uru_sidecar.__version__)",
	]);
	if (code !== 0) return null;
	const kh = out.match(/KHORA_PROBE=(\S+)/);
	const sc = out.match(/SIDECAR_PROBE=(\S+)/);
	if (!kh || !sc) return null;
	return { khora: kh[1], sidecar: sc[1] };
}

async function download(url: string, dest: string): Promise<void> {
	// Use Obsidian's requestUrl, NOT fetch(). The plugin runs in the Chromium
	// renderer, where fetch() is CORS-bound: GitHub release assets 302-redirect
	// to release-assets.githubusercontent.com, which sends no CORS headers, so a
	// renderer fetch rejects with "Failed to fetch". requestUrl runs in the main
	// process (Electron net) — no CORS, follows redirects, honors system proxies.
	const resp = await requestUrl({ url, method: "GET", throw: false });
	if (resp.status < 200 || resp.status >= 300) {
		throw new Error(`download failed (HTTP ${resp.status}): ${url}`);
	}
	writeFileSync(dest, Buffer.from(resp.arrayBuffer));
}

/** Extract .tar.gz or .zip via bsdtar (`tar -xf`), available on macOS/Linux/Win10+. */
async function extract(archive: string, destDir: string, log: (s: string) => void): Promise<void> {
	mkdirSync(destDir, { recursive: true });
	await run("tar", ["-xf", archive, "-C", destDir], {}, log);
}

/** Shallow-recursive search for a binary by name under `root`. */
function findFile(root: string, name: string, depth = 4): string | null {
	if (!existsSync(root)) return null;
	const want = exe(name);
	const stack: Array<[string, number]> = [[root, 0]];
	while (stack.length) {
		const [dir, d] = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = join(dir, e);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isFile() && e === want) return full;
			if (st.isDirectory() && d < depth) stack.push([full, d + 1]);
		}
	}
	return null;
}

function findModels(modelsDir: string): Pick<BackendPaths, "chatModelPath" | "embedModelPath" | "embeddingDimension"> | null {
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

// ---- asset naming ------------------------------------------------------

function uvAsset(): string {
	const arm = process.arch === "arm64";
	if (process.platform === "darwin") return arm ? "uv-aarch64-apple-darwin.tar.gz" : "uv-x86_64-apple-darwin.tar.gz";
	if (process.platform === "win32") return arm ? "uv-aarch64-pc-windows-msvc.zip" : "uv-x86_64-pc-windows-msvc.zip";
	return arm ? "uv-aarch64-unknown-linux-gnu.tar.gz" : "uv-x86_64-unknown-linux-gnu.tar.gz";
}

function llamaAsset(): string {
	const arm = process.arch === "arm64";
	if (process.platform === "darwin") return `llama-${LLAMA_BUILD}-bin-macos-${arm ? "arm64" : "x64"}.tar.gz`;
	if (process.platform === "win32") return `llama-${LLAMA_BUILD}-bin-win-cpu-${arm ? "arm64" : "x64"}.zip`;
	return `llama-${LLAMA_BUILD}-bin-ubuntu-${arm ? "arm64" : "x64"}.tar.gz`;
}

// ---- component bootstrappers -------------------------------------------

async function ensureUv(runtimeDir: string, log: (s: string) => void): Promise<string> {
	const local = join(runtimeDir, "uv", exe("uv"));
	const candidates = [
		local,
		join(homedir(), ".local", "bin", exe("uv")),
		"/opt/homebrew/bin/uv",
		"/usr/local/bin/uv",
	];
	const found = candidates.find(existsSync);
	if (found) return found;

	log("Downloading uv…");
	const tmp = join(runtimeDir, "tmp");
	mkdirSync(tmp, { recursive: true });
	const asset = uvAsset();
	const archive = join(tmp, asset);
	await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`, archive);
	await extract(archive, join(runtimeDir, "uv"), log);
	const bin = findFile(join(runtimeDir, "uv"), "uv");
	if (!bin) throw new Error("uv binary not found after extraction");
	if (process.platform !== "win32") chmodSync(bin, 0o755);
	return bin;
}

async function ensureLlamaServer(runtimeDir: string, log: (s: string) => void): Promise<string> {
	const root = join(runtimeDir, "llama.cpp");
	const existing = findFile(root, "llama-server");
	if (existing) return existing;

	log("Downloading llama.cpp…");
	const tmp = join(runtimeDir, "tmp");
	mkdirSync(tmp, { recursive: true });
	const asset = llamaAsset();
	const archive = join(tmp, asset);
	await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset}`, archive);
	await extract(archive, root, log);
	if (process.platform === "darwin") {
		// Clear Gatekeeper quarantine so the downloaded binary can run.
		await run("xattr", ["-dr", "com.apple.quarantine", root], {}, () => {}).catch(() => undefined);
	}
	const bin = findFile(root, "llama-server");
	if (!bin) throw new Error("llama-server not found after extraction");
	if (process.platform !== "win32") chmodSync(bin, 0o755);
	return bin;
}

// ---- entrypoint --------------------------------------------------------

/**
 * Resolve a working backend, bootstrapping into the shared app-data runtime if
 * needed. Dev fast-path (repo-local venv + models + llama.cpp) is reused as-is.
 */
export async function ensureBackend(ctx: BootstrapContext): Promise<BackendPaths> {
	const { pluginSidecarDir, runtimeDir, log } = ctx;
	mkdirSync(runtimeDir, { recursive: true });

	// 1) Dev fast path — everything cached in the repo. Only reuse it if the
	// repo-local venv actually has the pinned khora version; otherwise a stale
	// editable checkout would silently stand in for the shipped backend.
	const devPy = venvPython(join(pluginSidecarDir, ".venv"));
	const devModels = findModels(join(pluginSidecarDir, ".models"));
	const devLlama = findFile(join(pluginSidecarDir, ".llamacpp-test"), "llama-server");
	if (existsSync(devPy) && devModels && devLlama) {
		const dev = await probeVersions(devPy);
		if (dev && dev.khora === KHORA_VERSION && dev.sidecar === SIDECAR_VERSION) {
			log("Using repo-local dev backend.");
			return { pythonPath: devPy, sidecarCwd: pluginSidecarDir, llamaServerBin: devLlama, ...devModels };
		}
		log(
			`Repo-local dev backend skipped (khora ${dev?.khora ?? "missing"}/sidecar ${dev?.sidecar ?? "missing"} ` +
				`!= pinned ${KHORA_VERSION}/${SIDECAR_VERSION}); bootstrapping app-data backend.`,
		);
	}

	// 2) Full bootstrap into app-data.
	const uv = await ensureUv(runtimeDir, log);
	const env = { ...process.env };
	const venvDir = join(runtimeDir, "venv");
	const py = venvPython(venvDir);
	if (!existsSync(py)) {
		log("Installing Python 3.13…");
		await run(uv, ["python", "install", "3.13"], { env }, log);
		log("Creating virtual environment…");
		await run(uv, ["venv", "--python", "3.13", venvDir], { env }, log);
	}
	// Verify the deps are actually importable AND up to date — don't gate on the
	// interpreter existing. Reinstall when: (a) a probe fails (partial/broken
	// install — the venv exists but packages don't), or (b) the installed khora
	// or sidecar version differs from what this plugin build ships, so a
	// pure-Python sidecar fix reaches an already-bootstrapped user.
	const installed = await probeVersions(py);
	const stale =
		installed === null ||
		installed.khora !== KHORA_VERSION ||
		installed.sidecar !== SIDECAR_VERSION;
	if (stale) {
		log(
			installed === null
				? "Installing khora + sidecar…"
				: `Updating backend (khora ${installed.khora}→${KHORA_VERSION}, ` +
						`sidecar ${installed.sidecar}→${SIDECAR_VERSION})…`,
		);
		await run(uv, ["pip", "install", "--python", py, "--force-reinstall", pluginSidecarDir], { env }, log);
		if ((await probeVersions(py)) === null) {
			throw new Error(
				"backend dependencies missing after install — `import uru_sidecar/khora/huggingface_hub` failed; check diagnostics.",
			);
		}
	}

	const llamaServerBin = await ensureLlamaServer(runtimeDir, log);

	const modelsDir = join(runtimeDir, "models");
	let models = findModels(modelsDir);
	if (!models) {
		log("Downloading models (~3 GB, one time only)…");
		await run(
			py,
			[
				"-c",
				[
					"from huggingface_hub import hf_hub_download as d",
					`d(${JSON.stringify(CHAT_REPO)}, ${JSON.stringify(CHAT_GGUF)}, revision=${JSON.stringify(CHAT_REVISION)}, local_dir=${JSON.stringify(modelsDir)})`,
					`d(${JSON.stringify(EMBED_REPO)}, ${JSON.stringify(EMBED_FILE)}, revision=${JSON.stringify(EMBED_REVISION)}, local_dir=${JSON.stringify(modelsDir)})`,
				].join("; "),
			],
			{ env },
			log,
		);
		models = findModels(modelsDir);
	}
	if (!models) throw new Error("Model download failed; check diagnostics.");

	log("Backend ready.");
	// uru_sidecar is pip-installed into the venv, so `python -m uru_sidecar`
	// works from any cwd; runtimeDir is a harmless PYTHONPATH.
	return { pythonPath: py, sidecarCwd: runtimeDir, llamaServerBin, ...models };
}
