// Single source of truth for the khora version: the pin in sidecar/pyproject.toml
// (it is what pip actually resolves). The build injects it into the plugin via
// esbuild `define` (see esbuild.config.mjs), so uv.ts can never drift from it.
import { readFileSync } from "fs";

const PIN_RE = /"khora\[[^\]]*\]==([^"\s]+)"/;

/**
 * Parse the exact khora version out of the sidecar's pyproject.toml.
 * Anchored on the quoted dependency string so version numbers in nearby
 * comments can't match. Throws if the pin is missing or not an exact `==`.
 */
export function readKhoraPin(pyprojectPath = "sidecar/pyproject.toml") {
	const toml = readFileSync(pyprojectPath, "utf8");
	const match = toml.match(PIN_RE);
	if (!match) {
		throw new Error(
			`Could not find an exact "khora[...]==X.Y.Z" pin in ${pyprojectPath} — ` +
				`the build needs it to inject KHORA_VERSION (see scripts/khora-pin.mjs).`,
		);
	}
	return match[1];
}
