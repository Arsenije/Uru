/** Provided by scripts/sidecar-embed.mjs (esbuild plugin): the Python sidecar
 *  source embedded into main.js, as { "relative/path": "file contents" }. */
declare module "virtual:sidecar-files" {
	const files: Record<string, string>;
	export default files;
}
