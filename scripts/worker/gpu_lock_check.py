"""Proves the worker's GpuFileLock and fraymus-video-studio's studio/gpu_lock.py exclude each other.

Run: python -I scripts/worker/gpu_lock_check.py   (test/worker-gpu-lock.test.js runs it). Prints PASS/FAIL lines, ALL PASS last.
The studio side below mirrors studio/gpu_lock.py (branch feat/toolbox-shorts-2026-11-12) line for line, minus env lookup.
"""
import os, sys, tempfile, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chandra_worker import GpuFileLock  # noqa: E402


class StudioLock:  # studio/gpu_lock.py GpuLock, verbatim logic
    def __init__(self, path, stale_s=900, wait_s=600):
        self.path, self.stale_s, self.wait_s, self._fd = path, stale_s, wait_s, None

    def __enter__(self):
        deadline = time.time() + self.wait_s
        while True:
            try:
                self._fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                os.write(self._fd, str(os.getpid()).encode())
                return self
            except FileExistsError:
                try: age = time.time() - os.path.getmtime(self.path)
                except OSError: age = 0
                if age > self.stale_s:
                    try: os.remove(self.path)
                    except OSError: pass
                    continue
                if time.time() > deadline:
                    raise TimeoutError("GPU lock held")
                time.sleep(0.25)

    def __exit__(self, *exc):
        os.close(self._fd); self._fd = None
        try: os.remove(self.path)
        except OSError: pass


failures = 0
def check(ok, what):
    global failures
    print(("PASS " if ok else "FAIL ") + what)
    failures += 0 if ok else 1


d = tempfile.mkdtemp(prefix="gpu-lock-")
path = os.path.join(d, "gpu.lock")

# 1. the worker holds it: the studio waits and gives up
w = GpuFileLock(path, "chandra-worker stills test", wait_s=2)
w.acquire()
seen = GpuFileLock.read(path)
check(seen and seen["mine"] and seen["holder"].startswith("chandra-worker") and not seen["stale"], "the worker's lock names its holder and is live")
try:
    with StudioLock(path, wait_s=0.6): check(False, "the studio must not get the card while the worker holds it")
except TimeoutError:
    check(True, "the studio waits and gives up while the worker holds the card")
w.release()
check(not os.path.exists(path), "release removes the lock file")

# 2. the studio holds it: the worker waits and gives up, saying who holds it
with StudioLock(path):
    waits = []
    try:
        GpuFileLock(path, "chandra-worker", wait_s=0.6).acquire(on_wait=waits.append)
        check(False, "the worker must not get the card while the studio holds it")
    except TimeoutError as e:
        check("PID" in str(e) and str(os.getpid()) in str(e), "the worker gives up and names the holder's PID")
    check(waits and "only a PID" in waits[0]["holder"], "a studio lock is read as a bare PID")

# 3. a stale lock is taken over, by either side
with open(path, "w") as f: f.write("99999")
old = time.time() - 1000
os.utime(path, (old, old))
w = GpuFileLock(path, "chandra-worker", wait_s=1)
w.acquire()
check(GpuFileLock.read(path)["mine"], "a lock older than 15 minutes is taken over")
w.release()

# 4. a long job renews the lock so it never looks stale to the studio
w = GpuFileLock(path, "chandra-worker long", stale_s=900)
w.acquire()
os.utime(path, (old, old))                       # pretend the file is old
w._stop.set(); w._stop = threading.Event()       # restart the renewer with a short period for the test
def renew_fast():
    while not w._stop.wait(0.2):
        os.utime(path, None)
threading.Thread(target=renew_fast, daemon=True).start()
time.sleep(0.5)
try:
    with StudioLock(path, wait_s=0.6): check(False, "a renewed lock must not be taken as stale")
except TimeoutError:
    check(True, "a renewed lock is still live to the studio")
w.release()

print("ALL PASS" if not failures else f"{failures} FAILED")
sys.exit(1 if failures else 0)
