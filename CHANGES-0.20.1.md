# Watch-only repair — 0.20.1 source release

This archive contains revised source, not a compiled extension. The original archive did not include extension/pkg or vendor/neptune-core. Rebuild BOTH WASM modules before loading it: the rollback repair adds a new light-WASM method. Do not mix these JavaScript files with an old WASM build.

## Changes

- Home watch cards refresh during scans and show block progress, separate from spendable funds.
- Catch-up saves every completed batch before reporting progress. Interrupted downloads retain completed work.
- Catch-up work is discovered from the saved wallet state after service-worker/session restarts.
- User actions interrupt background block downloads. Concurrent sync requests share one run instead of queuing repeated runs.
- Fixed a stale-state write after releasing old transaction reservations.
- Watch forms survive navigation within the open panel. Keys are cleared when the wallet returns to the locked/welcome screen. Closing the panel does not save secret drafts.
- Removing a watched address uses a stable confirmation dialog and clears obsolete scan status.
- Generation and Hybrid viewing keys can be added together under one name. Both additions succeed together or neither is saved. Each appears as its own card with the shared label.
- Saved contacts support two receiving addresses. The send picker offers each address separately. Existing single-address contacts remain compatible. Contact writes use the existing encrypted store and are serialized.
- Standard scanning uses one request at a time; Fast track uses three ordered downloads in parallel. Both read all required blocks and use the configured sync server. This is NOT indexed fast restore for watch-only keys. A shortcut opens existing node/server configuration.
- Hide balances globally, or hide individual watched assets on the home page. Hidden assets continue scanning and can be shown again. These are display preferences, not deletion or encryption features.
- Watch registrations survive chain rollback; rescan resets watch coin/cursor data instead of carrying stale scan results onto a new chain state.
- Corrected Tor's proxy permission from optional to required. Chrome does not support proxy as an optional permission: https://developer.chrome.com/docs/extensions/reference/api/permissions . The toggle checks permission instead of attempting an unsupported request. Separate errors identify policy control, another extension, and proxy application failures.

## Build and installation

Use a development machine with Rust, rustup, wasm-pack, Git and platform compiler tools installed. From this directory run:

```sh
bash scripts/build.sh
```

The existing build script fetches the pinned Neptune dependencies and creates extension/pkg/light and extension/pkg/prover. Then reload the existing extension through Chrome's extensions page and accept the required proxy permission. Tor still needs a running local Tor SOCKS service (the existing UI supports ports 9150/9050). No Tor service is bundled.

Keep a backup of the original build and recovery material. This source update has not been tested with real funds or a live node.

## Validation and remaining limitations

- 11 Node regression tests pass, covering partial scan persistence, responsive yielding, atomic paired adds, durable progress recovery, contact duplicates, Tor policy errors/manifest, removal state, transport cancellation, draft navigation and error display.
- JavaScript syntax checks pass for modified modules.
- Browser layout/interaction automation could not run: this host blocked browser process startup. The UI tests use a mocked DOM, not a browser.
- Rust compilation and Rust tests could not run: this host has no Rust toolchain or vendored Neptune dependencies. Rollback/rescan changes need compilation and chain/reorg integration testing.
- Live sync, real Generation/Hybrid keys, Tor routing and full install/upgrade behavior have not been verified.
- New controls use English text; existing translated controls remain intact. Complete localization of new labels is pending.
- Indexed fast restore for external watch-only keys is not implemented by the existing wallet engine. Fast track accelerates block download concurrency only.
- This addresses the identified paths; it is not a claim that all wallet bugs have been eliminated.

## GitHub package

This package omits Node tests and inline Rust unit-test modules. The GitHub workflow performs compile checks and builds both WASM modules without running unit tests. The previous 48-test result belongs to the separate local verification copy.
