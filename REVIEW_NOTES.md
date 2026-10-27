# Compatibility review

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

Run `npm run verify` from one checkout. It checks manifest/package/lock/version-map
agreement and produces the exact repository manifest. Upload `main.js`, `manifest.json`
and `styles.css` from `dist/` with release notes from CHANGELOG.md. Local builds do not
modify existing GitHub releases.

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
