import { spawn } from "child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { requestUrl } from "obsidian";
import {
	detectGpu,
	hasGpuDevice,
	llamaAssetName,
	variantForAsset,
	type GpuVendor,
	type LlamaVariant,
} from "./gpu";
import sidecarFiles from "virtual:sidecar-files";

export interface BackendPaths {
	pythonPath: string;
	sidecarCwd: string;
	llamaServerBin: string;
	chatModelPath: string;
	embedModelPath: string;
	embeddingDimension: number;
}

export interface BootstrapContext {
	/**
	 * Repo sidecar dir (`<pluginDir>/sidecar`) — exists only in dev, where the
	 * plugin dir links to the repo; it holds the dev .venv/.models fast path.
	 * Production installs ship no such folder: the sidecar source is embedded
	 * in main.js (virtual:sidecar-files) and staged into app-data at install.
	 */
	pluginSidecarDir: string;
	/** Shared app-data runtime (uv, venv, models, llama.cpp). */
	runtimeDir: string;
	log: (line: string) => void;
}

// Pinned versions.
const UV_VERSION = "0.11.4";
const LLAMA_BUILD = "b9838";
// Pinned khora release — injected at build time from sidecar/pyproject.toml
// (the single source of truth; see scripts/khora-pin.mjs), so this constant
// can't drift from what pip actually installs. The dev fast-path verifies the
// repo-local venv matches this before reusing it, so a stale editable checkout
// can't silently stand in for the shipped version.
declare const __KHORA_VERSION__: string;
const KHORA_VERSION = __KHORA_VERSION__;
// Bumped whenever the bundled `uru_sidecar` Python changes. The app-data venv is
// reinstalled when the installed copy differs, so pure-Python sidecar fixes reach
// existing users (khora alone wouldn't trigger it — its pin rarely moves).
const SIDECAR_VERSION = "0.3.0";

// Models. The embedding model fixes the vector dimension.
// Chat: Qwen2.5-3B. A 5-model bake-off (3B/7B, Qwen3-8B, Llama-3.1-8B, Gemma-3-1B)
// found the 3B answers as reliably as any 8B at 3-4x the speed on local hardware,
// so it's the right default for a local vault.
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
		// windowsHide: uv/python are console-subsystem exes; without this each
		// first-run bootstrap step flashes a cmd window in the user's face.
		const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
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
		const p = spawn(cmd, args, { windowsHide: true });
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
		throw new Error(`Download failed (HTTP ${resp.status}) — ${url}`);
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

function llamaAsset(gpu: GpuVendor): string {
	return llamaAssetName(process.platform, process.arch, gpu, LLAMA_BUILD);
}

// ---- component bootstrappers -------------------------------------------

/**
 * Materialize the embedded sidecar source (bundled into main.js — a
 * community-directory install ships no sidecar/ folder) into app-data so uv
 * can pip-install it. Rebuilt from scratch on every (re)install so a file
 * removed from the package can't linger from a previous plugin version.
 */
function stageSidecarSource(runtimeDir: string): string {
	const dir = join(runtimeDir, "sidecar-src");
	rmSync(dir, { recursive: true, force: true });
	for (const [rel, contents] of Object.entries(sidecarFiles)) {
		const dest = join(dir, ...rel.split("/"));
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, contents);
	}
	return dir;
}

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
	if (!bin) throw new Error("uv binary not found after extraction.");
	if (process.platform !== "win32") chmodSync(bin, 0o755);
	return bin;
}

/** A prior Vulkan probe on this host found no usable GPU device; stay on CPU so
 *  bootstrap converges instead of re-downloading the Vulkan build each launch. */
function vulkanMarker(runtimeDir: string): string {
	return join(runtimeDir, ".llama-vulkan-unavailable");
}

/** Classify an already-installed build and return its llama-server path. A
 *  Vulkan build ships libggml-vulkan next to the binary. null = not installed. */
function installedVariant(root: string): { variant: LlamaVariant; bin: string } | null {
	const bin = findFile(root, "llama-server");
	if (!bin) return null;
	const dir = dirname(bin);
	const vulkan =
		existsSync(join(dir, "libggml-vulkan.so")) || existsSync(join(dir, "ggml-vulkan.dll"));
	return { variant: vulkan ? "vulkan" : "cpu", bin };
}

/** Download + extract a llama.cpp release into a staging dir, then swap it into
 *  `root` only once the binary is confirmed — so a failed download never wipes a
 *  working install. Returns the llama-server path. */
