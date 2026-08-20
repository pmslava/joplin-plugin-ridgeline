// Ridgeline viewer content script (MarkdownIt plugin).
//
// The plugin transform itself is a no-op — Ridgeline does not change the rendered Markdown. Its job
// is to ship the asset JS/CSS that build the strip inside the rendered note iframe. The asset JS runs
// with full DOM access in the iframe and is re-run on every note render (see viewer.js).
//
// Asset paths are resolved relative to this content script's directory (dist/contentScripts/), so
// 'viewer.js' / 'viewer.css' refer to dist/contentScripts/viewer.{js,css}, which the build copies
// verbatim from src/contentScripts/.

interface MarkdownItModule {
	plugin: (markdownIt: unknown) => void;
	assets: () => Array<{ name: string }>;
}

export default function (): MarkdownItModule {
	return {
		plugin: (_markdownIt: unknown) => {
			// No Markdown transform needed for the smoke build.
		},
		assets: () => [{ name: 'viewer.js' }, { name: 'viewer.css' }],
	};
}
