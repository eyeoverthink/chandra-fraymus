# Build gates — full receipts (fraymus-re, 2026-11-05)

Every failure + fix, in order, from real logs on this machine.

1. **r2 sys/install.sh → sudo hang.** `sudo: a terminal is required to read the password` at the install step (compile itself OK, binary produced at `binr/radare2/radare2`). FIX: `./configure --prefix=$HOME/fraymus-re/tools/r2 && make install` — user-owned prefix, zero elevation.
2. **r2 dylib path decay.** Installed binaries keep install-names from the FIRST configure (`/usr/local/lib/libr_cons.dylib`). FIX: `export DYLD_FALLBACK_LIBRARY_PATH=$HOME/fraymus-re/tools/r2/lib` (saved to tools/r2/r2env.sh). `r2 -v` → `radare2 6.2.5 +0 abi:174 @ darwin-arm_64`. A clean `make clean` rebuild would bake correct @rpath if relocatable install is ever needed.
3. **Ghidra JDK 21 daemon crash.** `Unrecognized VM option 'UseCompactObjectHeaders'` → "Could not create the Java Virtual Machine… Could not parse daemon handshake response." The flag = JDK-25-era; ghidra-master README line 30 = "Install JDK 25 64-bit". FIX: `brew install openjdk@25`, `JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home`.
4. **Ghidra build #3 → missing flat repo (16s).** `Unable to find the local maven repo. Ensure you have created the flatRepo directory or ghidra.repos.config file.` (build.gradle:106). FIX: official bootstrap `./gradlew -I gradle/support/fetchDependencies.gradle init` before `buildGhidra`.
5. **rea engine gate.** `.npmrc engine-strict` → `EBADENGINE` (requires node `^22.23.4 || ^24.22.1 || >=26.12.1`; machine = 26.8.1). FIX: `--engine-strict=false` for install… but see #6.
6. **rea genuine runtime incompat.** `metadata:check` → `ERR_INVALID_ARG_VALUE` at `Module.stripTypeScriptTypes` (Node internal) — the engine pin is load-bearing, not bureaucracy. FIX: `brew install node@24` side-by-side, PATH-prefix `/opt/homebrew/opt/node@24/bin` for rea builds only.
7. **npm 11 install-scripts block.** `3 packages have install scripts not yet covered by allowScripts: esbuild (postinstall), fsevents (install)`. FIX: `npm install-scripts approve esbuild fsevents` then reinstall/build.
8. **rea prepare.mjs needs .git.** zip-sourced tree = no git metadata → `.git can't be found`. FIX: `git init` + snapshot commit in rea-main.
9. **rea entrypoint law.** `bin: {"rea": "scripts/rea.mjs"}` — run `node scripts/rea.mjs --version`; its runtime self-diagnoses: "compiled runtime is missing → npm ci && npm run build:cached".
10. **Ghidra JDK prompt with no TTY.** `ERROR: Unable to prompt user for JDK path, no TTY detected.` FIX: `java -cp support/LaunchSupport.jar LaunchSupport $GH -jdk_home -save` with `JAVA_HOME` set = saves the choice silently.
11. **Bad argument: /bin/ls.** analyzeHeadless = `InvalidInputException` when the file path is passed bare. FIX: `-import /bin/ls` (flag = mandatory).
12. **Directory not found (ghidra-projects).** HeadlessAnalyzer does not mkdir the project location. FIX: `mkdir -p ~/fraymus-re/ghidra-projects` first.
13. **Ghidra 12 headless python = gone.** `GhidraScriptLoadException: Ghidra was not started with PyGhidra` — Jython postscripts = dropped. FIX: same exporter as a **Java GhidraScript** (`scripts/decompile_all.java`, runtime-compiled by Ghidra) + `-process ls -noanalysis -scriptPath ~/fraymus-re/scripts -postScript decompile_all.java`. Result: 136 functions → 5,152 lines of C.
14. **Node runtime heals itself via brew.** `brew upgrade node` → v26.13.0 (≥ their pin), simdjson decay gone; rea boots on default PATH.
15. **ReVa gradle root confusion.** ReVa subdir has no build; the build lives at the repo ROOT (`reverse-engineering-assistant-main/build.gradle`). Also their law: Gradle 9.1+ via `gradle` directly, NOT `./gradlew`. FIX: `brew install gradle`, run from repo root with `GHIDRA_INSTALL_DIR` + `JAVA_HOME` set. BUILD SUCCESSFUL 5m14s.
16. **setuptools-scm needs git metadata (again).** ReVa `pip install -e` fails: `LookupError: setuptools-scm was unable to detect version` — second zip-tree-sans-git gate today. FIX: `git init` + snapshot commit, then `pip install -e .` → `mcp-reva --help` = MCP_BOOT=0.
17. **FRA score v1 verified nothing — my regex's fault.** Import-table parse returned an empty set (rabin2 -i emits `|`-column rows), so verification = 0/82 forever. FIX: proper column parse + per-model token budgets (qwen3.5 needs 1600+ for think-block… and STILL returns empty `response` on this build — dossier labels it honestly rather than faking agreement). Verified result: 3/78 (printf, putchar, strlen).
18. **r2ai build gates.** (a) Makefile dir-discovery runs `r2`/`r2pm` bare → empty vars → `mkdir -p` usage error → pass `R2USRPLUGDIR/R2BINDIR/R2MANDIR/R2AI_PROMPTSDIR` explicitly. (b) `r2check` = .PHONY + runs r2 bare = aborts under make even with DYLD exported → bypass with `make -o r2check`. (c) brew's stale radare2 6.2.4 headers hijacked include resolution → `PKG_CONFIG_PATH=tools/r2/lib/pkgconfig` + clean .o. (d) darwin os-detect aborted → `DOTLIB` empty → dylib named `r2ai.` → renamed `r2ai.dylib`. (e) `-q` = takes a prompt FILE name; real queries = positional. LIVE: `DYLD_FALLBACK_LIBRARY_PATH=tools/r2/lib r2ai -p ollama -m llama3:latest "reply with READY only"` → `READY` from localhost:11434.

## Dossier seals (hash chain over sorted manifest)
- v1 (empty-import parse): `11ca688619c3bace9727d1cce572e808af2ace7cb069b20ae87a8e45e0e762d4`
- v2 (real verification): **`35e83ee65044ebbfe941f3c7b590139c1afbe08e2ad114da6ecdeb8fa0721e27`** — current

## Verified results while building
- `rabin2 -I /bin/ls`: mach0, arm 64-bit, clang, canary=true, binsz 89088.
- `r2 -qq -A /bin/ls`: 135 functions, 92 imports, 450 strings.
- LLM annotation (r2 lane): entry0 disasm → llama3 → summary citing `0x100000960`.
- LLM annotation (Ghidra lane): `FUN_10000073f` decompiled C → llama3 → identified `strcoll`-based filename comparison (the ls sort comparator) + implied import `_strcoll`.
- Engine parity: r2 = 135 fns vs Ghidra = 136 fns on the same binary (normal analyzer divergence, recorded honestly).
- Model quirks: `phonon:latest` → `"does not support generate"` (embedding-only); `qwen3.5:4b` burns budget in think-block (empty `response`, populated elsewhere / bigger num_predict needed).
