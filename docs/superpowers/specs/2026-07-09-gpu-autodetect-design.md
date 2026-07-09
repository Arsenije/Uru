# GPU auto-detection for llama.cpp provisioning

**Date:** 2026-07-09
**Branch:** `feat/gpu-autodetect`
**Status:** Approved design, pending implementation plan

## Problem

Uru's bootstrap always downloads the CPU-only llama.cpp build on Linux and
Windows (`src/bootstrap/uv.ts` → `llamaAsset()`), so chat and embedding run
entirely on the CPU even when a capable GPU is present. On the reference
machine (AMD Radeon RX 7600, `gfx1102`) this pins a 6-core CPU at ~90% and
makes chat slow, while the GPU sits idle. The CPU-only prebuilt ships no GPU
backend at all (`libggml-cpu-*.so` only, no `libggml-vulkan.so`), so the
existing `--n-gpu-layers -1` flag has nothing to offload to.

## Goal

Automatically detect a supported GPU at bootstrap time and provision a
GPU-capable llama.cpp build, falling back to CPU when no usable GPU exists.
Cover Linux and Windows; leave macOS unchanged (its standard build already
includes the Metal backend).

## Key facts that shape the design

- The llama.cpp release (`b9838`) has **no Linux CUDA prebuilt**. Linux GPU
  assets are `ubuntu-vulkan-x64`, `ubuntu-rocm-7.2-x64`, and Intel `sycl`.
- **Vulkan is the one universal GPU backend**: a single `ubuntu-vulkan-x64` /
  `win-vulkan-x64` build runs on AMD, Nvidia, and Intel via each vendor's
  Vulkan driver. Verified working on the RX 7600 (model loaded into VRAM,
  GPU busy spiked during inference).
- macOS `macos-{arch}` builds already contain Metal — GPU-accelerated today.
- Vendor-specific builds (Windows `cuda-*`, `hip-radeon`; Linux `rocm-7.2`)
  drag in runtime/driver version dependencies and can silently fail to load.

## Decisions

1. **Backend strategy:** Vulkan as the universal GPU tier, CPU as fallback.
   No ROCm / CUDA / SYCL vendor builds.
2. **Platforms:** Linux + Windows detection; macOS unchanged.
3. **Existing installs:** re-provision when the installed build's variant
   differs from the desired variant. Plus a runtime device-probe safety net.

## Architecture

All changes are in `src/bootstrap/`. One new module, plus edits to the asset
selection and `ensureLlamaServer` in `uv.ts`.

### New module: `src/bootstrap/gpu.ts`

Single responsibility: report the GPU vendor. No dependencies beyond `fs` and
`child_process.spawn`.

```
detectGpu(): "amd" | "nvidia" | "intel" | "none"
```

- **Linux:** enumerate `/sys/class/drm/card*/device/`. For each, read
  `class` (keep only display controllers, `0x03xxxx`) and `vendor`. Map PCI
  vendor IDs: `0x1002` → amd, `0x10de` → nvidia, `0x8086` → intel. Prefer a
  discrete vendor (amd/nvidia) over intel when both are present. Pure file
  reads — no `lspci`, `vulkaninfo`, or other external tools required.
- **Windows:** spawn PowerShell
  `Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name`
  and match `NVIDIA` / `AMD|Radeon` / `Intel` in the adapter names.
- Any error or empty result → `"none"` (CPU path).

### Asset selection: `llamaAsset(gpu)`

`llamaAsset()` gains a `gpu` parameter:

- **darwin** → `llama-<build>-bin-macos-<arch>.tar.gz` (unchanged).
- **linux/win AND arch x64 AND gpu ∈ {amd, nvidia, intel}** → the Vulkan
  build: `llama-<build>-bin-ubuntu-vulkan-x64.tar.gz` (Linux) or
  `llama-<build>-bin-win-vulkan-x64.zip` (Windows).
- **everything else** (no GPU, arm64, etc.) → the current CPU asset.

Vulkan GPU selection is limited to x64: it is the arch with the reference
hardware, and Windows arm64 has no Vulkan prebuilt. arm64 stays on its
current (CPU) asset.

### Variant tracking & re-provisioning

