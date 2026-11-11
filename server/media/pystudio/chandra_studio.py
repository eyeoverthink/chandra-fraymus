"""Run fraymus-video-studio with a cast supplied by Chandra.

The studio's pixel recipes draw two built-in sprites. This launcher leaves the studio's files untouched
and, in memory only, teaches its pixel recipe to draw the sprites Chandra forged for this film
(server/media/sprite-forge.js): each one is a 16x16 grid of letters plus its own colours.

    python chandra_studio.py render script.md --recipe 8bit -o out ...      (same arguments as `studio`)

CHANDRA_SPRITES = path of a JSON file {"cast": [{"name", "rows": [16 strings], "colors": {letter: "#rrggbb"}, "closed": letter}]}.
Without it, or for a cast name that is not in the file, the studio behaves exactly as it always has.
The studio package must be importable (Chandra puts its checkout on PYTHONPATH).
"""
import json
import os
import sys

import numpy as np


def _rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]


def install(spec):
    from studio.recipes import pixel

    sprites = {}
    for c in spec.get("cast", []):
        rows = c["rows"]
        if len(rows) != 16 or any(len(r) != 16 for r in rows):
            raise ValueError(f"sprite {c.get('name')} is not 16x16")
        sprites[c["name"].lower()] = {"rows": rows, "rgb": {k: _rgb(v) for k, v in c["colors"].items()}, "closed": c.get("closed", "S")}

    original_cast = pixel._Pixel._cast
    original_sprite = pixel._Pixel.sprite_img

    def _cast(self, job):
        out = original_cast(self, job)
        for name, entry in out.items():
            if name in sprites:
                entry["sprite"] = sprites[name]
        return out

    def sprite_img(self, rows, talk, step):
        if not isinstance(rows, dict):
            return original_sprite(self, rows, talk, step)
        grid, rgb, closed = rows["rows"], rows["rgb"], rows["closed"]
        a = np.zeros((16, 16, 4), np.float32)
        for y, row in enumerate(grid):
            for x, ch in enumerate(row):
                if ch == ".":
                    continue
                if ch == "M" and not talk:
                    ch = closed
                a[y, x, :3] = rgb[ch]
                a[y, x, 3] = 255
        if step:  # walk frame: swap feet, as the studio does
            a[14:] = np.roll(a[14:], 1 if step > 0 else -1, axis=1)
        return a

    pixel._Pixel._cast = _cast
    pixel._Pixel.sprite_img = sprite_img
    return sorted(sprites)


def install_people(people):
    """Cartoon and comic: give the two flat figures the clothes, skin and hair colours Chandra chose for this film."""
    from studio.recipes import cartoon, comic

    table = {p["name"].lower(): p for p in people}
    original = cartoon.parse_cast

    def parse_cast(job):
        cast = original(job)
        for name, entry in cast.items():
            p = table.get(name)
            if p:
                entry.update(color=p["color"], skin=p["skin"], hair=p["hair"])
        return cast

    cartoon.parse_cast = parse_cast
    comic.parse_cast = parse_cast      # comic imported the name, so it holds its own reference
    return sorted(table)


def main():
    path = os.environ.get("CHANDRA_SPRITES")
    if path:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
        if spec.get("cast"):
            names = install(spec)
            print(f"[chandra] cast sprites installed: {', '.join(names)}", file=sys.stderr, flush=True)
        if spec.get("people"):
            names = install_people(spec["people"])
            print(f"[chandra] cast people installed: {', '.join(names)}", file=sys.stderr, flush=True)
    from studio.cli import main as studio_main
    studio_main()


if __name__ == "__main__":
    main()
