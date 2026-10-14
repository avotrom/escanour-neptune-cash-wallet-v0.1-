#!/usr/bin/env python3
"""Complete the pinned Neptune WASM patch without disabling crate warnings.

The main patch disables the native clock and subprocess implementation on
wasm32. Their imports must have the same target condition. The no-op scope
logger retains its metadata for Debug/Clone and its existing public API; only
those three fields receive a wasm32-specific dead-code annotation.
"""

from pathlib import Path
import sys


NATIVE_ONLY = '#[cfg(not(target_arch = "wasm32"))]\n'
WASM_METADATA = '    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]\n'


def annotate_once(text, declaration, annotation):
    if text.count(declaration) != 1:
        raise ValueError(f"Expected one pinned declaration: {declaration.strip()}")
    if annotation + declaration in text:
        return text
    return text.replace(declaration, annotation + declaration, 1)


def cleanup(root):
    consensus = root / "neptune-consensus/src"
    lib = consensus / "lib.rs"
    prover = consensus / "proof_abstractions/tasm/prover_job.rs"
    lib_text = lib.read_text()
    prover_text = prover.read_text()
    # Refuse to conceal a missing compatibility patch: on wasm32 that clock
    # would panic, independently of the unused-import warning.
    if NATIVE_ONLY + "    start: Instant," not in lib_text:
        raise ValueError("Apply neptune-wasm.patch before the warning cleanup")
    if NATIVE_ONLY + "    pub async fn prove_out_of_process(" not in prover_text:
        raise ValueError("The pinned native prover compatibility patch is missing")
    lib_text = annotate_once(lib_text, "use std::time::Instant;\n", NATIVE_ONLY)
    for field in [
        "    description: &'a str,\n",
        "    log_slow_fn_threshold: Option<f64>,\n",
        "    location: &'static std::panic::Location<'static>,\n",
    ]:
        lib_text = annotate_once(lib_text, field, WASM_METADATA)
    for declaration in [
        "use std::path::Path;\n",
        "use std::process::Stdio;\n",
        "use itertools::Itertools;\n",
        "use tokio::io::AsyncWriteExt;\n",
        "use crate::proof_abstractions::tasm::neptune_prover_job::NeptuneProverJob;\n",
    ]:
        prover_text = annotate_once(prover_text, declaration, NATIVE_ONLY)
    # Validate both files completely before writing either one.
    lib.write_text(lib_text)
    prover.write_text(prover_text)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: cleanup-wasm-warnings.py vendor/neptune-core")
    try:
        cleanup(Path(sys.argv[1]))
    except (OSError, ValueError) as error:
        raise SystemExit(f"WASM warning cleanup failed: {error}") from error
    print("WASM-only warning cleanup applied (native declarations retained)")
