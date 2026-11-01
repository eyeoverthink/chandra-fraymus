"""seat_honcho_auth — mint a seat-owned Honcho grant WITHOUT the interactive wizard.

Imports the installed hermes honcho plugin under an alias package, drives the RFC 8628
device flow, then writes the SAME workspace/peers as the prime seat so both seats share
one cloud memory with independent token rotation. Run on the seat:
  (hermes venv python) <this file>
The approving browser can be ANY machine — the code prints here and waits up to ~10 min.
"""
import importlib
import os
import pathlib
import sys
import types

AGENT = r"C:\Users\eyeka\AppData\Local\hermes\hermes-agent"
sys.path.insert(0, AGENT)
os.chdir(AGENT)  # the plugin's utils import resolves against the agent dir

PLUG = pathlib.Path(r"C:\Users\eyeka\AppData\Local\hermes\plugins\honcho")
ALIAS = "honcho_plug"

pkg = types.ModuleType(ALIAS)
pkg.__path__ = [str(PLUG)]
pkg.__package__ = ALIAS
sys.modules[ALIAS] = pkg
of = importlib.import_module(ALIAS + ".oauth_flow")
cli = importlib.import_module(ALIAS + ".cli")

IDENTITY = {  # prime-seat values (iMac) — both seats share these in the cloud
    "peerName": "IMack",
    "aiPeer": "ai",
    "workspace": "mac-hermes",
    "recallMode": "hybrid",
    "observationMode": "directional",
    "writeFrequency": "async",
    "sessionStrategy": "per-session",
    "dialecticReasoningLevel": "medium",
}

write_path = cli._local_config_path()
print("auth: requesting device code (approve at the printed URL)...", flush=True)

def _show(d):
    print("\n  DEVICE CODE — approve from ANY browser:\n", flush=True)
    print("  1. Open   %s" % d.verification_uri, flush=True)
    print("  2. Enter  %s" % d.user_code, flush=True)
    print("  Or open directly: %s" % d.verification_uri_complete, flush=True)
    print("  (waiting for approval...)", flush=True)

cred = of.authorize_via_device_code(
    config_path=write_path,
    source="hermes-cli",
    apply_config=False,
    display=_show,
    open_url=None,
    on_poll=lambda: print(".", end="", flush=True),
)
print("\n  AUTHORIZED.", flush=True)

cfg = cli._read_config()
hh = cfg.setdefault("hosts", {}).setdefault(cli._host_key(), {})
cli._apply_grant_to_host(cfg, hh, cred)
for k, v in IDENTITY.items():
    hh[k] = v
hh["enabled"] = True
hh.setdefault("saveMessages", True)
cfg.setdefault("peerName", IDENTITY["peerName"])
cli._write_config(cfg)
print("  wrote:", write_path, flush=True)

try:
    from hermes_cli.config import load_config, save_config
    hc = load_config()
    hc.setdefault("memory", {})["provider"] = "honcho"
    save_config(hc)
    print("  config.yaml: memory.provider=honcho", flush=True)
except Exception as e:
    print("  set it manually: hermes config set memory.provider honcho (%r)" % e, flush=True)

print("\nDONE. Verify: hermes honcho status", flush=True)