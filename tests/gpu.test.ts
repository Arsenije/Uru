import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVendorId, pickVendor } from "../src/bootstrap/gpu";

test("parseVendorId maps PCI vendor IDs to vendors", () => {
	assert.equal(parseVendorId("0x1002"), "amd");
	assert.equal(parseVendorId("0x10DE\n"), "nvidia"); // case + trailing newline
	assert.equal(parseVendorId("0x8086"), "intel");
	assert.equal(parseVendorId("0x1234"), "none"); // unknown vendor
	assert.equal(parseVendorId(""), "none");
});

test("pickVendor prefers a discrete GPU over integrated", () => {
	assert.equal(pickVendor(["intel", "amd"]), "amd"); // iGPU + dGPU -> dGPU
	assert.equal(pickVendor(["intel", "nvidia"]), "nvidia");
	assert.equal(pickVendor(["intel"]), "intel"); // only integrated
	assert.equal(pickVendor(["amd"]), "amd");
	assert.equal(pickVendor([]), "none");
	assert.equal(pickVendor(["none", "none"]), "none");
});

import { parseWindowsAdapters } from "../src/bootstrap/gpu";

test("parseWindowsAdapters maps adapter names to a vendor", () => {
	assert.equal(parseWindowsAdapters(["NVIDIA GeForce RTX 4070"]), "nvidia");
	assert.equal(parseWindowsAdapters(["AMD Radeon RX 7600"]), "amd");
	assert.equal(parseWindowsAdapters(["Radeon(TM) Graphics"]), "amd");
	assert.equal(parseWindowsAdapters(["Intel(R) UHD Graphics 630"]), "intel");
	assert.equal(
		parseWindowsAdapters(["Intel(R) UHD Graphics 630", "NVIDIA GeForce RTX 4070"]),
		"nvidia", // laptop iGPU + dGPU -> discrete
	);
	assert.equal(parseWindowsAdapters([]), "none");
	assert.equal(parseWindowsAdapters(["Microsoft Basic Display Adapter"]), "none");
});
