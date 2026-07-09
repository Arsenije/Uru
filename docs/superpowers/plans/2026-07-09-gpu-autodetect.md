# GPU Auto-Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect a supported GPU at bootstrap and provision the Vulkan llama.cpp build (universal AMD/Nvidia/Intel backend) instead of the CPU-only build, falling back to CPU when no GPU is usable.

**Architecture:** A new dependency-light module `src/bootstrap/gpu.ts` holds all detection + asset-selection logic as pure, unit-testable functions (it must NOT import `obsidian`, because the test bundler can't resolve that). `src/bootstrap/uv.ts` calls into it: it detects the GPU, selects the asset, infers the installed build variant from `libggml-vulkan.so`, re-provisions on mismatch, and runs a `llama-server --list-devices` probe that falls back to CPU when the Vulkan build sees no GPU.

**Tech Stack:** TypeScript, Node builtins (`fs`, `path`, `child_process`), esbuild bundling, `node:test` + `node:assert/strict`. Tests run via `npm test`.

---

## File Structure

- **Create `src/bootstrap/gpu.ts`** — GPU vendor detection (Linux sysfs + Windows PowerShell), asset-name selection, variant classification, and the `--list-devices` output parser. Pure logic + thin I/O wrappers. No `obsidian` import.
- **Create `tests/gpu.test.ts`** — unit tests for every pure function in `gpu.ts`.
- **Modify `src/bootstrap/uv.ts`** — replace `llamaAsset()` with a call into `gpu.ts`; rewrite `ensureLlamaServer()` to detect, select, re-provision, and probe-with-fallback; factor the download-and-extract steps into a reused helper.

Reference facts (verified against the `b9838` binary):
- Vulkan build + GPU: `--list-devices` prints `Available devices:\n  Vulkan0: AMD Radeon RX 7600 (RADV NAVI33) (8192 MiB, 2343 MiB free)`.
- CPU build: `--list-devices` prints `Available devices:` with no indented device line.
- PCI vendor IDs in `/sys/class/drm/card*/device/vendor`: `0x1002`=AMD, `0x10de`=Nvidia, `0x8086`=Intel. Display controllers have `/sys/class/drm/card*/device/class` starting `0x03`.

---

### Task 1: Vendor-ID parsing and vendor selection

**Files:**
- Create: `src/bootstrap/gpu.ts`
- Test: `tests/gpu.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gpu.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVendorId, pickVendor } from "../src/bootstrap/gpu";

test("parseVendorId maps PCI vendor IDs to vendors", () => {
	assert.equal(parseVendorId("0x1002"), "amd");
	assert.equal(parseVendorId("0x10DE\n"), "nvidia"); // case + trailing newline
	assert.equal(parseVendorId("0x8086"), "intel");
	assert.equal(parseVendorId("0x1234"), "none"); // unknown vendor
	assert.equal(parseVendorId(""), "none");
});

test("pickVendor prefers a discrete GPU over integrated", () => {
	assert.equal(pickVendor(["intel", "amd"]), "amd"); // iGPU + dGPU -> dGPU
	assert.equal(pickVendor(["intel", "nvidia"]), "nvidia");
	assert.equal(pickVendor(["intel"]), "intel"); // only integrated
	assert.equal(pickVendor(["amd"]), "amd");
	assert.equal(pickVendor([]), "none");
	assert.equal(pickVendor(["none", "none"]), "none");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — esbuild cannot resolve `../src/bootstrap/gpu` (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/bootstrap/gpu.ts

export type GpuVendor = "amd" | "nvidia" | "intel" | "none";

const PCI_VENDORS: Record<string, GpuVendor> = {
	"0x1002": "amd",
	"0x10de": "nvidia",
	"0x8086": "intel",
};

/** Map a `/sys/.../device/vendor` value (e.g. "0x1002\n") to a GpuVendor. */
export function parseVendorId(raw: string): GpuVendor {
	return PCI_VENDORS[raw.trim().toLowerCase()] ?? "none";
}

/** Choose one vendor from all detected display controllers: a discrete GPU
 *  (amd/nvidia) wins over an integrated one (intel). */
export function pickVendor(vendors: GpuVendor[]): GpuVendor {
	const real = vendors.filter((v) => v !== "none");
	if (real.length === 0) return "none";
	return real.find((v) => v === "amd" || v === "nvidia") ?? real[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/gpu.ts tests/gpu.test.ts
git commit -m "feat(gpu): vendor-id parsing and discrete-preferred vendor selection"
```

---

### Task 2: Windows adapter parsing

**Files:**
- Modify: `src/bootstrap/gpu.ts`
- Test: `tests/gpu.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/gpu.test.ts
import { parseWindowsAdapters } from "../src/bootstrap/gpu";

test("parseWindowsAdapters maps adapter names to a vendor", () => {
	assert.equal(parseWindowsAdapters(["NVIDIA GeForce RTX 4070"]), "nvidia");
	assert.equal(parseWindowsAdapters(["AMD Radeon RX 7600"]), "amd");
	assert.equal(parseWindowsAdapters(["Radeon(TM) Graphics"]), "amd");
	assert.equal(parseWindowsAdapters(["Intel(R) UHD Graphics 630"]), "intel");
	assert.equal(
		parseWindowsAdapters(["Intel(R) UHD Graphics 630", "NVIDIA GeForce RTX 4070"]),
		"nvidia", // laptop iGPU + dGPU -> discrete
	);
	assert.equal(parseWindowsAdapters([]), "none");
	assert.equal(parseWindowsAdapters(["Microsoft Basic Display Adapter"]), "none");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseWindowsAdapters` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/bootstrap/gpu.ts

/** Map Windows `Win32_VideoController` adapter names to a single vendor. */
export function parseWindowsAdapters(names: string[]): GpuVendor {
	const vendors = names.map<GpuVendor>((n) => {
		const s = n.toLowerCase();
		if (s.includes("nvidia")) return "nvidia";
		if (s.includes("amd") || s.includes("radeon")) return "amd";
		if (s.includes("intel")) return "intel";
		return "none";
	});
	return pickVendor(vendors);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/gpu.ts tests/gpu.test.ts
git commit -m "feat(gpu): parse Windows video-controller names to a vendor"
```

---

### Task 3: `--list-devices` probe parser

**Files:**
- Modify: `src/bootstrap/gpu.ts`
- Test: `tests/gpu.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/gpu.test.ts
import { hasGpuDevice } from "../src/bootstrap/gpu";

test("hasGpuDevice detects a GPU device line from --list-devices output", () => {
	const withGpu =
		"Available devices:\n" +
		"  Vulkan0: AMD Radeon RX 7600 (RADV NAVI33) (8192 MiB, 2343 MiB free)\n";
	const cpuOnly = "Available devices:\n";
	assert.equal(hasGpuDevice(withGpu), true);
	assert.equal(hasGpuDevice(cpuOnly), false);
	assert.equal(hasGpuDevice(""), false);
	// also matches CUDA/other backends that use the same "<Name><N>:" shape
	assert.equal(hasGpuDevice("Available devices:\n  CUDA0: NVIDIA RTX 4070\n"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `hasGpuDevice` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/bootstrap/gpu.ts

/** True if `llama-server --list-devices` output lists a real (GPU) device.
 *  GPU devices render as an indented "<Backend><N>: ..." line (e.g.
 *  "  Vulkan0: ..."); a CPU-only build prints the header with no such line. */
export function hasGpuDevice(listDevicesOutput: string): boolean {
	return /\n[ \t]+\S+\d+:/.test(listDevicesOutput);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/gpu.ts tests/gpu.test.ts
git commit -m "feat(gpu): parse --list-devices output to detect a GPU device"
```

---

### Task 4: Asset-name and variant selection

**Files:**
- Modify: `src/bootstrap/gpu.ts`
- Test: `tests/gpu.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/gpu.test.ts
import { llamaAssetName, variantForAsset } from "../src/bootstrap/gpu";

const B = "b9838";

test("llamaAssetName picks the Vulkan build for an x64 GPU host", () => {
	assert.equal(llamaAssetName("linux", "x64", "amd", B), `llama-${B}-bin-ubuntu-vulkan-x64.tar.gz`);
	assert.equal(llamaAssetName("linux", "x64", "nvidia", B), `llama-${B}-bin-ubuntu-vulkan-x64.tar.gz`);
	assert.equal(llamaAssetName("win32", "x64", "amd", B), `llama-${B}-bin-win-vulkan-x64.zip`);
});

test("llamaAssetName falls back to CPU builds without a GPU or on arm64", () => {
	assert.equal(llamaAssetName("linux", "x64", "none", B), `llama-${B}-bin-ubuntu-x64.tar.gz`);
	assert.equal(llamaAssetName("linux", "arm64", "amd", B), `llama-${B}-bin-ubuntu-arm64.tar.gz`); // no arm GPU build
	assert.equal(llamaAssetName("win32", "x64", "none", B), `llama-${B}-bin-win-cpu-x64.zip`);
	assert.equal(llamaAssetName("win32", "arm64", "amd", B), `llama-${B}-bin-win-cpu-arm64.zip`);
});

test("llamaAssetName always uses the Metal-capable macOS build", () => {
	assert.equal(llamaAssetName("darwin", "arm64", "amd", B), `llama-${B}-bin-macos-arm64.tar.gz`);
	assert.equal(llamaAssetName("darwin", "x64", "none", B), `llama-${B}-bin-macos-x64.tar.gz`);
});

test("variantForAsset is vulkan only for an x64 non-mac GPU host", () => {
	assert.equal(variantForAsset("linux", "x64", "amd"), "vulkan");
	assert.equal(variantForAsset("win32", "x64", "nvidia"), "vulkan");
	assert.equal(variantForAsset("linux", "x64", "none"), "cpu");
	assert.equal(variantForAsset("linux", "arm64", "amd"), "cpu");
	assert.equal(variantForAsset("darwin", "arm64", "amd"), "cpu");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `llamaAssetName` / `variantForAsset` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/bootstrap/gpu.ts

export type LlamaVariant = "vulkan" | "cpu";

/** True when the host should use a Vulkan GPU build: x64, non-macOS, GPU present.
 *  (macOS uses its own Metal-capable build; Windows arm64 has no Vulkan prebuilt.) */
function gpuCapable(platform: NodeJS.Platform, arch: string, gpu: GpuVendor): boolean {
	return platform !== "darwin" && arch !== "arm64" && gpu !== "none";
}

/** Release asset filename for the given host + detected GPU. */
export function llamaAssetName(
	platform: NodeJS.Platform,
	arch: string,
	gpu: GpuVendor,
	build: string,
): string {
	const arm = arch === "arm64";
	if (platform === "darwin") return `llama-${build}-bin-macos-${arm ? "arm64" : "x64"}.tar.gz`;
	if (platform === "win32") {
		return gpuCapable(platform, arch, gpu)
			? `llama-${build}-bin-win-vulkan-x64.zip`
			: `llama-${build}-bin-win-cpu-${arm ? "arm64" : "x64"}.zip`;
	}
	// linux (and any other non-darwin/non-win platform tar layout)
	return gpuCapable(platform, arch, gpu)
		? `llama-${build}-bin-ubuntu-vulkan-x64.tar.gz`
		: `llama-${build}-bin-ubuntu-${arm ? "arm64" : "x64"}.tar.gz`;
}

/** Which build variant `llamaAssetName` resolves to, for install/reuse decisions. */
export function variantForAsset(
	platform: NodeJS.Platform,
	arch: string,
	gpu: GpuVendor,
): LlamaVariant {
	return gpuCapable(platform, arch, gpu) ? "vulkan" : "cpu";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/gpu.ts tests/gpu.test.ts
git commit -m "feat(gpu): select Vulkan vs CPU release asset by host + GPU"
```

---

### Task 5: Linux sysfs detection and platform dispatch

**Files:**
- Modify: `src/bootstrap/gpu.ts`
- Test: `tests/gpu.test.ts`

- [ ] **Step 1: Write the failing test**

The test builds a fake sysfs tree in a temp dir and points `detectGpuLinux` at it.

```ts
// append to tests/gpu.test.ts
import { detectGpuLinux } from "../src/bootstrap/gpu";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function fakeDrm(cards: Array<{ name: string; cls: string; vendor: string }>): string {
	const root = mkdtempSync(join(tmpdir(), "drm-"));
	for (const c of cards) {
		const dev = join(root, c.name, "device");
		mkdirSync(dev, { recursive: true });
		writeFileSync(join(dev, "class"), c.cls + "\n");
		writeFileSync(join(dev, "vendor"), c.vendor + "\n");
	}
	return root;
}

test("detectGpuLinux reads a display-controller AMD GPU from sysfs", () => {
	const root = fakeDrm([{ name: "card0", cls: "0x030000", vendor: "0x1002" }]);
	try {
		assert.equal(detectGpuLinux(root), "amd");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectGpuLinux skips non-display-controller devices", () => {
	// 0x010802 = non-volatile memory controller, not a GPU
	const root = fakeDrm([{ name: "card0", cls: "0x010802", vendor: "0x1002" }]);
	try {
		assert.equal(detectGpuLinux(root), "none");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectGpuLinux returns none when the sysfs path is absent", () => {
	assert.equal(detectGpuLinux("/no/such/path/xyz"), "none");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `detectGpuLinux` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add near the top of src/bootstrap/gpu.ts, with the other imports
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// append to src/bootstrap/gpu.ts

/** Detect the GPU vendor on Linux by reading /sys/class/drm/card*. Pure file
 *  reads — no lspci/vulkaninfo. `sysfsRoot` is injectable for tests. */
export function detectGpuLinux(sysfsRoot = "/sys/class/drm"): GpuVendor {
	let cards: string[];
	try {
		cards = readdirSync(sysfsRoot).filter((n) => /^card\d+$/.test(n));
	} catch {
		return "none";
	}
	const vendors: GpuVendor[] = [];
	for (const card of cards) {
		const dev = join(sysfsRoot, card, "device");
		try {
			const cls = readFileSync(join(dev, "class"), "utf8").trim().toLowerCase();
			if (!cls.startsWith("0x03")) continue; // display controllers only
			const vendor = parseVendorId(readFileSync(join(dev, "vendor"), "utf8"));
			if (vendor !== "none") vendors.push(vendor);
		} catch {
			continue; // missing/unreadable node — skip this card
		}
	}
	return pickVendor(vendors);
}

/** Detect the GPU vendor on Windows via PowerShell / WMI. */
export function detectGpuWindows(): GpuVendor {
	try {
		const res = spawnSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
			],
			{ encoding: "utf8", timeout: 5000 },
		);
		if (res.status !== 0 || !res.stdout) return "none";
		return parseWindowsAdapters(res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
	} catch {
		return "none";
	}
}

/** Detect a supported GPU on the current host. macOS returns "none": its
 *  standard build already includes Metal, so no Vulkan swap is needed. */
export function detectGpu(): GpuVendor {
	if (process.platform === "linux") return detectGpuLinux();
	if (process.platform === "win32") return detectGpuWindows();
	return "none";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all `gpu.test.ts` tests).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/gpu.ts tests/gpu.test.ts
git commit -m "feat(gpu): detect GPU vendor from Linux sysfs and Windows WMI"
```

---

### Task 6: Wire detection into `ensureLlamaServer`

No new unit test — this task is I/O orchestration verified at runtime in Task 7. It must keep `npm run build` (tsc) passing.

**Files:**
- Modify: `src/bootstrap/uv.ts` (imports; `llamaAsset`; `ensureLlamaServer` at ~219-239)

- [ ] **Step 1: Add imports**

At the top of `src/bootstrap/uv.ts`, extend the existing `fs`, `path`, and `child_process` imports and add the `gpu` import. Ensure these names are present (merge into existing import statements, do not duplicate):

```ts
import { rmSync } from "fs";       // add rmSync to the existing "fs" import
import { dirname } from "path";    // add dirname to the existing "path" import
import { spawnSync } from "child_process"; // add to the existing child_process import
import {
	detectGpu,
	hasGpuDevice,
	llamaAssetName,
	variantForAsset,
	type GpuVendor,
	type LlamaVariant,
} from "./gpu";
```

- [ ] **Step 2: Replace `llamaAsset()` with a call into gpu.ts**

Replace the whole existing `llamaAsset()` function (`uv.ts:186-191`) with:

```ts
function llamaAsset(gpu: GpuVendor): string {
	return llamaAssetName(process.platform, process.arch, gpu, LLAMA_BUILD);
}
```

- [ ] **Step 3: Add variant + probe helpers**

Add these helpers just above `ensureLlamaServer` in `uv.ts`:

```ts
/** Classify an already-installed build: a Vulkan build ships libggml-vulkan.
 *  Returns null when no llama-server is installed under `root`. */
function installedVariant(root: string): LlamaVariant | null {
	const bin = findFile(root, "llama-server");
	if (!bin) return null;
	const dir = dirname(bin);
	const vulkan =
		existsSync(join(dir, "libggml-vulkan.so")) || existsSync(join(dir, "ggml-vulkan.dll"));
	return vulkan ? "vulkan" : "cpu";
}

/** Download + extract + chmod the given release asset; return the llama-server path. */
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
	await extract(archive, root, log);
	if (process.platform === "darwin") {
		await run("xattr", ["-dr", "com.apple.quarantine", root], {}, () => {}).catch(() => undefined);
	}
	const bin = findFile(root, "llama-server");
	if (!bin) throw new Error("llama-server not found after extraction");
	if (process.platform !== "win32") chmodSync(bin, 0o755);
	return bin;
}

/** True if `bin --list-devices` reports a usable GPU device. */
function probeHasGpu(bin: string): boolean {
	try {
		const res = spawnSync(bin, ["--list-devices"], { encoding: "utf8", timeout: 15000 });
		return hasGpuDevice((res.stdout ?? "") + (res.stderr ?? ""));
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: Rewrite `ensureLlamaServer`**

Replace the whole existing `ensureLlamaServer` (`uv.ts:219-239`) with:

```ts
async function ensureLlamaServer(runtimeDir: string, log: (s: string) => void): Promise<string> {
	const root = join(runtimeDir, "llama.cpp");
	const gpu = detectGpu();
	if (gpu !== "none") log(`Detected ${gpu.toUpperCase()} GPU; using GPU-accelerated llama.cpp.`);
	const desired = variantForAsset(process.platform, process.arch, gpu);

	// Reuse an installed build only when it already matches the desired variant.
	const installed = installedVariant(root);
	if (installed === desired) {
		return findFile(root, "llama-server")!;
	}
	if (installed) {
		log(`Replacing ${installed} llama.cpp build with ${desired} build…`);
		rmSync(root, { recursive: true, force: true });
	}

	let bin = await fetchLlamaServer(runtimeDir, root, gpu, log);

	// Safety net: a Vulkan build that can't see a GPU (missing driver/ICD) would
	// silently run on CPU. Detect that and fall back to the plain CPU build.
	if (desired === "vulkan" && !probeHasGpu(bin)) {
		log("Vulkan build reports no GPU device; falling back to the CPU build.");
		rmSync(root, { recursive: true, force: true });
		bin = await fetchLlamaServer(runtimeDir, root, "none", log);
	}
	return bin;
}
```

- [ ] **Step 5: Verify the build typechecks and tests still pass**

Run: `npm run build`
Expected: no TypeScript errors; esbuild writes `main.js`.

Run: `npm test`
Expected: PASS (all `gpu.test.ts` + existing `vaultRegistry.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap/uv.ts
git commit -m "feat(bootstrap): provision GPU llama.cpp build via auto-detection

Detect the host GPU, download the Vulkan build when one is present, infer
the installed variant from libggml-vulkan and re-provision on mismatch, and
fall back to the CPU build when --list-devices shows no GPU."
```

---

### Task 7: Runtime verification on the reference machine

No code changes — this exercises the real bootstrap path end-to-end (the `verify` skill's job) and confirms the servers land on the GPU.

- [ ] **Step 1: Confirm reuse path (no re-download)**

The reference machine already has the Vulkan build in `~/.local/share/uru/runtime/llama.cpp/llama-b9838/` (contains `libggml-vulkan.so`). Confirm `installedVariant` would classify it as vulkan:

Run: `ls ~/.local/share/uru/runtime/llama.cpp/llama-b9838/libggml-vulkan.so`
Expected: the file exists → `installed === "vulkan" === desired`, so bootstrap reuses it with no download.

- [ ] **Step 2: Confirm the probe reports a GPU**

Run: `~/.local/share/uru/runtime/llama.cpp/llama-b9838/llama-server --list-devices`
Expected: output contains a `Vulkan0: AMD Radeon RX 7600 ...` line → `probeHasGpu` returns true.

- [ ] **Step 3: Reload Uru and confirm GPU offload**

Reload the Uru plugin in Obsidian, send a chat message, and while it generates:

Run: `rocm-smi --showuse; cat /sys/class/drm/card1/device/mem_info_vram_used`
Expected: VRAM occupancy rises by ~2 GB over idle (model resident in VRAM) and GPU-use spikes during generation — CPU no longer pinned at ~90%.

- [ ] **Step 4: Final commit / branch ready**

If any doc updates are needed (e.g. README's "Windows/Linux = CPU builds" note in `README.md:160`), update them:

```bash
git add -A
git commit -m "docs: note automatic GPU acceleration on Linux/Windows"
```

---

## Self-Review

**Spec coverage:**
- Backend strategy (Vulkan universal + CPU fallback) → Tasks 4, 6.
- Linux + Windows detection; macOS unchanged → Tasks 5 (`detectGpu` returns none on darwin), 4 (`llamaAssetName` darwin → macos build).
- Detection module `gpu.ts` with `detectGpu()` signature → Tasks 1–5.
- Asset selection `llamaAsset(gpu)` → Tasks 4, 6.
- Variant-by-`libggml-vulkan.so` + re-provision → Task 6 (`installedVariant`, `ensureLlamaServer`).
- `--list-devices` device-probe fallback → Tasks 3 (`hasGpuDevice`), 6 (`probeHasGpu`).
- `--n-gpu-layers` stays -1, no VRAM calc, no vendor builds, dev fast-path untouched → honored (no task changes these).
- Error handling: `detectGpu` never throws (try/catch → "none") → Task 5; probe failure → CPU fallback → Task 6.
- Testing: detection-parsing units + asset-selection units + runtime verification → Tasks 1-5 (unit), 7 (runtime).

**Placeholder scan:** none — every code step shows complete code; every run step shows an exact command + expected result.

**Type consistency:** `GpuVendor` and `LlamaVariant` defined in `gpu.ts` (Tasks 1, 4) and imported by `uv.ts` (Task 6). Function names consistent across tasks: `parseVendorId`, `pickVendor`, `parseWindowsAdapters`, `hasGpuDevice`, `llamaAssetName`, `variantForAsset`, `detectGpuLinux`, `detectGpuWindows`, `detectGpu`, `installedVariant`, `fetchLlamaServer`, `probeHasGpu`. `llamaAsset(gpu)` in `uv.ts` delegates to `llamaAssetName(process.platform, process.arch, gpu, LLAMA_BUILD)`.
