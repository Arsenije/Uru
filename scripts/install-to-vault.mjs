#!/usr/bin/env node
/**
 * Deploy a built Uru into an Obsidian vault's plugin folder.
 *
 *   node scripts/install-to-vault.mjs "<path-to-vault>"     (or set URU_VAULT)
 *
 * Copies everything the plugin needs at runtime — the bundled main.js,
 * manifest.json, styles.css, AND the Python sidecar package (pyproject.toml +
 * uru_sidecar/*.py), which the first-run bootstrap pip-installs. Run `npm run
 * build` first, or use `npm run install-plugin` which builds then deploys.
 *
 * GUI steps still can't be automated: after this, enable Uru in Obsidian and
 * run first-run setup.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const vault = process.argv[2] || process.env.URU_VAULT;
if (!vault) {
	console.error('usage: node scripts/install-to-vault.mjs "<path-to-vault>"');
	console.error("  (the vault is the folder that contains .obsidian/)");
	process.exit(2);
}
if (!existsSync(join(vault, ".obsidian"))) {
	console.error(`FAIL: "${vault}" has no .obsidian/ — point this at the vault root`);
	console.error("(open the vault in Obsidian at least once so .obsidian/ exists).");
	process.exit(1);
}

// Fail early with a clear message if the build hasn't run.
const rootFiles = ["main.js", "manifest.json", "styles.css"];
const missing = rootFiles.filter((f) => !existsSync(join(repoRoot, f)));
if (missing.length) {
	console.error(`FAIL: not built yet (missing ${missing.join(", ")}). Run: npm run build`);
	process.exit(1);
}

const dest = join(vault, ".obsidian", "plugins", "uru");
mkdirSync(dest, { recursive: true });

// 1) the bundle + metadata
for (const f of rootFiles) copyFileSync(join(repoRoot, f), join(dest, f));

// 2) the Python sidecar package (bootstrap pip-installs it from here).
//    Recurse so future subpackages are included; skip caches.
function copyTree(srcDir, dstDir) {
	mkdirSync(dstDir, { recursive: true });
	for (const entry of readdirSync(srcDir)) {
		if (entry === "__pycache__") continue;
		const src = join(srcDir, entry);
		const dst = join(dstDir, entry);
		if (statSync(src).isDirectory()) copyTree(src, dst);
		else if (entry.endsWith(".py")) copyFileSync(src, dst);
	}
}
copyFileSync(join(repoRoot, "sidecar", "pyproject.toml"), (() => {
	mkdirSync(join(dest, "sidecar"), { recursive: true });
	return join(dest, "sidecar", "pyproject.toml");
})());
copyTree(join(repoRoot, "sidecar", "uru_sidecar"), join(dest, "sidecar", "uru_sidecar"));

console.log(`Installed Uru → ${dest}`);
console.log("Next (in Obsidian, GUI): Settings → Community plugins → enable Uru, then run first-run setup.");
