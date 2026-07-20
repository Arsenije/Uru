// Reproduces the Obsidian community-plugin review locally.
//
//   npm run lint        # what the reviewer's bot runs
//   npm run typecheck   # surfaces the underlying TS errors the linter reacts to
//
// The Obsidian reviewer runs eslint-plugin-obsidianmd, which bundles
// typescript-eslint's `recommendedTypeChecked` — that's where the whole
// no-unsafe-* family comes from. Keeping this config in the repo means our
// local lint is identical to theirs, so nothing is a surprise at submission.
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: [
			"node_modules/",
			"main.js",
			"khora/",
			"tests/",
			"sidecar/",
			".test-build/",
			"**/*.mjs",
			"**/*.js",
		],
	},
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// "Uru" and "Khora" are product names, not sentence-case violations.
			"obsidianmd/ui/sentence-case": ["warn", { ignoreWords: ["Uru", "Khora"] }],
		},
	},
);