The installed build's variant is **inferred from the build itself**, not a
separate marker file:

- `libggml-vulkan.so` present in the extracted `llama-<build>/` dir ⇒
  `"vulkan"`; else a `llama-server` present ⇒ `"cpu"`; else not installed.

`ensureLlamaServer` logic:

1. Compute `desired` from `detectGpu()` + platform/arch.
2. Inspect the installed build to get `installed` variant.
3. If installed exists and `installed === desired` → reuse (no download).
4. Otherwise remove the `llama-<build>/` dir and provision the `desired`
   asset (download + extract + chmod).

This auto-upgrades existing CPU installs when a GPU is present. On the
reference machine, which already has the Vulkan `.so` in place, `installed`
is `"vulkan"` and `desired` is `"vulkan"`, so it reuses with no re-download.

### Device-probe safety net

After extracting a **Vulkan** build, run `llama-server --list-devices` and
parse the output for a real (non-CPU) GPU device. If none is reported — the
PCI scan found a GPU but the Vulkan loader/driver (ICD) is absent — fall back
to provisioning the **CPU** build. This prevents shipping a GPU binary that
silently cannot offload.

The exact `--list-devices` output format for the `b9838` binary is verified
as the first implementation step (before coding the parser).

**Implementation refinements (added during code review):**

- **Persisted fallback marker.** When the Vulkan probe finds no usable GPU,
  a `.llama-vulkan-unavailable` marker file is written under the runtime dir.
  On later launches, a host that reports a GPU via PCI but can't actually run
  Vulkan (missing driver/ICD, headless VM) is forced to CPU instead of
  re-downloading the Vulkan build every launch. Tradeoff: the marker is
  permanent — a user who later installs a working GPU driver must delete the
  file to re-enable Vulkan detection. This is acceptable versus the
  alternative (an infinite per-launch re-download loop).
- **Staged-swap download.** `fetchLlamaServer` extracts into a `<root>.staging`
  directory and only removes/replaces the existing `llama.cpp` dir after the
  new `llama-server` binary is verified present, so a failed or corrupt
  download never wipes a working install.
- **Three-state probe.** The device probe returns `gpu` / `none` / `error`,
  distinguishing "the binary could not launch" from "ran but saw no GPU" for
  clearer diagnostics; both non-`gpu` outcomes trigger the CPU fallback.

## Out of scope (YAGNI)

- `--n-gpu-layers` stays `-1` (offload all). The shipped models are small
  (Qwen2.5-3B Q4 ≈ 2.3 GB, bge-m3 Q8 ≈ 0.6 GB) and fit any real discrete GPU;
  a VRAM-fit calculator is deferred.
- No ROCm / CUDA / SYCL vendor-specific builds.
- The repo dev fast-path (`.llamacpp-test`, `uv.ts` ~line 256) is unchanged;
  this feature targets the shipped app-data bootstrap that real users hit.

## Error handling

- `detectGpu()` never throws: any I/O error, missing sysfs, or PowerShell
  failure resolves to `"none"` → CPU path (current, safe behavior).
- Download / extract failures propagate as today (they already throw with a
  clear message).
- Device-probe failure or unparseable output is treated as "no GPU device"
  → CPU fallback (fail safe, not fail closed).

## Testing

- **Unit — detection parsing:**
  - Linux: mock `/sys/class/drm/card*/device/{vendor,class}` reads and assert
    the vendor mapping (amd/nvidia/intel/none, discrete-over-integrated
    preference, non-display-controller skipped).
  - Windows: feed captured `Get-CimInstance` output strings to the parser and
    assert vendor mapping.
- **Unit — asset selection:** `llamaAsset(gpu)` across
  platform × arch × gpu returns the expected asset name.
- **Runtime (reference machine):** force a clean detection cycle and confirm
  end-to-end that it selects Vulkan, passes the device probe, and the chat +
  embed servers land on the GPU (VRAM occupancy and `rocm-smi` utilization
  spike during inference).

## Rollout

Work on branch `feat/gpu-autodetect`. No config surface or user-facing
settings change; behavior is automatic. Existing users on a CPU build get
upgraded to Vulkan on next bootstrap when a GPU is detected.
