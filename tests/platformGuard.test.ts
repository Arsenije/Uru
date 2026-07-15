// The bootstrap refuses to run on Intel Macs: LanceDB (khora's vector store)
// dropped x86_64-mac wheels in v0.30, so the venv install is unsatisfiable.
// assertSupportedPlatform() turns uv's raw resolver error into a plain-language
// message before any download happens. arch !== "arm64" on darwin also catches
// Apple-Silicon Macs running Obsidian under Rosetta (they report "x64").
// It also refuses macOS older than 13.3 (Darwin kernel 22.4): llama.cpp release
// binaries link Accelerate BLAS symbols (_cblas_sgemm$NEWLAPACK$ILP64) that
// Apple added in 13.3, so llama-server aborts at dyld time on older macOS.
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertSupportedPlatform } from "../src/bootstrap/uv";

test("rejects Intel/Rosetta Macs with a plain-language reason", () => {
	assert.throws(
		() => assertSupportedPlatform("darwin", "x64"),
		/Apple Silicon Mac.*LanceDB.*Rosetta/s,
	);
});

test("rejects macOS older than 13.3 with a plain-language reason", () => {
	// Darwin 21.x = macOS 12 (Monterey)
	assert.throws(
		() => assertSupportedPlatform("darwin", "arm64", "21.6.0"),
		/macOS 13\.3.*llama\.cpp.*Software Update/s,
	);
	// Darwin 22.0–22.3 = macOS 13.0–13.2
	assert.throws(() => assertSupportedPlatform("darwin", "arm64", "22.3.0"), /macOS 13\.3/);
});

test("allows Apple Silicon Macs on macOS 13.3 or newer", () => {
	assert.doesNotThrow(() => assertSupportedPlatform("darwin", "arm64", "22.4.0")); // macOS 13.3
	assert.doesNotThrow(() => assertSupportedPlatform("darwin", "arm64", "23.5.0")); // macOS 14
	assert.doesNotThrow(() => assertSupportedPlatform("darwin", "arm64", "25.4.0")); // macOS 26
});

test("allows non-mac platforms regardless of arch or kernel version", () => {
	assert.doesNotThrow(() => assertSupportedPlatform("linux", "x64", "5.15.0"));
	assert.doesNotThrow(() => assertSupportedPlatform("win32", "x64", "10.0.19045"));
	assert.doesNotThrow(() => assertSupportedPlatform("linux", "arm64", "6.8.0"));
});
