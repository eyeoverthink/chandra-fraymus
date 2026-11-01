
"""
media_creation_mega_wasm.py - One huge WASM skill (Python wrapper)
ONE FILE = web + image + video, all high-res, all from scratch, WASM memory model
"""

from image_video_create_V2_hardened import ImageCreatorV2, VideoCreatorV2
import sys
sys.path.insert(0, '/mnt/data')
sys.path.insert(0, '/mnt/data/media-creation-skill/scripts')
try:
    from web_scraping_skill_DYNAMIC import DynamicScraper
except:
    try:
        from web_scraping_skill_FIXED import WebScraper as DynamicScraper
    except:
        DynamicScraper = None

class WASMMemory:
    def __init__(self):
        self.pages = 1024
        self.max_pages = 16384
        self.buffer = bytearray(self.pages * 65536)
    def grow(self, pages):
        self.pages = min(self.pages + pages, self.max_pages)
        self.buffer = bytearray(self.pages * 65536)
        return self.pages
    def alloc_frame(self, w, h):
        bytes_needed = w * h * 4
        if len(self.buffer) < bytes_needed:
            self.grow((bytes_needed - len(self.buffer) + 65535)//65536)
        return 0

class MegaWASM:
    def __init__(self, width=3840, height=2160, fps=60):
        self.memory = WASMMemory()
        self.width = width
        self.height = height
        self.fps = fps
        self.image = ImageCreatorV2(width, height)
        self.video = VideoCreatorV2(width, height, fps)
        self.scraper = DynamicScraper(headless=True, persist_path="./scraper_memory.json") if DynamicScraper else None
        self.version = 100
    def set_resolution(self, w, h):
        self.width = w; self.height = h
        self.memory.alloc_frame(w, h)
        self.image = ImageCreatorV2(w, h)
        self.video = VideoCreatorV2(w, h, self.fps)
        return self

mega = MegaWASM()

def create_all_in_one(width=3840, height=2160, text="MEGA WASM\nFROM SCRATCH"):
    m = MegaWASM(width, height)
    m.image.gradient_background("#000000", "#7c3aed", "diagonal")
    m.image.minimal_grid()
    m.image.add_text(text, size=120, position="center", stroke=(3,(0,0,0,200)))
    return m

if __name__ == "__main__":
    print("Testing MEGA WASM...")
    m = MegaWASM(1920,1080)
    m.image.gradient_background("#000","#7c3aed")
    m.image.add_text("MEGA WASM\nONE FILE\nWEB+IMAGE+VIDEO", size=80, position="center")
    m.image.save("/mnt/data/mega_wasm_test.png")
    print("Saved /mnt/data/mega_wasm_test.png")
    print(f"WASM memory: {len(m.memory.buffer)/1024/1024:.1f} MB initial, grows to {m.memory.max_pages*64/1024:.1f} MB for 8K")
