#!/usr/bin/env python3
"""Build one contact sheet (montage) from a directory of images, for fast visual review.

Usage:
  python tools/contact_sheet.py <dir> --out <file.jpg> [--cols 4] [--cell 420] [--max 16]

Cells keep aspect ratio (fit inside cell, centred, black background), evenly
sampled across the directory, with filename captions.
"""
import sys, os, argparse
from PIL import Image, ImageDraw, ImageFont


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--cell", type=int, default=420)
    ap.add_argument("--max", type=int, default=16)
    args = ap.parse_args()
    files = [os.path.join(args.dir, f) for f in sorted(os.listdir(args.dir))
             if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
    if not files:
        sys.exit("no images")
    if len(files) > args.max:
        step = len(files) / args.max
        files = [files[int(i * step)] for i in range(args.max)]
    cell = args.cell
    cols = args.cols
    rows = (len(files) + cols - 1) // cols
    pad, cap = 8, 26
    W = cols * (cell + pad) + pad
    H = rows * (cell + pad + cap) + pad
    sheet = Image.new("RGB", (W, H), (8, 8, 10))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 16)
    except Exception:
        font = ImageFont.load_default()
    for i, f in enumerate(files):
        im = Image.open(f).convert("RGB")
        im.thumbnail((cell, cell))
        x = pad + (i % cols) * (cell + pad)
        y = pad + (i // cols) * (cell + pad + cap)
        ox = x + (cell - im.width) // 2
        oy = y + (cell - im.height) // 2
        sheet.paste(im, (ox, oy))
        d.text((x, y + cell + 4), os.path.basename(f)[:58], fill=(200, 200, 200), font=font)
    sheet.save(args.out, quality=88)
    print(f"[wrote {args.out}] {len(files)} images {W}x{H}")


if __name__ == "__main__":
    main()
