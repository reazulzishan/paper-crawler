#!/usr/bin/env python3
"""
build_extension.py - get the Chrome extension ready and zip it.

The spider code is shared with the web app, so this copies it in:
  js/loader.js, js/crawler.js, js/spider-draw.js  ->  extension/js/
  the .m-* markup part of css/style.css           ->  extension/css/markup.css
then draws the toolbar icons and writes dist/paper-crawler-extension.zip.

  python3 build_extension.py
"""
import math
import shutil
import struct
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).parent
EXT = ROOT / "extension"


def png(path, size):
    """Draw the spider icon (black body, teal legs, red feet) as a PNG, stdlib only."""
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    s = size / 128

    def dot(cx, cy, r, color):
        for y in range(max(0, int(cy - r - 1)), min(size, int(cy + r + 2))):
            for x in range(max(0, int(cx - r - 1)), min(size, int(cx + r + 2))):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                a = max(0.0, min(1.0, r - d + 0.5))
                if a > 0:
                    old = px[y][x]
                    px[y][x] = tuple(round(c * a + o * (1 - a)) for c, o in zip(color, old[:3])) + (max(old[3], round(255 * a)),)

    def line(x0, y0, x1, y1, w, color):
        steps = int(math.hypot(x1 - x0, y1 - y0) * 2) + 1
        for i in range(steps + 1):
            t = i / steps
            dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, color)

    teal, red, black = (25, 195, 214), (224, 48, 58), (12, 12, 14)
    cx, cy = 64 * s, 68 * s
    w = max(1.2, 5 * s)
    for side in (-1, 1):
        for ang, reach in ((-60, 50), (-20, 54), (20, 54), (60, 50)):
            a = math.radians(ang)
            kx, ky = cx + side * 30 * s * math.cos(a * 0.6), cy + (math.sin(a) * 26 - 22) * s
            fx, fy = cx + side * reach * s * math.cos(a * 0.5), cy + math.sin(a) * reach * s + 8 * s
            line(cx, cy, kx, ky, w, teal)
            line(kx, ky, fx, fy, w, teal)
            if size >= 32:
                dot(kx, ky, w * 0.9, red)
            dot(fx, fy, w * 1.1, red)
    dot(cx, cy + 14 * s, 17 * s, black)   # abdomen
    dot(cx, cy - 8 * s, 11 * s, black)    # thorax
    dot(cx + 3 * s, cy - 12 * s, max(1, 2.4 * s), (255, 255, 255))  # eye

    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    for f in ("loader.js", "crawler.js", "spider-draw.js"):
        shutil.copy(ROOT / "js" / f, EXT / "js" / f)
    css = (ROOT / "css" / "style.css").read_text()
    marker = css.index("/* =====")  # start of the "Markup effects" block
    (EXT / "css" / "markup.css").write_text("/* copied from css/style.css by build_extension.py; edit there */\n" + css[marker:])
    (EXT / "icons").mkdir(exist_ok=True)
    for n in (16, 48, 128):
        png(EXT / "icons" / f"{n}.png", n)

    # The website (site/) reuses the same pieces; it's a plain static folder for GitHub Pages.
    site = ROOT / "site"
    (site / "js").mkdir(parents=True, exist_ok=True)
    (site / "css").mkdir(exist_ok=True)
    (site / "vendor").mkdir(exist_ok=True)
    for f in ("loader.js", "crawler.js", "spider-draw.js"):
        shutil.copy(ROOT / "js" / f, site / "js" / f)
    for f in ("pdf-reader.js", "checks.js", "report-html.js"):
        shutil.copy(EXT / "js" / f, site / "js" / f)
    for f in ("pdf.min.mjs", "pdf.worker.min.mjs"):
        shutil.copy(EXT / "vendor" / f, site / "vendor" / f)
    shutil.copy(ROOT / "css" / "style.css", site / "css" / "style.css")
    shutil.copy(EXT / "css" / "report.css", site / "css" / "report.css")
    shutil.copy(EXT / "icons" / "128.png", site / "icon.png")
    (site / ".nojekyll").write_text("")  # GitHub Pages: serve files as they are
    print(f"website ready in {site.relative_to(ROOT)}/")

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / "paper-crawler-extension.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(EXT.rglob("*")):
            if f.is_file() and f.name != ".DS_Store":
                z.write(f, f.relative_to(EXT))
    print(f"extension ready in {EXT.relative_to(ROOT)}/  and  {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
