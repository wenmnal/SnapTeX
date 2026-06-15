# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run watch          # parallel tsc --noEmit + esbuild --watch (extension + both webview bundles)
npm run compile        # check-types + lint + dev build (single shot)
npm run package        # production minified build (used by vscode:prepublish)
npm run check-types    # tsc --noEmit only
npm run lint           # eslint src
npm run pretest        # compile-tests (tsc -> out/) + dev build + lint; required before `npm test`
npm test               # runs vscode-test against out/test/**/*.test.js (downloads VS Code, launches extensionHost)
```

Run a single test by setting Mocha's grep on the prebuilt output:

```bash
npm run compile-tests && npx vscode-test --grep "LatexDocument source mapping"
```

`F5` in VS Code launches the extension host via `.vscode/launch.json` (runs the default `watch` task first).

Two TypeScript pipelines run in parallel:
- `dist/extension.js` — Node CommonJS bundle (extension host entry: `src/extension.ts`).
- `media/webview-main.js` and `media/webview-pdf.js` — browser IIFE bundles (entries under `src/webview/`).
Test output goes to `out/` (via `tsc -p .`, separate from the esbuild bundles).

## Architecture

SnapTeX is a LaTeX previewer that does NOT shell out to a TeX distribution. It parses LaTeX itself, converts blocks into HTML via Markdown-it + KaTeX, and ships incremental patches to a webview that lazily mounts blocks near the viewport. There are two hosts with a single message contract between them.

### Extension host (Node, bundled to `dist/extension.js`)

Pipeline: `extension.ts` → `panel.ts` → `document.ts` → `renderer.ts` → `rules.ts`+`scanner.ts` → message back to webview.

- **`extension.ts`** — only place that touches VS Code editor/selection events. Owns commands (`snaptex.start`, `snaptex.toggleAutoScroll`, `snaptex.syncToPreview`, and internal `snaptex.internal.revealLine` / `snaptex.internal.syncScroll`), debounced live preview, and cursor/scroll sync state. Delegates all parsing and rendering elsewhere.
- **`panel.ts` — `TexPreviewPanel`** — singleton webview owner. Validates inbound messages via `isWebviewToExtensionMessage`, resolves local image/PDF paths to `webview.asWebviewUri`, enforces path containment with `isUriWithinAllowedRoots`, queues `update()` calls (serializes via `_updateRunning` + `_pendingRootUri`), and waits for `WebviewLoaded` before parsing.
- **`document.ts` — `LatexDocument`** — implements the `RenderDocumentView` port. Flattens `\input`/`\include` (incl. subfile preamble extraction in `extractPortablePreambleLines`), produces compact source maps (`sourceFileIndices: Uint16Array`, `sourceLines: Int32Array`, `filePool: string[]`), and emits `BlockTextSpan[]` rather than duplicating block strings. Call `releaseTextContent()` after the renderer snapshots — `bodyText` is transient.
- **`renderer.ts` — `SmartRenderer`** — stateless w.r.t. VS Code. Holds `lastBlocks: BlockSnapshot[]` between renders. Each render:
  1. Hashes blocks (metadata-sensitive blocks rehashed against `metaFingerprint` so `\maketitle` reacts to title/author/date).
  2. Diffs hashes via `DiffEngine.compute` (single contiguous changed window).
  3. Returns either a `'patch'` payload (insert/delete window only) or a `'full'` payload. Full update threshold is a fixed 50-changed-block heuristic.
  4. When `options.deferFullHtml` is set (virtual mode), the full payload sends `blocks` metadata only; the webview later asks for each block via `RequestBlockHtml` and the renderer resolves it from `lastTextSnapshot` through `renderBlockByIndex`.
  Citation state is global: `_citedKeys` accumulates across blocks and the bibliography block is force-refreshed via `dirtyBlocks` when keys change outside the patch window.
- **`rules.ts` + `rule-floats.ts` + `rule-tikz.ts` + `rule-helpers.ts`** — ordered preprocessing pipeline (`DEFAULT_PREPROCESS_RULES`, sorted by `priority`) that runs before Markdown-it. Any generated HTML MUST round-trip through `RenderContext.protectHtml` so the `html: false` Markdown-it parser doesn't escape it.
- **`protection.ts` — `ProtectionManager`** — stores rule-generated HTML behind `XSNAP:namespace:idY` tokens, restored after Markdown-it. `resolve()` walks up to 15 nested levels and also unwraps `<p>...</p>` paragraphs Markdown-it wrapped around bare tokens.
- **`scanner.ts` — `LatexCounterScanner`** — second pass that assigns equation/section/figure/table/algorithm/theorem numbers and produces a `labelMap` consumed by `\ref`/`\eqref` resolution.
- **`splitter.ts`** — splits cleaned body text into blocks at paragraph/environment boundaries with brace-balance and unmatched-env recovery (`maxLines = 40` emergency cut). TikZ pictures are exempt from emergency splitting.
- **`patterns.ts`** — single source of truth for supported environment lists (math, float, theorem, section levels, citation cmds, splitter major/ignored envs). Update here when adding env support; splitter, scanner, and rules all consume the same constants.
- **`file-provider.ts`** — `IFileProvider` interface (`read`/`exists`/`stat`/`resolve`/`dir`). `VscodeFileProvider` prefers open dirty editors over disk reads. Tests use `MemoryFileProvider` from `src/test/test-helpers.ts`.

### Webview host (browser, IIFE bundles under `media/`)

- **`src/webview/main.ts`** — `// @ts-nocheck`'d on purpose; uses `acquireVsCodeApi`, hosts the `TooltipManager`, the patch applier, KaTeX rendering, click/scroll sync back to the extension, and TikZ orchestration.
- **`src/webview/virtualization.ts` — `BlockVirtualizationController`** — when `snaptex.virtualMode` is on, only blocks near the viewport are mounted as real DOM; offscreen blocks become measured "shells" preserving scroll geometry. Lazy block HTML arrives via `RequestBlockHtml`/`BlockHtml`.
- **`src/webview/tikz.ts`** and **`src/webview/pdf.ts`** — heavy resources (TikZJax worker, PDF.js canvases) are lazy-loaded and released when far offscreen.
- **`src/webview-messages.ts`** — TypeScript message contract used by BOTH sides (extension imports types directly; webview bundle inlines them). Add new commands by extending both `*ToExtensionCommand` consts AND `isWebviewToExtensionMessage` validation; `assertNever` enforces exhaustiveness.

