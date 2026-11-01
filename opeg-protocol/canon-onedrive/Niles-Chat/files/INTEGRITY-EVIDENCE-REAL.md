# Integrity fixes — corrected evidence, with real measurements

Replaces the `SOVEREIGN_EYE.WASM` section of `Integrity-Fixes-Corrected-Mcp-Real-Api-Mcp-Evidence.html`.
Every number below came from running the cloud-copy source (`eyeoverthink/Fraynix-Studios`).
Nothing here is asserted. Reproduce with `real_evidence.mjs` and `coverage.mjs`.

---

## 0. Correction to an earlier claim of mine

I previously reported "§6.4 hole CLOSED — 14/15, tampering rejected." **That was too strong.**

I tampered at byte 3027, which happens to sit inside `fraymus.data` — the only section the
verifier actually covers. The hole is closed *for that one section* and open everywhere else.
Below is the honest version.

---

## 1. What `verifyWasm` actually protects: 22% of the file

`sha256hex(original)` is computed over the decoded **`fraymus.data` payload only**. Nothing else
is hashed. Section map of a real transmuted module (3,838 bytes):

```
(id 1)   type            bytes   10..16     6 B   NOT covered
(id 3)   func            bytes   18..20     2 B   NOT covered
(id 7)   export          bytes   22..33    11 B   NOT covered
(id 10)  code            bytes   35..41     6 B   NOT covered
fraymus.baseline         bytes   43..124    81 B   read as the expected digest
fraymus.dna              bytes  127..2187  2060 B  NOT covered   <-- largest section
fraymus.genesis          bytes 2190..2565   375 B  NOT covered
fraymus.ledger           bytes 2568..2982   414 B  NOT covered
fraymus.data             bytes 2985..3838   853 B  COVERED
```

Measured tamper results (one byte XOR 0xFF, then re-verify):

```
inside fraymus.data payload   off=3028  -> valid=false   DETECTED
byte 1919 (fraymus.dna)       off=1919  -> valid=true    NOT DETECTED
inside code section           off=  35  -> valid=true    NOT DETECTED
type section                  off=   8  -> valid=true    NOT DETECTED
```

**853 of 3,838 bytes (22%) are integrity-checked. 78% of the module can be modified and still
verify as valid** — including `fraymus.dna`, the 2 KB identity hypervector, and the entire code
section that actually executes.

This is not a nitpick: a verifier whose guarantee covers a fifth of its input is a false sense of
security. `valid: true` reads as "this module is intact."

### The fix

Hash the whole module, not just the recovered payload — one line of intent:

```js
const actualSha256 = await sha256hex(new Uint8Array(buf));   // whole module
const baselineMatchesActual = actualSha256 === baseline;
```

then place the digest in a section that is *excluded* from its own computation (a fixed-offset
trailer, or hash everything then overwrite the known baseline field). Alternatives: hash every
section body except `fraymus.baseline`, or add a second `fraymus.module_sha256` over bytes
`[0, baselineStart)` ∪ `[baselineEnd, EOF)`.

Until then, state the coverage explicitly in the UI: **"payload verified; module body not."**

---

## 2. Classic pipeline — fixed, with real digests

`cloud-copy-forge-fix.patch` corrects `buildClassicWasm`. Before: 5 sections with the wrong names
(`data/baseline/ledger/catalog/meta`), so a freshly built classic WASM failed its own verifier.
After — three real modules, all built and re-verified:

```
classic fraymus_compiler_v1.wasm   bytes=2897  verifies=true  catalog=e0654719998601a3
classic transmuter_engine.wasm     bytes=2894  verifies=true  catalog=34a1b88c1e054b70
classic registrar_bot.wasm         bytes=2878  verifies=true  catalog=93d51c1d2f66f3c7
```

Section set now matches what `verifyWasm` requires
(`baseline, dna, genesis, ledger, data` + additive `catalog, meta`), and `ledger.sha256` receives
the real 64-hex digest instead of being deleted. The 16-hex catalog id is carried as
`catalog_id` / `hash` and never as a digest.

