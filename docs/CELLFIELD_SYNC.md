# Updating the insiliscope CellField block

The `'microtubules'` simulation structure (cells, nuclei, cytoplasm, microtubules, dye lattice) is
not webSMLM code. It is the [insiliscope](https://github.com/kjamartens/insiliscope) C++ core,
compiled to WASM and embedded in `webSMLM.html` (MODULE: simulation) as a **generated** block
between

```
// ==== BEGIN insiliscope CellField block ====
// ==== END insiliscope CellField block ====
```

Never hand-edit that block. To change the model, change insiliscope, let its CI build a new block,
and sync it in with the procedure below.

## 1. Get `cellfield_block.js`

insiliscope's **webSMLM block** workflow (`.github/workflows/release.yml`, manual:
*Actions → webSMLM block → Run workflow*) builds the block with the pinned Emscripten and uploads it
as the artifact `cellfield_block` (a zip holding `cellfield_block.js` and its `.sha256`). Given a
release tag, it also publishes both as a GitHub release asset.

Download it with any of these:

- **Browser**: open the run page (`https://github.com/kjamartens/insiliscope/actions/runs/<run id>`)
  and download the `cellfield_block` artifact from the bottom of the page, then unzip it.
- **gh CLI**: `gh run download <run id> -R kjamartens/insiliscope -n cellfield_block -D /tmp/cf`
- **Release asset** (only if the run was given a tag):
  `gh release download <tag> -R kjamartens/insiliscope -p cellfield_block.js`

- **Committed copy**: insiliscope `main` may carry the latest block at
  `bin/websmlm/cellfield_block.js` (with its `.sha256`). This is the easiest route from a Claude Code
  cloud session: clone or fetch insiliscope and sync from that path.

The block's bytes depend on the Emscripten version (pinned as `EMSDK_VERSION` in insiliscope's
workflows). Use the CI-built file rather than a local build, so the embedded checksum always
belongs to a published build.

**Claude Code cloud sessions:** the GitHub MCP tools can list the run's artifacts
(`actions_list` → `list_workflow_run_artifacts`) and return a signed download URL
(`actions_get` → `download_workflow_run_artifact`). That URL points to
`*.blob.core.windows.net`, which the default network policy blocks, and emsdk cannot be installed
either. In that case, download the file locally, or commit it to a branch the session can read, or
allow the host in the environment's network settings.

## 2. Sync and verify

From the webSMLM checkout:

```sh
node tools/sync_cellfield.mjs path/to/cellfield_block.js          # replace the block
node tools/sync_cellfield.mjs --check path/to/cellfield_block.js  # checksum + equals the file
```

`--check` with no file only verifies the embedded block's own `sha256(module)` header.

The block header records the insiliscope commit, Emscripten version and **core C ABI**. The wrapper
throws `CellField: WASM module ABI mismatch` if the module and the wrapper disagree. The sync tool
always replaces both together, so that error means someone hand-edited the block.

## 3. Check the call site

webSMLM calls the block in exactly one place, `buildMicrotubuleStructure()` (MODULE: simulation,
just after the END marker):

```js
CellField.buildWindow(w, h, { seed, xUm, yUm, pxnm, mtDensity, cellDensity, focusUm, slabNm })
// -> { sites: [[x px, y px, z nm], ...], nCells, nMt, removed: null, packed }
```

When the ABI number changes, diff the new block's `function buildWindow` and `DEFAULTS` against the
old one:

- If an option was renamed or added, update the call site.
- New core parameters (for example ABI 5's dye labelling/activation rates) reach the model through
  `opts.params` and otherwise keep the block's `DEFAULTS`. Expose one in webSMLM only by adding a
  `simulation_mt_*` PARAMS entry and passing it through `params`.
- The block ships `labelEfficiency: 1` on purpose, because webSMLM applies its own
  `simulation_labelEfficiency` to the returned sites. Don't enable both.

## 4. Smoke test

Open `webSMLM.html` and set **Structure type** to *Microtubules*, then click **Simulate movie**. The
log should report cells, microtubules and dye sites. Then pan once with **Move 1 µm** and simulate
again; the field must shift, not re-pack. For a headless check with Playwright, load the page and
call `buildMicrotubuleStructure(128,128)` in the page context, then confirm it returns a non-empty
array.

## 5. Commit

- Bump the build letter (the `.pill` and the `#logText` seed text, see CLAUDE.md →
  *Branch & release workflow*).
- Commit the block update **on its own**, with no other changes, and name the insiliscope commit and
  ABI in the message. Example: `CellField block: insiliscope 2dca7fa (ABI 5), build 2026-09-28a`.
- Dev builds get no CHANGELOG row. The next release's entry summarises the new block.