### Build-time TikZJax patching (`esbuild.js`)

The `copyAssetsPlugin` copies KaTeX/PDF.js/TikZJax assets from `node_modules` to `media/vendor/` on every build, then `patchTikzJaxWorkerBootstrap` text-patches the copied `tikzjax.js` and `run-tex.js` so the worker bootstrap works inside a VS Code webview (blob-URL worker, asset preloading, terminate-cleanup, stale-script guards, compile-failure custom event). The patcher is idempotent (`replaceOrThrow` skips when the replacement is already present) but THROWS if the original source no longer matches — upgrading `@planktimerr/tikzjax` requires updating `createTikzJaxSourcePatches`/`createRunTexSourcePatches`.

`media/vendor/` is gitignored — assets only exist after a build. `media/webview-main.js` and `media/webview-pdf.js` are also build artifacts (not in `src/`).

### Sync model

- Editor → preview: cursor/scroll position → `getFlattenedLine` (file+line into the flattened body) → `getBlockIndexByLine` (block index + intra-block ratio) → `ScrollToBlock` message + anchor snippet.
- Preview → editor: webview click/scroll → `RevealLine`/`SyncScroll` → `getSourceSyncData` → `snaptex.internal.revealLine` opens the right file even after `\input` flattening.
- A short `isSyncingFromPreview` lock (500 ms) prevents ping-pong loops.

## Conventions

- New LaTeX environment support: add to the appropriate list in `patterns.ts`, then teach `splitter.ts`/`scanner.ts`/`rules.ts` if it needs special treatment.
- Any rule emitting HTML must wrap it with `renderer.protectHtml(namespace, html)` — Markdown-it runs with `html: false`.
- Anything new the renderer needs from the parsed document goes on `RenderDocumentView` (in `types.ts`), not directly on `LatexDocument`.
- Webview ↔ extension messages: only via `webview-messages.ts`. Don't post ad-hoc objects.
- Don't read `bodyText` after `releaseTextContent()` — go through `lastTextSnapshot` / `renderBlockByIndex` instead.
