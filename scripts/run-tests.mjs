// Dependency-free test runner: bundle the *.test.ts files with the esbuild we
// already depend on (resolves the plugin's extensionless TS imports), then hand
// the plain-JS output to Node's built-in test runner. Avoids adding a test
// framework or bumping @types/node just to see `node:test` types.
import esbuild from "esbuild";
import { spawnSync } from "child_process";
import { mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { readKhoraPin } from "./khora-pin.mjs";
import { sidecarEmbedPlugin } from "./sidecar-embed.mjs";

const TEST_DIR = "tests";
const OUT_DIR = ".test-build";

const entryPoints = readdirSync(TEST_DIR)
	.filter((f) => f.endsWith(".test.ts"))
	.map((f) => join(TEST_DIR, f));

if (entryPoints.length === 0) {
	console.error(`No *.test.ts files found in ${TEST_DIR}/`);
	process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await esbuild.build({
	entryPoints,
	outdir: OUT_DIR,
	bundle: true,
	platform: "node", // node builtins (fs, path, node:test) stay external
	format: "esm",
	sourcemap: "inline",
	define: {
		// Same injection as esbuild.config.mjs, so tests can import modules
		// that consume the build-time khora pin.
		__KHORA_VERSION__: JSON.stringify(readKhoraPin()),
	},
	// The real `obsidian` module only exists inside Electron; swap in a stub so
	// tests can bundle src files that import it (e.g. src/bootstrap/uv.ts).
	alias: { obsidian: join(process.cwd(), "tests", "support", "obsidian-stub.mjs") },
	// Same virtual:sidecar-files module as the real build, so tests can import
	// modules that consume the embedded sidecar (src/bootstrap/uv.ts).
	plugins: [sidecarEmbedPlugin()],
});

const outFiles = readdirSync(OUT_DIR)
	.filter((f) => f.endsWith(".js"))
	.map((f) => join(OUT_DIR, f));

const result = spawnSync("node", ["--test", ...outFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
