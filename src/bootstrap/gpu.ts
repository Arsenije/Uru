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
