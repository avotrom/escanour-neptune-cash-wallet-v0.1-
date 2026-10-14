> 0.21.0 GitHub source package: dashboard features and authenticator codes are included. `.github/workflows/build.yml` runs compile checks and builds without unit tests. This is uncompiled source; see `CHANGES-0.21.0.md` and `SECURITY-REVIEW-0.21.0.md`.

# Escanour Neptune Wallet

A private light wallet for [Neptune Cash](https://neptune.cash) as a Chrome extension, with no node to run and no change to Neptune.

- **Private sync.** The wallet downloads blocks by height from any public neptune-core node, scans them locally, and keeps its own membership proofs. The server learns only which heights you asked for. It never sees an address, a key, or which coins are yours.
- **Fast start.** A new wallet starts at the current tip: no history to download.
- **Proving on your device, in parallel.** A transaction's ProofCollection is split into independent jobs that run in separate Web Workers, each with its own wasm memory.
- **Uses Neptune as it is.** Only existing JSON-RPC endpoints (`chain_height`, `wallet_getBlocks`, `wallet_submitTransaction`). The only patch is a small wasm-compatibility diff applied to a vendored copy of neptune-core inside this repo.

> **Status: alpha, not yet compiled.** The code was written against neptune-core's source (commit `cc3fca9`, crates 0.19) but has not been built or run yet. Start with [docs/STATUS.md](docs/STATUS.md), which lists what to verify first. Use testnet before mainnet.

## How it works

```
                 heights only                          ProofCollection
 Public node  <---------------->  Service worker  ---------------------->  Public node
 (neptune-core)  wallet_getBlocks  (light wasm)      wallet_submitTransaction  (another one)
                                       |
                        jobs (encrypted, IndexedDB)
                                       v
                              Offscreen document
                         +-----------+-----------+
                         | Worker 1  | Worker 2  | ...  each: own prover wasm, own memory
                         +-----------+-----------+
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
scripts/vendor-neptune.sh   # pinned neptune-core + wasm patch -> vendor/
scripts/check-wasm.sh       # step 0: does it compile for the browser?
scripts/build.sh            # wasm modules -> extension/pkg/
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` folder.

Test the same logic without a browser:

```bash
cargo run --release -p light-cli -- new-phrase
export NEPTUNE_PHRASE="..."            # 18 words
cargo run --release -p light-cli -- --network testnet init
cargo run --release -p light-cli -- --network testnet sync
cargo run --release -p light-cli -- --network testnet send <address> 1.5 0.05 --workers 4
```

The CLI prints per-proof timings, which tell you how many browser workers a machine can handle.

Full instructions: [docs/BUILD.md](docs/BUILD.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `crates/light-core` | All wallet logic: keys, sync, membership proofs, coin selection, proof jobs |
| `crates/light-wasm` | Browser bindings for light-core (no prover inside, so it loads fast) |
| `crates/prover-wasm` | One proof job per call; loaded only in proving workers |
| `crates/light-cli` | Native test harness and benchmark for light-core |
| `extension/` | Chrome MV3 extension: service worker, offscreen prover, popup |
| `patches/neptune-wasm.patch` | The wasm32 compatibility diff for neptune-core |
| `docs/` | Architecture, build, security, RPC, status |

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): design and the reasoning behind each choice
- [BUILD.md](docs/BUILD.md): toolchain, build, load, troubleshoot
- [SECURITY.md](docs/SECURITY.md): threat model and what each party learns
- [RPC.md](docs/RPC.md): the node endpoints used, exactly
- [STATUS.md](docs/STATUS.md): what is done, what is unverified, what is missing

## License

Proprietary, all rights reserved: nobody may use, copy, modify or distribute this code without written permission. See [LICENSE](LICENSE).

The sync algorithm in `light-core/src/sync.rs` and the claim construction in `light-core/src/jobs.rs` are adapted from [neptune-core](https://github.com/Neptune-Crypto/neptune-core), which stays under Apache-2.0. See [NOTICE](NOTICE).

## Build on GitHub (nothing to install)

1. Upload this folder to a new private GitHub repository.
2. Open **Actions → set up a workflow yourself**, paste the contents of `github-workflow.yml`, and commit.
3. When the run finishes, download **neptune-light-extension** from the run page and load it unpacked in Chrome.
