# Escanour Wallet 0.22.0 — Parameters and recovery repair

The separate dashboard has been removed. Network information, block reading, portfolios, contact activity, payments, node health, backup, authenticator and helper pages now open inside **Parameters → Wallet tools**, with the wallet's existing back navigation, colors, cards and theme. The home page uses its original layout and watch rows.

## Recovery changes

**Parameters → Wallet tools → Restore this wallet** lets you rebuild the scan with the current seed. Contacts and viewing keys are retained. Choose Fast restore, Fast with my own node, or Private full scan. The own-node option requires a configured local node. Change node/server and Restore another seed buttons are available; the existing recovery-phrase file import remains available in that flow.

- The server test probes indexed announcement lookup **and** membership-proof recovery, using typed Neptune RPC request encodings. It no longer calls one successful empty lookup a complete fast-restore capability test.
- Connectivity/timeout/routing failures are no longer all reported as “unsupported.” The original failure detail is retained and visible in the recovery page.
- Flag requests use small batches and can split further when a node reports a size limit. Membership-proof recovery starts at 64 coins per request and shrinks on size/timeout limits. Proof validation is unchanged.
- Requests use a service-worker-friendly timeout. Progress writes are ordered so a late update cannot overwrite completion.
- Pending recovery and failure details are encrypted and survive a worker/browser restart.
- A restore from height zero is recognized as a restore. Genesis-only networks are handled without requesting unavailable block zero through RPC.
- Premine/unannounced coins require a full scan and are kept out of the indexed shortcut.
- Outdated compiled modules now produce an explicit rebuild/reload message.

A successful connection test does not prove that a node supports all recovery requests or can recover a particular wallet. A genuinely missing UTXO index/membership recovery service still requires a suitable node or the private full scan. This update has not been verified against your live node; the new failure detail is intended to make that verification actionable.

## Display and languages

Hide balances displays the literal text `**`; cards and asset rows remain visible. The wallet's balances, watch amounts, history amounts and portfolio amounts use the same masking behavior. Amounts entered for a transaction and its approval review remain visible so the payment can be checked before approval.

English, French and Arabic are retained. Spanish, German and Portuguese were added for the core interface and Parameters labels/recovery controls. Secondary explanations and raw technical node errors may fall back to English. Recovery seed word lists have not changed.

## GitHub build package

The seven reported `neptune-consensus` browser-build warnings are addressed in the vendoring step. Six imports are restricted to native targets, matching the clock/subprocess implementations. The three scope-logger metadata fields retained by the no-op WASM logger have field-level, WASM-only dead-code annotations. Native logging remains intact; no crate-wide warning suppression was added. The cleanup checks the pinned declarations and aborts if the expected source layout changes. GitHub's next Rust/WASM build still needs to confirm the result.

The upload package has no Node unit-test folder, no inline Rust unit-test modules, and no unit-test GitHub job, as requested. `.github/workflows/build.yml` keeps compilation checks and the WASM build. Local verification tests remain in the separate working copy.

Upload the contents of this source directory at your repository root. Let GitHub Actions complete the build, download its compiled extension artifact, and reload that compiled `extension/` in the browser. Do not mix these JavaScript files with older WASM modules: 0.22.0 adds fast-probe and adaptive-proof-batch exports.

## Validation limits

59 local automated tests pass, including integrated Parameters handlers, literal-star masking, six-language selection, explicit retry, failure classification, adaptive request sizes, ordered progress writes, encryption of recovery details, and the previous security/Tor checks. Syntax checks pass for 18 extension JavaScript files. The vendoring warning cleanup is separately checked with representative source fixtures for target-specific changes, repeat runs and refusal of unexpected declarations.

Tests use mocked browser/WASM/node interfaces where applicable. This machine still lacks the Rust/WASM toolchain, and visual browser testing remains unavailable under the browser security policy. No live-node restore, full browser rendering or real-fund send is certified. The security boundaries in `SECURITY-REVIEW-0.21.0.md` and `docs/SECURITY.md` continue to apply.

## Verification copy

Reported local test results belong to the separate working copy. This GitHub upload package omits Node tests and inline Rust unit-test modules, while retaining compilation checks and the WASM build.
