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

/** True if `llama-server --list-devices` output lists a real (GPU) device.
 *  GPU devices render as an indented "<Backend><N>: ..." line (e.g.
 *  "  Vulkan0: ..."); a CPU-only build prints the header with no such line. */
export function hasGpuDevice(listDevicesOutput: string): boolean {
	return /\n[ \t]+\S+\d+:/.test(listDevicesOutput);
}

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
