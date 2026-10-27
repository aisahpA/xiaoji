# Compatibility review

## 0.16.4

- Quick capture has one persisted shortcut and a scope toggle, enabled globally by default. Legacy global/native bindings migrate into that setting; paused recording, local document listeners, popout teardown and persistence rollback have focused coverage.
- Transferring quick capture to the main composer focuses the end of the complete merged draft, including Unicode text. A failed write restores the previous draft.
- Automatic Codex discovery verifies installed executables with `--version` and compares versions, including prereleases; an explicit path remains authoritative. It does not install/update software or alter global configuration. Windows desktop discovery and PATH resolution are verified here; macOS/Linux discovery still requires device verification.
- The prior PATH CLI was 0.146.0 and exposed only 5.6 models. The desktop-bundled 0.164.0-alpha.11.1 exposes eight models including gpt-6.1-sol, which completed a synthetic streaming request. The earlier rejection was specific to the old runtime connection, not proof of a universal account restriction.
- Connection discovery and inference validation are separate. The configured default is retained even when missing from a catalog; no model is silently substituted. Diagnostics omit credentials and account identifiers. Model validation uses a static prompt without memos and cancels when settings close or change.
- Final gates: lint has zero errors and nine existing compatibility warnings; strict type checking, 392 tests in 23 files and production build pass. Eleven checks in the isolated Obsidian 1.14.4/Electron 45 host cover the production bundle, scope ownership, native settings toggles, continued draft selection, carets, conflicts, cache and recovery. A real OS key event created one visible quick window while the main window remained minimized. Mobile, macOS/Linux and third-party theme validation remain outstanding.

## 0.16.3

- Desktop-only capabilities use guarded host bridges; mobile retains capture and API functionality. Global shortcuts release only their successfully registered accelerator. Conflicts retain the prior binding.
- Codex uses a native CLI executable over stdio without a command shell. Requests use an empty temporary working directory, ephemeral read-only threads, disabled shell/plugin/hook/app features and explicitly disabled inherited MCP servers. Credentials remain with Codex. Both providers retain bounded memo retrieval and local count/list queries.
- CLI 0.146.0 handshake, model discovery and effective ephemeral/read-only/tool settings were verified. A synthetic streaming response succeeded with gpt-5.6-sol. That old runtime connection rejected the configured gpt-6.1-sol; see 0.16.4 for the corrected runtime diagnosis and successful newer-runtime validation.
- Full release verification passed: zero lint errors and nine existing compatibility warnings, strict type checking, 379 tests in 21 files, and production build.
- Actual Windows OS key injection verified first-time quick-window creation and restoration of a minimized quick window while the main Obsidian window stayed minimized. In each case one quick window became visible and focused. Computer Use targeted only the dedicated test window.
- Official Obsidian 1.14.4 application code in an isolated Electron 45 host checked dark/light cursors, preserved input/selection, native key conflicts/replacement, cache hits, renderer Codex discovery and external-chat recovery. Physical mobile, macOS/Linux global hotkeys, third-party themes and real large-vault latency remain unverified.

Conversation recovery creates a separate conversation and preserves its source. Imported text is untrusted context and cannot restore verified memo citations. Serialization normalizes line endings so CRLF content remains reloadable.

This maintenance release preserves the existing layout, commands, Markdown format,
streaming answers, permanent conversation deletion and Obsidian 1.8.7 support.

## Intentional warnings

The official ESLint recommended configuration is enabled without disabling rules.
The following warnings remain visible because changing them affects existing behavior:

- `Vault.delete`: only explicit permanent conversation deletion and recognized legacy
  trash cleanup use this API. Ordinary memo deletion uses the plugin's Markdown Trash.
  Replacing these calls with `trashFile` changes recovery semantics.
- `fetch`: provides SSE and cancellation; `requestUrl` remains the non-streaming CORS
  fallback. Replacing it globally removes streaming behavior.
- `getSettingDefinitions`: adopting the declarative API changes host settings rendering.
  The existing four-tab interface and 1.8.7 support are retained; native settings search
  integration is deferred.
- Deprecated `keyCode`: 229 is retained alongside `isComposing` for IME confirmation.
- Deprecated `execCommand`: retained for clipboard fallback and undo-preserving textarea
  insertion. Modern clipboard APIs remain the primary path.
- Deprecated slider tooltip API: retained for the existing behavior on older hosts.

CSS `vh` / `dvh` fallbacks and narrowly scoped `!important` overrides remain intentional.
The current waterfall layout uses CSS Grid, not multicolumn. The clipped live-status
region must remain available to assistive technology. Removing these solely for scanner
heuristics may regress mobile sizing, editor typography or accessibility.

## Release consistency

Run `npm run verify` and `npm run package` from one checkout. The packager checks
manifest/package/lock/version-map agreement and packages the exact repository manifest.
Upload `main.js`, `manifest.json` and `styles.css` from that same build, with release notes
from CHANGELOG.md. Local builds do not modify existing GitHub releases.

The verification workflow has read-only repository permissions and uploads build artifacts.
It does not publish releases or create provenance attestations. Attestations need separately
authorized GitHub permissions and repository support.

Automated checks are distinct from real Obsidian desktop/mobile and third-party-theme
testing. Passing these gates does not establish that every device has been tested.

## 0.16.2 verification

Lint completed with no errors and nine retained compatibility warnings. Type checks,
357 automated tests, the production build and three-file archive integrity checks passed.
An isolated Obsidian 1.14.4 harness checked Markdown highlights, offscreen component
release/remount and waterfall overlap using synthetic in-memory scale fixtures.

Lightweight placeholders remain per loaded memo. Hidden-host frame callback waits were
439-503 ms; their cause was not established. Synchronous click-handler timings alone
do not establish visible-window responsiveness. Physical mobile, third-party themes,
visible desktop frame latency and large-vault cold indexing remain unverified.