async function fetchLlamaServer(
	runtimeDir: string,
	root: string,
	gpu: GpuVendor,
	log: (s: string) => void,
): Promise<string> {
	log("Downloading llama.cpp…");
	const tmp = join(runtimeDir, "tmp");
	mkdirSync(tmp, { recursive: true });
	const asset = llamaAsset(gpu);
	const archive = join(tmp, asset);
	await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset}`, archive);

	const staging = `${root}.staging`;
	rmSync(staging, { recursive: true, force: true });
	await extract(archive, staging, log);
	if (!findFile(staging, "llama-server")) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error("llama-server not found after extraction.");
	}
	// Swap the verified build into place (only now discard any old one).
	rmSync(root, { recursive: true, force: true });
	renameSync(staging, root);

	const bin = findFile(root, "llama-server")!;
	if (process.platform === "darwin") {
		// Clear Gatekeeper quarantine so the downloaded binary can run.
		await run("xattr", ["-dr", "com.apple.quarantine", root], {}, () => {}).catch(() => undefined);
	}
	if (process.platform !== "win32") chmodSync(bin, 0o755);
	return bin;
}

/** Run `bin --list-devices`. "gpu": a GPU device is listed. "none": ran but only
 *  CPU. "error": the binary could not be launched (or hung past the timeout).
 *  Async — this can take up to 15s and must not block the renderer. */
function probeGpu(bin: string): Promise<"gpu" | "none" | "error"> {
	return new Promise((resolve) => {
		const p = spawn(bin, ["--list-devices"], { timeout: 15000, windowsHide: true });
		let out = "";
		const cap = (b: Buffer) => (out += b.toString());
		p.stdout.on("data", cap);
		p.stderr.on("data", cap);
		p.on("error", () => resolve("error"));
		// A signal exit means the timeout killed it — "error", matching the old
		// sync probe's timeout behavior.
		p.on("exit", (_code, sig) => resolve(sig ? "error" : hasGpuDevice(out) ? "gpu" : "none"));
	});
}

async function ensureLlamaServer(runtimeDir: string, log: (s: string) => void): Promise<string> {
	const root = join(runtimeDir, "llama.cpp");
	const gpu = await detectGpu();

	// Desired build variant from the detected GPU, unless a previous probe on this
	// host already established that no usable Vulkan device exists.
	let desired = variantForAsset(process.platform, process.arch, gpu);
	if (desired === "vulkan" && existsSync(vulkanMarker(runtimeDir))) desired = "cpu";
	if (desired === "vulkan") log(`Detected ${gpu.toUpperCase()} GPU; using GPU-accelerated llama.cpp.`);

	// Reuse an installed build only when it already matches the desired variant.
	const installed = installedVariant(root);
	if (installed && installed.variant === desired) return installed.bin;

	let bin = await fetchLlamaServer(runtimeDir, root, desired === "vulkan" ? gpu : "none", log);

	// Safety net: a Vulkan build that can't see a GPU (missing driver/ICD) or that
	// won't launch would otherwise run on CPU silently. Fall back to the CPU build
	// and remember it so later launches don't re-download the Vulkan build.
	if (desired === "vulkan") {
		const probe = await probeGpu(bin);
		if (probe !== "gpu") {
			log(
				probe === "error"
					? "Vulkan build failed to launch; falling back to the CPU build."
					: "Vulkan build reports no usable GPU device; falling back to the CPU build.",
			);
			writeFileSync(vulkanMarker(runtimeDir), "");
			bin = await fetchLlamaServer(runtimeDir, root, "none", log);
		}
	}
	return bin;
}

// ---- entrypoint --------------------------------------------------------

/**
 * Intel Macs are unsupported: LanceDB (khora's vector store) dropped x86_64-mac
 * wheels in v0.30, and khora requires >=0.30, so the venv install is
 * unsatisfiable on Intel. Fail fast with a plain-language reason instead of
 * letting users hit uv's raw "no matching platform tag" resolver error.
 *
 * Apple-Silicon Macs launched under Rosetta also report arch "x64", so the
 * message covers that recoverable case too.
 */
export function assertSupportedPlatform(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): void {
	if (platform === "darwin" && arch !== "arm64") {
		throw new Error(
			"Uru requires an Apple Silicon Mac (M1 or newer). Uru's local vector " +
				"database, LanceDB, no longer ships builds for Intel Macs, so it can't " +
				"be installed on this processor. If your Mac does have Apple Silicon, " +
				"it's running Obsidian through Rosetta: quit Obsidian, then in Finder " +
				"open Applications, right-click Obsidian → Get Info, untick “Open using " +
				"Rosetta”, and start Uru again.",
		);
	}
}

/**
 * Resolve a working backend, bootstrapping into the shared app-data runtime if
 * needed. Dev fast-path (repo-local venv + models + llama.cpp) is reused as-is.
 */
export async function ensureBackend(ctx: BootstrapContext): Promise<BackendPaths> {
	const { pluginSidecarDir, runtimeDir, log } = ctx;
	assertSupportedPlatform();
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
				? "Installing Khora + sidecar…"
				: `Updating the local AI service (Khora ${installed.khora}→${KHORA_VERSION}, ` +
						`sidecar ${installed.sidecar}→${SIDECAR_VERSION})…`,
		);
		// Force the CPU torch wheel. torch is pulled in only transitively (khora →
		// sentence-transformers) and is never imported at runtime: the sidecar
		// disables khora's cross-encoder reranker (the sole torch consumer, and a
		// lazy import at that) and all inference runs through llama-server. On
		// Linux x64 the default PyPI `torch` is the CUDA build, dragging in ~6 GB
		// of nvidia-*/triton wheels — a 10-minute install of pure dead weight.
		// UV_TORCH_BACKEND=cpu resolves torch from the CPU index instead (small,
		// driver-independent). Env var rather than --torch-backend flag: ensureUv
		// may pick up a pre-existing system uv, and a version predating the flag
		// would hard-fail on it, while an unknown env var is simply ignored.
		await run(
			uv,
			["pip", "install", "--python", py, "--force-reinstall", stageSidecarSource(runtimeDir)],
			{ env: { ...env, UV_TORCH_BACKEND: "cpu" } },
			log,
		);
		if ((await probeVersions(py)) === null) {
			throw new Error(
				"The local AI service is missing dependencies after install — importing uru_sidecar/khora/huggingface_hub failed; check diagnostics.",
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

	log("Setup complete — Uru is ready.");
	// uru_sidecar is pip-installed into the venv, so `python -m uru_sidecar`
	// works from any cwd; runtimeDir is a harmless PYTHONPATH.
	return { pythonPath: py, sidecarCwd: runtimeDir, llamaServerBin, ...models };
}
