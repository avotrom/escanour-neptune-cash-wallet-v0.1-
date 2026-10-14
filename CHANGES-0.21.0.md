# Escanour Neptune Wallet 0.21.0 — source update

This is an uncompiled source release. Rebuild both WASM modules before loading the extension: the new dashboard and backup functions require the revised light-WASM exports. The original supplied ZIP had no compiled modules or vendored dependencies.

## Included features

| Feature | Behavior |
| --- | --- |
| Network dashboard | Shows saved chain/wallet heights and scan state. An explicit node check loads recent block timestamps and an average of observed intervals. |
| Block inspector | Queries a block by height and shows its height and timestamp. Hash/transaction search is not implemented. |
| Payment tracker | Shows queued, preparation, proving, broadcast and observed confirmation stages. Broadcast completion is not presented as chain confirmation. |
| Contact activity feed | Combines watched receipts and visible spends, filterable by contact, address type and event. The dashboard loads the latest 5,000 events, with an explicit limit notice. |
| Scan manager | Pause/resume/retry, saved progress, observed speed, estimated remaining time, and stalled state. Paused scanning must resume before a new send. |
| Contact portfolios | Maps watch addresses to saved contact receiving addresses; unmatched accounts with the same label are grouped. Combines received totals and reports combined unspent only when all entries have spend visibility. |
| Watch alerts | Optional generic notifications for discovered watched payments and stalled scans. Works while unlocked. Historical catch-up may discover old payments. |
| Node health | Explicit reachability, RPC latency, chain height, reported network and available block/index capabilities. Unknown probes stay unknown. |
| Encrypted contact backup | Password-encrypted contact/watch configuration export, preview and atomic merge on the same network. Conflicts stop the import before writes. No seed or authenticator secret is exported. |
| Read-only helper | Local rules explain scans, balances, nodes, backups and authenticator setup. No external AI service and no command execution from its answers. |
| Authenticator app | Six-digit SHA-1 TOTP, 30-second steps, enrollment confirmation, one-use recovery codes, replay rejection, and a cooldown after five invalid attempts. |

## Open the new features

The wallet home page has a **Dashboard · scans, portfolios & security** button. Security contains authenticator enrollment. Save the recovery codes offline when enrollment succeeds; they are shown once. Each protected approval needs a fresh code, so an immediately following action may require waiting for the next 30-second code.

Authenticator codes guard unlock, send/retry, lustration retry approval, key/seed reveal, backup operations, disabling the guard, reset and wallet replacement. It is a local approval guard, not a second encryption factor: a seed holder or attacker controlling the browser profile can bypass it.

## Reliability, privacy and security fixes

- Watch-only progress is saved batch by batch and restored from wallet state after worker/session restarts. Drafts survive navigation in the open panel.
- Background downloads yield to user actions. Duplicate sync/home refresh calls are coalesced. Concurrent sends cannot start two active payments.
- Wallet locking clears revealed UI data, hides private responses that raced a lock, and no longer depends on screen polling to reset the timer. Real user input refreshes auto-lock.
- Payment storage refuses plaintext fallback when the vault locks before encryption.
- Background commands validate extension sender paths. Offscreen proof/broadcast events are accepted only from the expected page. Inherited command names are rejected.
- Individual hidden-watch preferences are encrypted. Legacy localStorage hidden preferences are cleared to remove stored viewing-key fragments; watched addresses and balances remain intact.
- Amounts are omitted from system notifications by default. Details can be enabled explicitly in Settings. Watch alerts always omit amounts/contact names.
- Tor's proxy permission is required at installation, per Chrome's API requirements. Remote egress requires the expected extension-controlled PAC and a successful recent Tor check. Proxy takeover, changed configuration or expired checks block remote traffic. Redirects are rejected, including price and Tor-check requests; local loopback nodes remain direct.
- Untrusted response sizes are bounded before JSON/WASM parsing, and price requests have timeouts.
- Unsafe URL schemes/credentials and unsupported settings are rejected. The extension CSP restricts connection, image, form, worker, object and base destinations.
- Reset/replacement refuses active payments. Already approved proof/broadcast work may finish after UI lock.
- Dashboard filters survive polling, payloads avoid duplicating all coins, the header wraps on narrow displays, and the dashboard respects light/dark preference.
- Watch rescan/rollback preserves registrations with appropriate cursor/coin reset; these Rust changes still require compilation and chain integration tests.

## Validation

Two source/security review passes plus a broader privacy/routing review were performed. **48 Node tests pass**, and syntax checks pass for **16 extension JavaScript files**. Tests cover real helper code and command routing with mocked Chrome/IndexedDB/WASM interfaces. They are not full browser, blockchain or consensus tests.

The build was attempted and stopped because wasm-pack is unavailable. Rust/compiler dependencies and compiled WASM modules are absent. Browser process startup was blocked, and the browser's URL policy rejected the local visual preview. No visual-browser pass, live-node send, live Tor traffic/DNS capture or Rust test pass is claimed.

See `SECURITY-REVIEW-0.21.0.md` and `docs/SECURITY.md` for remaining trust and leak boundaries.

## Build and checks

On a development machine with Node 20+, Rust/rustup, wasm-pack, Git and platform compiler tools:

```sh
node scripts/check-js.cjs
bash scripts/build.sh
```

The existing build script fetches the pinned Neptune dependencies and builds `extension/pkg/light` and `extension/pkg/prover`. Local verification tests are retained in the working copy; testnet integration is still required before real-fund use. Load/reload `extension/` in the browser and accept the required proxy permission. A running local Tor SOCKS service is still required for Tor; none is bundled.

## GitHub package

This package omits Node tests and inline Rust unit-test modules. The GitHub workflow performs compile checks and builds both WASM modules without running unit tests. The previous 48-test result belongs to the separate local verification copy.
