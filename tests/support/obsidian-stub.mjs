// Test-only stub for the `obsidian` module. The real one is only present inside
// Obsidian's Electron runtime, so bundling any src file that imports it (e.g.
// src/bootstrap/uv.ts → requestUrl) would fail under Node's test runner. These
// exports exist to satisfy the bundler's named imports; tests that exercise the
// code paths using them should pass their own doubles, not rely on these.
export function requestUrl() {
	throw new Error("requestUrl is not available in tests");
}
