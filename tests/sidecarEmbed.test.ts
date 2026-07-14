// The community-directory install path depends entirely on the sidecar source
// travelling inside main.js (Obsidian downloads only main.js/manifest.json/
// styles.css). These tests pin the embed's contract: everything uv needs to
// pip-install the sidecar is present, and nothing dev-only leaks in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "fs";
import { join } from "path";

// The same glob the build uses to produce virtual:sidecar-files.
import { sidecarFiles } from "../scripts/sidecar-embed.mjs";

test("embeds pyproject.toml and the full uru_sidecar package", () => {
	const files = sidecarFiles();
	assert.ok(files["pyproject.toml"].includes('name = "uru-sidecar"'));
	// Every .py in the package on disk must be embedded — a forgotten module
	// would ship a broken install to every directory-install user.
	const onDisk = readdirSync(join("sidecar", "uru_sidecar")).filter((f) => f.endsWith(".py"));
	assert.ok(onDisk.length >= 9, `suspiciously few sidecar modules on disk (${onDisk.length})`);
	for (const f of onDisk) {
		const key = `uru_sidecar/${f}`;
		assert.ok(files[key], `missing embedded file: ${key}`);
		assert.ok(files[key].length > 0, `embedded file is empty: ${key}`);
	}
});

test("excludes dev-only sidecar files", () => {
	const keys = Object.keys(sidecarFiles());
	assert.ok(keys.every((k) => k === "pyproject.toml" || k.startsWith("uru_sidecar/")));
	assert.ok(!keys.some((k) => k.includes("scripts/")), "dev scripts must not be embedded");
});
