import { homedir } from "os";
import { join } from "path";

/**
 * Per-user app-data root for Uru, OUTSIDE any vault, so the backend (uv venv,
 * models, llama.cpp binary) and the index/db survive plugin updates and are
 * never touched by Obsidian Sync.
 */
export function appDataDir(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "uru");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "uru");
	}
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "uru");
}

/** Shared runtime: uv, the Python venv, GGUF models, the llama.cpp binary. */
export function runtimeDir(): string {
	return join(appDataDir(), "runtime");
}

/** Per-vault data: khora db, index-state.json, sidecar lockfile. */
export function vaultDataDir(vaultKey: string): string {
	return join(appDataDir(), "vaults", vaultKey);
}

/** Registry of vaults sharing the runtime, so cleanup can tell if it's safe to remove. */
export function registryPath(): string {
	return join(appDataDir(), "vaults.json");
}
