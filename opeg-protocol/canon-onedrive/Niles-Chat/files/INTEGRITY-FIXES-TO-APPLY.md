# Fraymus Transmuter — integrity fixes to land on the Base44 cloud copy

Six files, 372 insertions / 34 deletions. Two are security-relevant; four are correctness.

Source of truth for behavior: this document. `fraymus-integrity-fixes.patch` is a diff
against the original import (`d7d7bc0`) and is provided so the changes can be replayed —
but if the cloud copy has been touched by the MCP / Integrity page work, reconcile by
**behavior below**, not by line number. The cloud copy is the published tree; do not
overwrite it.

Verified locally: `node probe_transpiler.mjs` 30/30, `node audit_baseline.mjs` 13/13,
`node audit_sweep.mjs` 10/10, `npm run build` passes.

---

## 1. `src/lib/fraymus.js` — `verifyWasm` must recompute, not shape-check  [SECURITY]

**Current defect.** `verifyWasm` sets:

```js
const baselineIsSha256 = /^[0-9a-f]{64}$/.test(ledger.sha256);   // shape only
const baselineNotDjb2  = baselineIsSha256;                        // same boolean, twice
```

It never hashes anything. Demonstrated defect: tamper `fraymus.data` payload bytes
2996..3056 (flip byte 3001 `'W'`→`'X'`), and `verifyWasm()` still returns `valid: true`.
Real digest `419817758247f7c5e18156534c17c3ba…` vs stored `4b2dc889129e12b3adbfca2596f8b005…`
— the mismatch was never computed.

**Required behavior.** `verifyWasm` must be `async` and:

1. Recover the payload bytes actually embedded in the module (base64-decode
   `fraymus.data`; never compare the base64 string itself).
2. Recompute SHA-256 over those recovered bytes via `crypto.subtle.digest`.
3. Return `valid: true` **only** if the recomputed digest equals the stored
   `fraymus.baseline`, and additionally cross-check `ledger.sha256` when present.
4. Expose the individual checks as named booleans (`baselineMatchesActual`,
   `ledgerMatchesBaseline`, …) rather than one reused variable.

Also export `dnaHypervector` and `genesisBlock0` — both were module-private and are
needed by the audit harness.

**Confirmed:** `fraymus.baseline` is real SHA-256, never DJB2. Six inputs verified
including adversarial empty, 1-byte, all-`0xFF`, and a payload containing an embedded
`\0asm` magic. Empty input → `e3b0c44298fc1c149a…`; single byte → `df7e70e5021544f483…`.

**Known caller:** `src/components/WasmVerifier.jsx` is the single call site and must
`await verifyWasm(buf)`. Surfacing the new named checks in its UI is the point of the fix.

---

## 2. `src/lib/forge.js` — classic pipeline emitted the wrong format  [CORRECTNESS]

Three defects, all in `buildClassicWasm`:

**(a) 2 sections emitted, not 5.** Each classic WASM must carry the same five sections
as `transmute()`: data, baseline, ledger, catalog, meta. `fraymus.baseline` was absent
entirely, so nothing could be verified downstream.

**(b) `fraymus.data` written as raw bytes; `decodeWasm` expects base64.** This is the
sharpest of the three. `transmute()` writes base64; `buildClassicWasm` wrote raw bytes.
`decodeWasm` calls `atob()`, so every classic WASM threw `InvalidCharacterError`. Two
pipelines claiming byte-compatibility disagreed. Both must write base64.

**(c) The 16-hex `hash` fields are catalog ids, not digests.** They were being carried
into `ledger.sha256`, where a verifier would compare them against a real SHA-256 and
fail. Carry them as `catalog_id` instead, and never as a digest.

`buildClassicWasm` and `sha256hexAsync` become `async`. Update the caller
`src/pages/Forge.jsx` (`regenerateOne`).

---

## 3–4. `src/lib/go2java.js` and `src/lib/janus.js` — transpiler gaps  [CORRECTNESS]

Real bugs found while closing the gap list:

- **`mapType()` leaked `$1` into output.** It ran `re.test(x)` then returned the raw
  replacement template, so `func f(x []int)` produced `String f($1[] x)`. Every type
  substitution must call `x.replace(re, …)`, never return the template.
- **`TYPE_MAP` rule ordering.** Container rules sat after scalar rules, so
  `map[string]int` matched `\bstring\b` first and was mangled. Sort by specificity:
  containers before scalars, `foo[]bar` before `bar`.
- **`namespace` pre-pass ran per-line.** Hoist it to a single pre-pass over the whole
  source, or nested namespaces double-prefix.
- **Range loops lost key/value distinction.** Emit an explicit `@range_kv` marker so
  `for k, v := range m` is not flattened to `for k in m`.
- Go: interfaces, goroutines, channels, `select`, `defer` (as comments), `const (…iota…)`,
  struct literals `{}`, `string[]` → `String[]` casing.
- C++: templates, multiple inheritance, destructors/RAII, access sections, `auto`,
  `const`, `std::` qualification.

Coverage: 30/30 on synthetic constructs, gaps: none.

**Caveat, stated plainly.** Against real files this is far weaker:

```
GO  -> JAVA : 0/6   every file leaked `package`, `func`, `fmt.`
C++ -> JAVA : 3/6   leaks `#include`
JAVA -> C++ : 2/6   leaks `new`, `ArrayList`
REAL-FILE TOTAL: 5/18
```

The synthetic 30/30 tests the constructs I thought of; real files test the ones I didn't.
Treat these as best-effort rewrites that need manual review, not as a correct transpiler.
A `package` clause and `#include` line should at minimum be stripped or commented.

---

## 5–6. `src/components/WasmVerifier.jsx`, `src/pages/Forge.jsx`

Call-site updates only: `await` on the now-async functions, and surface the new named
checks. No independent logic.

---

## Applying this

```bash
cd <cloud-checkout>
git apply --check fraymus-integrity-fixes.patch   # expect clean, or conflict markers
git apply fraymus-integrity-fixes.patch
npx vite build                                    # must pass
node audit_baseline.mjs && node audit_sweep.mjs && node probe_transpiler.mjs
```

Then publish **once**, so the MCP server and the integrity fixes ship together.

## What NOT to change

- `base44/` MCP config, the consent route wiring, `/integrity`, the nav link, the Home card.
  All of that is cloud-only work and my local tree does not have it. The patch touches
  `src/lib/` and `src/pages/`, nothing under `base44/`.
- `package-lock.json` — incidental npm churn, reverted locally, deliberately not included.