Note these still inherit §1's limitation: only the `data` section is covered.

---

## 3. `sovereign_eye.wasm` — does not exist; the claimed hash is unreproducible

The prior artifact's section claimed `54B SHA-256 7011ceb853b15e61…f70a44b`. Its own generator,
run verbatim:

```
built length   : 61        (claimed 54)
real sha256    : 93770a52de6baf18271c2bbc7399005856bbec11e82d4092c94fe56af35758ee
claimed sha256 : 7011ceb853b15e611caa6743d26da0f287bdc7119e1c66b5c1d978a38f70a44b
MATCH          : False
wasmtime       : FAILED — unexpected end-of-file (at offset 0xa)
```

The hex has section-length prefixes that don't match their bodies, so it cannot parse. The script
then prints the expected hash as its own result:

```python
# expected -> 54 7011ceb853b15e611caa6743d26da0f287bdc7119e1c66b5c1d978a38f70a44b
```

Downstream claims fail with it: leaf count is 8 (asserted 7), so the merkle root is
`0x4b9df4a9a5c56a40`, not `0x45df472b6c3ebc6d`. And check 8 tampers `tampered[184]` guarded by
`if(tampered.length>184)` on a 54-byte file — it never executes, then reports PASS.

`sovereign_eye.wasm` is not on disk (`~/`, `D:\Projects`) and not in the cloud repo.

**If this artifact is real, send it** and hash *it*. A file generated to match a predetermined
digest proves nothing about anything.

---

## 4. φ⁷⁵ — the artifact's labels are swapped

Its line reads `exact=4721424167835364, declared=4721424167835376.0`. Computed:

```
Math.pow(1.618033988749895, 75)  ->  4721424167835376
true φ^75 (Lucas L(75))          ->  4721424167835364.00000000000000021
drift                            ->  12
```

The drift of 12 is real. But "exact" is the value the code *prints*, and "declared" is the true
value — the two labels are reversed relative to what runs. `Math.pow` returns `…376`, which is
`int(φ⁷⁵)` rounded, not φ⁷⁵. State drift as 12 with the correct pairing, or don't state it.

---

## 5. MCP — real endpoints, verified live

The prior artifact's curl block targets three endpoints that do not exist:

```
404  /api/mcp/register    404  /api/mcp/authorize    404  /api/mcp/token
```

The real ones, from the resource metadata:

```
GET  /api/mcp                                   -> 200
POST /api/mcp                                   -> 401
     www-authenticate: Bearer error="invalid_token",
       resource_metadata="https://fraymus-wasm-forge.base44.app/.well-known/oauth-protected-resource/api/mcp"
GET  /.well-known/oauth-protected-resource/api/mcp -> 200
GET  https://app.base44.com/.well-known/oauth-authorization-server -> 200
POST https://app.base44.com/oauth/register      -> 201   (RFC 7591 dynamic client registration)
```

Its stated expectation — `Bearer realm="/api/mcp"` plus a `Link:` header — does not match the
actual 401, which uses `error="invalid_token"` + `resource_metadata=`. That is RFC 9728 form;
the artifact's is not. Working client commands:

```bash
APP=https://fraymus-wasm-forge.base44.app
curl -s -o /dev/null -w '%{http_code}\n' $APP/api/mcp                       # 200
curl -si -X POST $APP/api/mcp -H 'Content-Type: application/json' -d '{}'   # 401 + WWW-Authenticate
curl -s $APP/.well-known/oauth-protected-resource/api/mcp                   # resource + authz server
curl -s https://app.base44.com/.well-known/oauth-authorization-server       # endpoints + PKCE S256
```

---

## 6. Keep from the prior artifact

The narrative sections are sound and should stay: real `/api/mcp` vs the fictional
SSE + `x-mcp-key` guide, `eyeoverthink.com` failing with no DNS (000), `fraynix.com` serving an
unrelated French site, relative paths + GitHub Pages instead of dead hosts, and the
"UNVERIFIED until scripts pass" badge policy.

Delete the `SOVEREIGN_EYE.WASM` section. Replace the MCP curl block per §5.
