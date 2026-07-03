#!/usr/bin/env node
/**
 * Headless staging check for assistant-led installs.
 *
 * Confirms the Uru plugin files are correctly placed in a vault BEFORE the user
 * opens Obsidian — the one part of the install an assistant can verify without a
 * GUI. Exit 0 + "OK:" on success; exit 1 + "FAIL:" with reasons otherwise.
 *
 * Works for BOTH install paths — build-from-source and prebuilt release-zip —
 * since it only inspects the staged files. It ships inside the release zip too,
 * so a release-zip install can run it without cloning the repo:
 *
 *   node scripts/verify-staging.mjs "<path-to-vault>"                 # from a source clone
 *   node "<VAULT>/.obsidian/plugins/uru/verify-staging.mjs" "<VAULT>" # from a release-zip install
 *
 * Accepts either the vault root (it appends .obsidian/plugins/uru) or the plugin
 * directory itself.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

const arg = process.argv[2];
if (!arg) {
	console.error('usage: node scripts/verify-staging.mjs "<path-to-vault>"');
	process.exit(2);
}

// Accept the plugin dir directly, or a vault root.
const dir =
	basename(arg) === "uru" && existsSync(join(arg, "manifest.json"))
		? arg
		: join(arg, ".obsidian", "plugins", "uru");

const problems = [];
if (!existsSync(dir)) {
	problems.push(`plugin directory not found: ${dir}`);
}

for (const f of ["main.js", "manifest.json", "styles.css"]) {
	const p = join(dir, f);
	if (!existsSync(p)) problems.push(`missing file: ${f}`);
	else if (statSync(p).size === 0) problems.push(`empty file: ${f}`);
}

// The Python sidecar must ship inside the plugin folder — the first-run
// bootstrap pip-installs it. A plugin that loads but lacks this can't start
// its backend.
for (const f of ["sidecar/pyproject.toml", "sidecar/uru_sidecar/__main__.py"]) {
	if (!existsSync(join(dir, f))) problems.push(`missing sidecar file: ${f}`);
}

let manifest;
const manifestPath = join(dir, "manifest.json");
if (existsSync(manifestPath)) {
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.id !== "uru") {
			problems.push(`manifest id is "${manifest.id}", expected "uru"`);
		}
	} catch (e) {
		problems.push(`manifest.json is not valid JSON: ${e.message}`);
	}
}

if (problems.length) {
	console.error("FAIL: Uru is not staged correctly:");
	for (const p of problems) console.error(`  - ${p}`);
	console.error(`\nExpected ${dir}/ to contain main.js, manifest.json, styles.css, and sidecar/.`);
	process.exit(1);
}

console.log(`OK: Uru ${manifest.version} staged at ${dir}`);
console.log(
	"Next (in Obsidian, GUI): Settings → Community plugins → enable Uru, then run first-run setup.",
);
