// The bootstrap refuses to run on Intel Macs: LanceDB (khora's vector store)
// dropped x86_64-mac wheels in v0.30, so the venv install is unsatisfiable.
// assertSupportedPlatform() turns uv's raw resolver error into a plain-language
// message before any download happens. arch !== "arm64" on darwin also catches
// Apple-Silicon Macs running Obsidian under Rosetta (they report "x64").
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertSupportedPlatform } from "../src/bootstrap/uv";

test("rejects Intel/Rosetta Macs with a plain-language reason", () => {
	assert.throws(
		() => assertSupportedPlatform("darwin", "x64"),
		/Apple Silicon Mac.*LanceDB.*Rosetta/s,
	);
});

test("allows Apple Silicon Macs", () => {
	assert.doesNotThrow(() => assertSupportedPlatform("darwin", "arm64"));
});

test("allows non-mac platforms regardless of arch", () => {
	assert.doesNotThrow(() => assertSupportedPlatform("linux", "x64"));
	assert.doesNotThrow(() => assertSupportedPlatform("win32", "x64"));
	assert.doesNotThrow(() => assertSupportedPlatform("linux", "arm64"));
});
