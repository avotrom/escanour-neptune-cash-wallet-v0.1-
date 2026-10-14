# Source security and privacy review — 0.21.0

## Result and scope

The identified JavaScript approval, storage, routing and concurrency defects were corrected in source. 48 automated tests pass, and 16 JavaScript files pass syntax checks. This does **not** establish that the wallet is bug-free, leak-free or ready for real funds. Both review passes were performed in this chat; this is not an independent third-party audit.

Reviewed areas: wallet/worker lifecycle, send initiation, watch scans, contacts and portfolio models, dashboard handlers, local authenticator enrollment/approval/recovery, backups, RPC/price/Tor-check egress, notifications, storage, message boundaries, CSP and UI refresh behavior. Existing Rust consensus/sync code was read, but could not be compiled or tested here.

## Findings corrected in source

| Finding | Correction / validation |
| --- | --- |
| Unsupported optional proxy permission | Required manifest permission; test checks the declaration. |
| Direct requests after Tor proxy takeover or configuration failure | Common egress guard checks exact PAC/control/recent verification before remote fetch; tests assert no fetch occurs on failure. |
| Redirects can reach hosts outside the PAC list | All RPC, price and verification fetches reject redirects. |
| Proxy changes during response reading | Active remote requests remain abortable through body consumption and are aborted on proxy changes. |
| Unbounded/unresponsive node or price responses | Response-size bounds and timeouts; large response test. |
| Code gates existed only as UI behavior | Sensitive commands enforce approval at the background message boundary; every protected route is covered by a test. |
| TOTP replay/races and recovery-code reuse | Serialized verification, last-step tracking, encrypted one-use recovery hashes, cooldown; RFC vectors and replay/concurrency/recovery tests. |
| Session key could be saved before second approval | Password is checked first, then authenticator approval, then session storage. Rejected approval leaves the wallet locked. |
| Missing sender/source distinctions | Exact extension/page checks, separate offscreen event handling, own-property command lookup; routing tests. |
| In-flight read could return secrets after lock | Response epoch/session checks, locked-state send redaction, and UI clearing. |
| Plaintext payment fallback on lock | Refuse writing a new unencrypted private payment record; test. |
| Background polling extended auto-lock | Polling reads do not renew it; trusted user input does. |
| Concurrent send requests | Active-payment check and creation occur under the state lock; test permits only one active send. |
| Reset/replacement during approved payment work | Reject while payment work is active; test. |
| Hidden-watch preferences contained key fragments | Encrypted numeric display preferences; legacy plaintext preference fragments are removed. |
| System notifications exposed amounts by default | Generic notifications by default; explicit opt-in for details; test. |
| Partial backup merge on invalid input | Validate contacts/keys first, then encrypted multi-store atomic commit; invalid-watch test asserts no writes. |
| Unsafe URLs/settings | Reject dangerous schemes, embedded credentials, unknown settings/networks, prototype server keys and invalid bounds. |
| Broadcast mistaken for confirmation | Separate status model and test. |
| UI refresh churn / excessive payload | Coalesced home reads, preserved filters, limited dashboard feed and no duplicate coin arrays in portfolio summaries. |

## Data disclosure boundaries that remain

- **Seed/profile compromise:** local TOTP is an approval check whose encrypted secret uses the same vault password key. It cannot defeat a seed holder, offline attacker with that password, profile modification, malware or a compromised extension binary.
- **In-memory secrets:** the raw vault key is present in trusted extension session storage while unlocked, and approved proving workers receive it. JavaScript/WASM memory is not guaranteed to be zeroized. An already approved submission can finish after the UI locks.
- **Node trust:** hash linkage and accumulator consistency do not independently prove canonical chain state or full consensus validity. A dishonest node can withhold or misrepresent data. Node health is an operational check, not a consensus security proof.
- **Tor limits:** mocked routing tests do not establish absence of live DNS/IP leaks. Chrome's proxy is per host across the browser, and Chrome does not provide Tor Browser fingerprinting protections. A proxy/policy change can affect already initiated traffic before the extension learns of it. Loopback node traffic is intentionally direct.
- **Tor off:** remote sync/broadcast services see the connection IP, requested heights/timing and public transaction submission. Optional CoinGecko pricing sees price lookup requests. The Tor Project sees verification requests when enabled. Turn off price lookup to stop those requests.
- **Address reuse:** the extension uses index 0 addresses for each kind; it does not automatically rotate receiving addresses. Fixed identifiers can link announcements. EC Hybrid notification confidentiality has its existing elliptic-curve assumptions.
- **Display hiding:** hidden amounts are a display preference, not protection against scripts, screenshots taken before hiding, memory access or an unlocked user inspecting data. Explicit detailed notifications expose amounts outside the wallet UI.
- **Backups:** exported viewing/spend-view keys remain sensitive despite encryption. Backup security depends on the chosen password and protecting the file. It is not a full seed recovery backup.
- **Plain metadata:** interface settings, node URLs/check results, public chain/index data and progress metadata remain unencrypted. Private contacts, watch configuration, wallet state and history remain encrypted.
- **History limits:** the pre-existing wallet activity history retains 500 entries. The dashboard shows the latest 5,000 watched events with a notice. These limits must not be mistaken for an exhaustive accounting export.

## Required verification still outstanding

1. Compile the revised Rust/light-WASM/prover-WASM code, run native and WASM tests, and review dependency/lockfile provenance.
2. Install/reload in a real supported browser; verify CSP, message sender behavior, authenticator enrollment/lock/recovery and upgrade behavior.
3. Test watch catch-up, pause/resume, reorganization, rescan, backup conflicts and network switching against a real node/testnet.
4. Complete a testnet send/prove/broadcast/confirmation cycle, including lock and cancellation timing.
5. Capture network traffic/DNS while Tor starts, stops, expires and loses proxy control; verify RPC/price/check redirects and no direct fallback.
6. Run visual/accessibility checks at side-panel, desktop and mobile-width layouts, including keyboard focus, dialogs and long names/amounts.
7. Obtain independent review of cryptographic/consensus and send handling before real-fund use.

The build attempt returned `install wasm-pack: cargo install wasm-pack`. Browser startup and local-preview access were blocked by this environment. No workaround was used for the browser security rejection.

TOTP implementation follows RFC 6238: https://www.rfc-editor.org/rfc/rfc6238 . Chrome proxy permission restrictions: https://developer.chrome.com/docs/extensions/reference/api/permissions .
