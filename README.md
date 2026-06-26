# Uru

An [Obsidian](https://obsidian.md) plugin that brings a knowledge graph + vector search to your vault, powered by [khora](./khora).

## Layout

```
Uru/
├── manifest.json        # Obsidian plugin manifest
├── main.ts              # plugin entry point
├── package.json         # build tooling (esbuild + TypeScript)
├── esbuild.config.mjs
├── tsconfig.json
├── styles.css
└── khora/               # khora library (knowledge graph + vector search backend)
```

## Develop

```bash
npm install
npm run dev      # watch + rebuild main.js
```

For local testing, symlink/copy this folder into
`<vault>/.obsidian/plugins/uru/` and enable it in Obsidian's community plugin
settings. See the [Obsidian plugin guide](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin).

## License

MIT
