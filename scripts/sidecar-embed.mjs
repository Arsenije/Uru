// Embed the Python sidecar source into main.js as a virtual module.
//
// Obsidian's community-directory installer downloads ONLY main.js,
// manifest.json, and styles.css — a sidecar/ folder shipped next to them would
// never reach directory-install users, and their first-run bootstrap would
// fail. So the sidecar rides inside main.js instead: this plugin reads
// sidecar/pyproject.toml plus every uru_sidecar/*.py at build time and exposes
// them as `virtual:sidecar-files` (a { "relative/path": "contents" } map).
// The bootstrap (src/bootstrap/uv.ts) writes the map back out to app-data and
// `uv pip install`s it from there. Globbed at build time, so a new sidecar
// module can never be forgotten in a hand-maintained import list.
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const SIDECAR_DIR = "sidecar";

/** Read the embeddable sidecar source: pyproject.toml + the uru_sidecar package
 *  (dev-only sidecar/scripts/ and caches are deliberately excluded). */
export function sidecarFiles(root = ".") {
	const dir = join(root, SIDECAR_DIR);
	const files = {
		"pyproject.toml": readFileSync(join(dir, "pyproject.toml"), "utf8"),
	};
	const pkg = join(dir, "uru_sidecar");
	for (const f of readdirSync(pkg).filter((f) => f.endsWith(".py")).sort()) {
		files[`uru_sidecar/${f}`] = readFileSync(join(pkg, f), "utf8");
	}
	return files;
}

export function sidecarEmbedPlugin() {
	return {
		name: "sidecar-embed",
		setup(build) {
			build.onResolve({ filter: /^virtual:sidecar-files$/ }, (args) => ({
				path: args.path,
				namespace: "sidecar-embed",
			}));
			build.onLoad({ filter: /.*/, namespace: "sidecar-embed" }, () => {
				const files = sidecarFiles();
				return {
					contents: `export default ${JSON.stringify(files)};`,
					loader: "js",
					// Re-embed on sidecar edits during `npm run dev` watch.
					watchFiles: Object.keys(files).map((rel) => resolve(SIDECAR_DIR, rel)),
					watchDirs: [resolve(SIDECAR_DIR, "uru_sidecar")],
				};
			});
		},
	};
}
