"""seat_honcho_verify — prove the seat's grant actually reads/writes the shared cloud memory."""
import json
import os

cfg_path = os.path.expandvars(r"%USERPROFILE%\AppData\Local\hermes\honcho.json")
cfg = json.load(open(cfg_path))
h = cfg["hosts"]["hermes"]
print("seat grant: peer=%s ws=%s enabled=%s" % (h.get("peerName"), h.get("workspace"), h.get("enabled")))

from honcho import Honcho

c = Honcho(api_key=h["apiKey"], base_url="https://api.honcho.dev", workspace_id=h.get("workspace", "mac-hermes"))
p = c.peer(h.get("peerName", "IMack"))
try:
    card = p.get_profile()
    print("peer profile reachable:", bool(card))
except Exception as e:
    print("peer profile method differs on this SDK:", type(e).__name__, "- continuing")

s = c.session("seat-rto00k0-verify", peers=[h.get("peerName", "IMack")])
probe = "seat rto00k0 memory round-trip probe 1027"
s.add_messages([{"peer_id": h.get("peerName", "IMack"), "content": probe}])
print("wrote probe message to shared workspace")

hits = [getattr(m, "content", "") for m in c.search("seat rto00k0 memory round-trip probe", limit=8)]
print("search hits:", sum(1 for x in hits if "rto00k0" in str(x)))
ok = any("rto00k0" in str(x) for x in hits)
print("ROUND-TRIP:", "PASS" if ok else "FAIL")