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
