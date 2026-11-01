#!/usr/bin/env python3
"""
wat_probe.py - compile, instantiate and exercise any WebAssembly module.

Usage:
    python wat_probe.py <file.wat|file.wasm|file.py>
    python wat_probe.py module.wat --call add 1 2

Accepts:
  .wat / .wasm  - compiled and probed directly
  .py           - scanned for WAT text (triple-quoted string or a WAT constant),
                  since hand-written "WASM generators" often embed the source

For every export it reports the kind, signature, and a value from a trial call.
Integer params are passed 0 by default; this is a smoke test, not a proof of
correctness - it answers "does this module load and do its exports respond".
"""
import sys
import os
import re
import json
import argparse


def load_candidates(path):
    """Yield (label, wat_text) candidates found in the file."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    if path.lower().endswith((".wat", ".wasm", ".wast")):
        yield ("file contents", text)
        return

    # A .py or .js might hold the WAT in a string literal.
    for m in re.finditer(r'"""(.*?)"""', text, re.S):
        body = m.group(1)
        if "(module" in body or "(func" in body:
            yield ("triple-quoted block at char %d" % m.start(), body)

    for m in re.finditer(r"'''[^\n]{0,4}(.*?)'''", text, re.S):
        body = m.group(1)
        if "(module" in body or "(func" in body:
            yield ("triple-single-quoted block at char %d" % m.start(), body)

    # Raw byte literals: b'\x00asm...' or b"\0asm..."
    for pat, label in ((r"b['\"]\\\\x00asm", "bytes literal \\x00asm"),
                       (r"b['\"]\\\\0asm", "bytes literal \\0asm"),
                       (r"\\x00asm\\x01\\x00\\x00\\x00", "raw header bytes"),
                       (r"\\0asm\\1\\0\\0\\0", "raw header bytes")):
        if re.search(pat, text):
            yield (label, None)

    # Struct.pack / to_bytes emission is a hint that a binary is being built.
    for pat, label in ((r"struct\.pack", "struct.pack present"),
                       (r"\.to_bytes\(", "int.to_bytes present"),
                       (r"bytearray\(", "bytearray present")):
        if re.search(pat, text):
            print(f"  [note] {label} -> this file may hand-emit a binary")


def probe(path, calls):
    try:
        import wasmtime
    except ImportError:
        print("wasmtime is required:  pip install wasmtime")
        return 1

    print("=" * 74)
    print("  PROBE: %s" % path)
    print("=" * 74)
    if not os.path.exists(path):
        print("  file not found")
        return 1
    print("  size: %d bytes" % os.path.getsize(path))

    raw = open(path, "rb").read()
    print("  magic: %r %s" % (raw[:4], "<- valid \\0asm" if raw[:4] == b"\x00asm" else ""))

    found_any = False
    for label, wat in load_candidates(path):
        found_any = True
        print("\n  -- candidate: %s" % label)
        if wat is None:
            print("     (reference to binary bytes found, but no text module)")
            continue

        n_open, n_close = wat.count("("), wat.count(")")
        print("     paren balance: %d '(' vs %d ')' -> %+d" % (n_open, n_close, n_open - n_close))

        engine = wasmtime.Engine()
        try:
            module = wasmtime.Module(engine, wat)
        except Exception as e:
            print("     COMPILE FAILED:")
            for line in str(e).strip().splitlines()[:8]:
                print("       %s" % line)
            continue

        print("     COMPILES CLEAN")
        store = wasmtime.Store(engine)
        try:
            inst = wasmtime.Instance(store, module, [])
        except Exception as e:
            print("     INSTANTIATE FAILED: %s" % str(e)[:200])
            continue

        exports = inst.exports(store)
        funcs, mems, globs = [], [], []
        for name in sorted(exports):
            e = exports[name]
            if isinstance(e, wasmtime.Memory):
                t = e.type(store)
                lim = t.limits
                mi = getattr(lim, "min", None)
                ma = getattr(lim, "max", None)
                if mi is None:  # older/newer API spellings
                    mi = getattr(lim, "minimum", None)
                if ma is None:
                    ma = getattr(lim, "maximum", None)
                mems.append((name, mi, ma))
            elif isinstance(e, wasmtime.Func):
                funcs.append((name, e))
            else:
                globs.append(name)

        print("     exports: %d funcs, %d memories, %d other" % (len(funcs), len(mems), len(globs)))
        for name, mn, mx in mems:
            mn = mn or 0; mx = mx or 0
            print("       memory %-10s min %d pages (%.0f MiB)  max %d pages (%.0f MiB)"
                  % (name, mn, mn * 65536 / 1048576, mx, mx * 65536 / 1048576))
        if globs:
            print("       other: %s" % ", ".join(globs))

        print("\n     calling every export with integer zeros%s:" %
              (" (plus requested calls)" if calls else ""))
        for name, fn in funcs:
            try:
                nparams = len(fn.type(store).params)
            except Exception:
                nparams = 0
            try:
                res = fn(store, *([0] * nparams))
                print("       %-26s (%d params) -> %s" % (name, nparams, res))
            except Exception as e:
                msg = str(e).strip().splitlines()[0][:90] if str(e).strip() else type(e).__name__
                print("       %-26s (%d params) -> *** %s" % (name, nparams, msg))

        for name, args in calls:
            if name not in exports:
                print("       requested %s: not an export" % name)
                continue
            try:
                res = exports[name](store, *[int(a) for a in args])
                print("       %-26s %s -> %s" % (name, args, res))
            except Exception as e:
                print("       %-26s %s -> *** %s" % (name, args, str(e)[:90]))

        return 0

    if not found_any:
        print("\n  NO WASM/WAT CONTENT FOUND in this file.")
        print("  If it claims to emit a binary, look for the emission step -")
        print("  a module that produces bytes must contain either WAT text or")
        print("  explicit byte construction (\x00asm is 0x00 0x61 0x73 0x6d).")
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--call", nargs="+", action="append", default=[],
                    help="name arg1 arg2 ...  e.g. --call add 3 4")
    a = ap.parse_args()
    calls = []
    for c in a.call:
        calls.append((c[0], c[1:]))
    return probe(a.path, calls)


if __name__ == "__main__":
    sys.exit(main())
