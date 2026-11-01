"""a2a.py — agent-to-agent channel over the shared Honcho cloud workspace.

Channel: session 'a2a-cadence-niles', peers cadence-mac-hermes (iMac seat) and
niles-actid8c (RTX3070 Windows seat). Both seats hold their OWN grants; the
session lives in workspace 'mac-hermes' so either side can read the full thread.

usage:
  python a2a.py post "text here"     # post as THIS seat's peer
  python a2a.py read [N]             # print the last N messages (default 20)
  python a2a.py check                # print UNREAD messages only (cursor-tracked);
                                     # 'NO-NEW' when nothing pending. Cron-safe.
"""
import json
import os
import socket
import sys

SESSION_ID = "a2a-cadence-niles"
PEER_MAC = "cadence-mac-hermes"
PEER_BOX = "niles-actid8c"

KEY_PATHS = (
    os.path.expandvars(r"%USERPROFILE%\AppData\Local\hermes\honcho.json"),
    os.path.expanduser("~/.hermes/honcho.json"),
)

ME = PEER_BOX if "ACTID8C" in socket.gethostname().upper() else PEER_MAC
OTHER = PEER_BOX if ME == PEER_MAC else PEER_MAC

def _client():
    for p in KEY_PATHS:
        if os.path.exists(p):
            cfg = json.load(open(p))
            import honcho  # noqa: E402  (SDK resolves after the key file confirms)
            h = cfg["hosts"]["hermes"]
            return honcho.Honcho(api_key=h["apiKey"], base_url="https://api.honcho.dev", workspace_id=h["workspace"])
    raise SystemExit("no honcho.json found for either seat layout")

def _msg_row(m):
    content = str(getattr(m, "content", ""))
    pid = getattr(m, "peer_id", "?")
    ts = str(getattr(m, "created_at", ""))
    mid = str(getattr(m, "id", ts))
    return mid, pid, ts, content

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "read"
    c = _client()
    s = c.session(SESSION_ID, peers=[ME, OTHER])  # get-or-create

    if cmd == "post":
        text = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
        if not text.strip():
            raise SystemExit("nothing to post")
        s.add_messages([{"peer_id": ME, "content": text[:1800]}])
        print("posted as", ME)

    elif cmd == "read":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        page = s.messages(reverse=True, size=max(1, min(n, 200)))
        rows = list(page)
        if hasattr(page, "items"):
            rows = list(page.items)
        for m in reversed(rows):
            mid, pid, ts, content = _msg_row(m)
            tag = "ME" if pid == ME else ("[%s]" % pid)
            print("%s | %s | %s | %s" % (ts, tag, mid[:12], content[:600]))

    elif cmd == "check":
        cursor_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "a2a_cursor.json")
        cur = {}
        if os.path.exists(cursor_path):
            cur = json.load(open(cursor_path))
        seen = cur.get("last_id", "")
        page = s.messages(reverse=True, size=50)
        rows = list(page)
        if hasattr(page, "items"):
            rows = list(page.items)
        unread = []
        for m in rows:
            mid, pid, _, content = _msg_row(m)
            if pid != ME and mid != seen:
                unread.append((mid, content))
        if not unread:
            print("NO-NEW")
            return
        for mid, content in sorted(unread, key=lambda x: x[0]):
            print("[FROM %s | id=%s]\n%s\n" % (OTHER, mid[:12], content[:2000]))
        newest = sorted(unread, key=lambda x: x[0])[-1][0]
        json.dump({"last_id": newest}, open(cursor_path, "w"))

    else:
        raise SystemExit(__doc__)

if __name__ == "__main__":
    main()