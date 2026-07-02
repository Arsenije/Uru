import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { registryPath } from "./paths";

export interface VaultRegistryEntry {
	vaultKey: string;
	vaultPath: string;
	vaultName: string;
	/** Epoch ms at the last successful backend start for this vault. */
	lastSeen: number;
}

type Registry = Record<string, VaultRegistryEntry>;

/** Never throws: a missing or unparsable file means "unknown", not "empty". */
function readRegistry(): Registry | null {
	try {
		if (!existsSync(registryPath())) return {};
		return JSON.parse(readFileSync(registryPath(), "utf8"));
	} catch {
		return null;
	}
}

function writeRegistry(reg: Registry): void {
	try {
		mkdirSync(dirname(registryPath()), { recursive: true });
		writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
	} catch {
		/* best-effort — registry bookkeeping must never block the backend */
	}
}

/** Record that this vault is alive and using the shared runtime. */
export function touchVault(entry: VaultRegistryEntry): void {
	const reg = readRegistry();
	if (reg === null) return; // don't clobber an unreadable file we can't safely merge into
	reg[entry.vaultKey] = entry;
	writeRegistry(reg);
}

/** Drop this vault's entry (called when its data is deleted). */
export function removeVault(vaultKey: string): void {
	const reg = readRegistry();
	if (reg === null) return;
	delete reg[vaultKey];
	writeRegistry(reg);
}

/**
 * Other vaults still registered as using the shared runtime, or "unknown" if
 * the registry can't be read — callers must never treat "unknown" as safe.
 */
export function otherActiveVaults(vaultKey: string): VaultRegistryEntry[] | "unknown" {
	const reg = readRegistry();
	if (reg === null) return "unknown";
	return Object.values(reg).filter((v) => v.vaultKey !== vaultKey);
}
