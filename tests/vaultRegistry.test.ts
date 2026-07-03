import { test } from "node:test";
import assert from "node:assert/strict";

import {
	applyTouch,
	computeOtherActiveVaults,
	sameVaultPath,
	type VaultRegistryEntry,
} from "../src/vaultRegistry";

const entry = (vaultKey: string, vaultPath: string): VaultRegistryEntry => ({
	vaultKey,
	vaultPath,
	vaultName: vaultPath.split("/").pop() ?? vaultPath,
	lastSeen: 0,
});

const reg = (...entries: VaultRegistryEntry[]): Record<string, VaultRegistryEntry> =>
	Object.fromEntries(entries.map((e) => [e.vaultKey, e]));

test("sameVaultPath normalizes before comparing", () => {
	assert.equal(sameVaultPath("/a/b", "/a/b/"), true);
	assert.equal(sameVaultPath("/a/b", "/a/x/../b"), true);
	assert.equal(sameVaultPath("/a/b", "/a/c"), false);
	assert.equal(sameVaultPath(undefined, "/a/b"), false);
	assert.equal(sameVaultPath("/a/b", undefined), false);
});

test("computeOtherActiveVaults excludes the current vault by key", () => {
	const r = reg(entry("k1", "/vault/one"), entry("k2", "/vault/two"));
	const others = computeOtherActiveVaults(r, "k1", "/vault/one");
	assert.deepEqual(
		others.map((v) => v.vaultKey),
		["k2"],
	);
});

test("computeOtherActiveVaults excludes a stale same-path entry under a different key", () => {
	// The reported bug: this vault reinstalled under a new key; the old entry
	// (same path, old key) must NOT count as another vault.
	const r = reg(entry("old-key", "/Users/me/Obsidian Vault"));
	const others = computeOtherActiveVaults(r, "new-key", "/Users/me/Obsidian Vault");
	assert.deepEqual(others, []);
});

test("computeOtherActiveVaults keeps a genuinely different vault", () => {
	const r = reg(entry("k2", "/vault/other"));
	const others = computeOtherActiveVaults(r, "k1", "/vault/mine");
	assert.deepEqual(
		others.map((v) => v.vaultKey),
		["k2"],
	);
});

test("computeOtherActiveVaults with no current path falls back to key-only matching", () => {
	const r = reg(entry("k1", "/vault/mine"), entry("k2", "/vault/other"));
	const others = computeOtherActiveVaults(r, "k1", undefined);
	assert.deepEqual(
		others.map((v) => v.vaultKey),
		["k2"],
	);
});

test("applyTouch evicts a same-path orphan and records the current entry", () => {
	const before = reg(entry("old-key", "/Users/me/Obsidian Vault"));
	const after = applyTouch(before, entry("new-key", "/Users/me/Obsidian Vault"));
	assert.deepEqual(Object.keys(after), ["new-key"]);
});

test("applyTouch leaves entries for other paths untouched", () => {
	const before = reg(entry("k2", "/vault/other"));
	const after = applyTouch(before, entry("k1", "/vault/mine"));
	assert.deepEqual(Object.keys(after).sort(), ["k1", "k2"]);
});

test("applyTouch overwrites the entry for the same key", () => {
	const before = reg(entry("k1", "/vault/mine"));
	const updated = { ...entry("k1", "/vault/mine"), lastSeen: 123 };
	const after = applyTouch(before, updated);
	assert.equal(after["k1"].lastSeen, 123);
	assert.equal(Object.keys(after).length, 1);
});
