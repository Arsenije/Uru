// The khora pin in sidecar/pyproject.toml is the single source of truth for
// KHORA_VERSION (injected at build time — see scripts/khora-pin.mjs). These
// tests lock the parser's behavior: it finds the real pin, rejects anything
// that isn't an exact `==`, and isn't fooled by versions in nearby comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readKhoraPin } from "../scripts/khora-pin.mjs";

// Same build-time injection the plugin gets (defined in scripts/run-tests.mjs).
declare const __KHORA_VERSION__: string;

function fixture(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "khora-pin-"));
	const path = join(dir, "pyproject.toml");
	writeFileSync(path, contents);
	return path;
}

test("parses the exact pin from the real sidecar/pyproject.toml", () => {
	const pin = readKhoraPin();
	assert.match(pin, /^\d+\.\d+\.\d+$/);
});

test("the injected __KHORA_VERSION__ matches the pyproject pin", () => {
	assert.equal(__KHORA_VERSION__, readKhoraPin());
});

test("is not fooled by version numbers in comments", () => {
	const path = fixture(
		[
			"dependencies = [",
			"    # 0.13.0 predates the migration fix; 0.99.0 was never released.",
			'    "khora[sqlite-lance]==0.21.0",',
			"]",
		].join("\n"),
	);
	assert.equal(readKhoraPin(path), "0.21.0");
});

test("throws when the pin is a range instead of an exact ==", () => {
	const path = fixture('dependencies = ["khora[sqlite-lance]>=0.21"]');
	assert.throws(() => readKhoraPin(path), /exact "khora\[\.\.\.\]==X\.Y\.Z" pin/);
});

test("throws when khora is missing entirely", () => {
	const path = fixture('dependencies = ["fastapi>=0.115"]');
	assert.throws(() => readKhoraPin(path), /exact "khora\[\.\.\.\]==X\.Y\.Z" pin/);
});
