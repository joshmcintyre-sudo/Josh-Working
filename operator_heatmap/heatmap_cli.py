#!/usr/bin/env python3
"""Command line: video -> operator heat map / spaghetti PDF.

Examples
  python heatmap_cli.py line3.mp4 --segments "00:05:00-00:20:00, 01:10:00-01:25:00"
  python heatmap_cli.py cell360.mp4 --camera 360 --yaw 90 --pitch -30 --fov 110
  python heatmap_cli.py line3.mp4 --config examples/zones_example.json --base-time 00:06:10
"""
import argparse
import sys

from operator_heatmap import Options, run


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--out-dir", default="output")
    ap.add_argument("--title", default="")
    ap.add_argument("--camera", choices=["fixed", "360"], default="fixed")
    ap.add_argument("--segments", default="", help='e.g. "00:01:00-00:04:00, 10:00-12:30" (blank = all)')
    ap.add_argument("--base-time", default="", help="timestamp of background photo")
    ap.add_argument("--backend", choices=["yolo", "motion"], default="yolo")
    ap.add_argument("--model", default="yolo11n.pt")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--sample-fps", type=float, default=5.0)
    ap.add_argument("--config", default="", help="zones + calibration JSON")
    ap.add_argument("--page", choices=["A3", "A4"], default="A3")
    ap.add_argument("--yaw", type=float, default=0.0)
    ap.add_argument("--pitch", type=float, default=-20.0)
    ap.add_argument("--fov", type=float, default=100.0)
    ap.add_argument("--min-track-s", type=float, default=2.0)
    a = ap.parse_args()

    opts = Options(**{k: v for k, v in vars(a).items()})
    last = [-1]

    def progress(p):
        pct = int(p * 100)
        if pct != last[0]:
            last[0] = pct
            sys.stderr.write(f"\rAnalysing... {pct:3d}%")
            sys.stderr.flush()

    out = run(opts, progress)
    sys.stderr.write("\n")
    for k, v in out.items():
        print(f"{k:10s} {v}")


if __name__ == "__main__":
    main()
