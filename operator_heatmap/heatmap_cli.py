#!/usr/bin/env python3
"""Command line: video -> operator heat map / spaghetti PDF.

Examples
  python heatmap_cli.py line3.mp4 --segments "00:05:00-00:20:00, 01:10:00-01:25:00"
  python heatmap_cli.py roof360.mp4 --camera fisheye --mount-height 7.5
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
    ap.add_argument("--camera", choices=["fixed", "fisheye", "360"], default="fixed",
                    help="fisheye = ceiling 360 (circular image); 360 = equirectangular panorama")
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
    ap.add_argument("--operators", type=int, default=0, help="optional: operators working the area (0 = auto)")
    ap.add_argument("--resident-min-s", type=float, default=0.0,
                    help="min seconds in area to count as an operator, else through-traffic (0 = auto)")
    ap.add_argument("--stitch-gap-s", type=float, default=15.0, help="max seconds hidden before a new ID")
    ap.add_argument("--imgsz", type=int, default=960, help="1280 for small/distant operators")
    ap.add_argument("--mount-height", type=float, default=0.0, help="fisheye lens height (m) -> metres walked")
    ap.add_argument("--lens-fov", type=float, default=180.0)
    ap.add_argument("--lens-model", choices=["equidistant", "equisolid"], default="equidistant")
    ap.add_argument("--fisheye-circle", default="", help='"cx,cy,r" if auto-detect is wrong')
    ap.add_argument("--tiles", type=int, default=6)
    ap.add_argument("--roi", default="", help='area isolation JSON, e.g. \'{"include":[{"sector":[200,320,20,90]}]}\'')
    ap.add_argument("--no-crop", dest="crop_output", action="store_false", help="keep full view in PDF")
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
        if isinstance(v, str):
            print(f"{k:14s} {v}")
    an = out["analysis"]
    print(f"crew on floor  typical {an.crew['median']:.0f}, peak {an.crew['max']:.0f}  |  "
          f"through-traffic {an.through['passes']:.0f} passes ({an.through['per_hour']:.0f}/h)")


if __name__ == "__main__":
    main()
