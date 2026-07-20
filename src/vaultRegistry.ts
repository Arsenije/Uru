import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { registryPath, vaultsDir } from "./paths";

export interface VaultRegistryEntry {
	vaultKey: string;
	vaultPath: string;
	vaultName: string;
	/** Epoch ms at the last successful backend start for this vault. */
	lastSeen: number;
}

type Registry = Record<string, VaultRegistryEntry>;

/**
 * True if two paths point at the same vault. A vault's real-world identity is its
 * filesystem path, so we normalize (resolve `.`/`..`, strip trailing separators)
 * before comparing — the ephemeral `vaultKey` can change across reinstalls.
 */
export function sameVaultPath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return resolve(a) === resolve(b);
}

/**
 * Pure filter behind {@link otherActiveVaults}: entries that are neither the
 * current vault's key nor its path. Path match guards against key drift, where
 * a reinstall gives this same vault a fresh key and orphans its old entry.
 */
export function computeOtherActiveVaults(
	reg: Registry,
	currentKey: string,
	currentPath?: string,
): VaultRegistryEntry[] {
	return Object.values(reg).filter(
		(v) => v.vaultKey !== currentKey && !sameVaultPath(v.vaultPath, currentPath),
	);
}

/**
 * Pure computation behind {@link touchVault}: returns `reg` with `entry` recorded
 * and any same-path orphan under a different key evicted, so the registry
 * converges to one entry per physical vault.
 */
export function applyTouch(reg: Registry, entry: VaultRegistryEntry): Registry {
	const next: Registry = {};
	for (const [key, v] of Object.entries(reg)) {
		if (key !== entry.vaultKey && sameVaultPath(v.vaultPath, entry.vaultPath)) continue;
		next[key] = v;
	}
	next[entry.vaultKey] = entry;
	return next;
}

/** Never throws: a missing or unparsable file means "unknown", not "empty". */
function readRegistry(): Registry | null {
	try {
		if (!existsSync(registryPath())) return {};
		return JSON.parse(readFileSync(registryPath(), "utf8")) as Registry;
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
	writeRegistry(applyTouch(reg, entry));
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
 *
 * The current vault is identified by BOTH its key and its path: matching on path
 * as well means a stale entry left behind when this vault was reinstalled under a
 * new key is correctly recognized as self, not as a blocking "other vault".
 */
export function otherActiveVaults(
	vaultKey: string,
	vaultPath?: string,
): VaultRegistryEntry[] | "unknown" {
	const reg = readRegistry();
	if (reg === null) return "unknown";
	return computeOtherActiveVaults(reg, vaultKey, vaultPath);
}

/**
 * Delete per-vault data dirs that no registry entry references — orphans left by
 * reinstalls under fresh keys, which "Remove everything" would otherwise leave
 * behind. No-op if the registry is unreadable: we never delete data we can't
 * prove is orphaned. Best-effort per dir; a failed removal never throws.
 */
export function pruneOrphanVaultData(): void {
	const reg = readRegistry();
	if (reg === null) return;
	let names: string[];
	try {
		names = readdirSync(vaultsDir());
	} catch {
		return; // dir missing (nothing set up) — nothing to prune
	}
	for (const name of names) {
		if (name in reg) continue;
		try {
			rmSync(join(vaultsDir(), name), { recursive: true, force: true });
		} catch {
			/* best-effort — a locked/undeletable dir must not abort cleanup */
		}
	}
}
