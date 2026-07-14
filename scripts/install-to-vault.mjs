#!/usr/bin/env node
/**
 * Deploy a built Uru into an Obsidian vault's plugin folder.
 *
 *   node scripts/install-to-vault.mjs "<path-to-vault>"     (or set URU_VAULT)
 *
 * Copies everything the plugin needs at runtime — main.js (which carries the
 * embedded Python sidecar), manifest.json, and styles.css. Run `npm run
 * build` first, or use `npm run install-plugin` which builds then deploys.
 *
 * GUI steps still can't be automated: after this, enable Uru in Obsidian and
 * run first-run setup.
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "fs";
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

// The bundle + metadata. The Python sidecar is embedded inside main.js
// (scripts/sidecar-embed.mjs), so these three files are the whole plugin —
// same shape as an Obsidian community-directory install.
for (const f of rootFiles) copyFileSync(join(repoRoot, f), join(dest, f));

// Clean up the sidecar/ folder older deploys copied here; the bootstrap no
// longer reads it and a stale copy would only mislead debugging. Guard: when
// the plugin dir is a symlink to this repo (dev setup), dest/sidecar IS the
// repo's sidecar source — never delete that.
const staleSidecar = join(dest, "sidecar");
if (existsSync(staleSidecar) && realpathSync(staleSidecar) !== realpathSync(join(repoRoot, "sidecar"))) {
	rmSync(staleSidecar, { recursive: true, force: true });
}

console.log(`Installed Uru → ${dest}`);
console.log("Next (in Obsidian, GUI): Settings → Community plugins → enable Uru, then run first-run setup.");
