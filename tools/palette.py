#!/usr/bin/env python3
"""Extract a measured colour palette from one or many images.

Usage:
  python tools/palette.py <image-or-dir> [more...] [--colors 12] [--json out.json]

Prints a markdown table (hex / rgb / share) plus global stats:
mean luminance, mean saturation, dominant hue family, brightest accent.
Uses PIL median-cut quantisation on a downscaled copy (fast, deterministic).
"""
import sys, os, json, argparse
from collections import Counter
from PIL import Image
import colorsys


def pixels(im):
    """Pillow ≥14 移除了 getdata；优先用 get_flattened_data，向下兼容。"""
    if hasattr(im, "get_flattened_data"):
        return list(im.get_flattened_data())
    return list(im.getdata())


def analyse(path, n_colors=12):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    scale = max(1, int(min(w, h) / 480))
    small = im.resize((max(1, w // scale), max(1, h // scale)))
    q = small.quantize(colors=n_colors, method=Image.MEDIANCUT)
    pal = q.getpalette()[: n_colors * 3]
    counts = Counter(pixels(q))
    total = sum(counts.values()) or 1
    entries = []
    for idx, cnt in counts.most_common():
        r, g, b = pal[idx * 3: idx * 3 + 3]
        hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        entries.append({
            "hex": "#%02x%02x%02x" % (r, g, b),
            "rgb": [r, g, b],
            "share": round(100.0 * cnt / total, 2),
            "lum": round(ll, 3),
            "sat": round(ss, 3),
            "hue": round(hh * 360, 1),
        })
    px = pixels(small)
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for (r, g, b) in px]
    sats = [colorsys.rgb_to_hls(r / 255, g / 255, b / 255)[2] for (r, g, b) in px]
    # most saturated bright pixel family = accent
    acc = max(px, key=lambda p: max(p) - min(p))
    return {
        "file": os.path.basename(path),
        "size": [w, h],
        "palette": entries,
        "meanLum": round(sum(lum) / len(lum), 1),
        "meanSat": round(100 * sum(sats) / len(sats), 1),
        "accentCandidate": "#%02x%02x%02x" % acc,
    }


def md_report(results):
    out = []
    for r in results:
        out.append(f"### {r['file']}  ({r['size'][0]}×{r['size'][1]})\n")
        out.append("| hex | rgb | share % | lum | sat | hue |")
        out.append("|---|---|---|---|---|---|")
        for p in r["palette"]:
            out.append("| `%s` | %s | %.2f | %.2f | %.2f | %s° |" % (
                p["hex"], tuple(p["rgb"]), p["share"], p["lum"], p["sat"], p["hue"]))
        out.append(f"\n_mean luminance {r['meanLum']} · mean saturation {r['meanSat']}% · accent candidate `{r['accentCandidate']}`_\n")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--colors", type=int, default=12)
    ap.add_argument("--json", default=None)
    ap.add_argument("--md", default=None, help="把 markdown 报告直接写进文件（UTF-8，避免 PowerShell 重定向乱码）")
    args = ap.parse_args()
    files = []
    for p in args.inputs:
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p))
                      if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
        else:
            files.append(p)
    results = []
    for f in files:
        try:
            results.append(analyse(f, args.colors))
        except Exception as e:  # noqa
            print(f"!! {f}: {e}", file=sys.stderr)
    report = md_report(results)
    print(report)
    if args.md:
        with open(args.md, "w", encoding="utf-8") as fh:
            fh.write(report)
        print(f"\n[wrote {args.md}]")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2)
        print(f"\n[wrote {args.json}]")


if __name__ == "__main__":
    main()
