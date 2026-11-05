#!/usr/bin/env python3
"""Pick the best frame of a handheld menu video and flatten the page into a marker image.

    python3 tools/scrape/page_from_video.py video.mp4 --out data/menus/<id>/menu-1.png [--width 1400] [--debug dir]

For every Nth frame: find the bright page (low saturation, high value) as the largest
4-corner contour, score it by sharpness (Laplacian variance inside the page) x page area x
how rectangular it is, then perspective-warp the winning frame so the page fills a flat
image with its real aspect. That image is the tracking marker and the OCR input.
Needs opencv-python-headless + numpy.
"""
import argparse, sys
from pathlib import Path

import cv2
import numpy as np


def order_quad(pts):
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)  # tl, tr, br, bl


def find_page(bgr):
    """Largest bright, low-saturation 4-corner region. Returns (quad in image px, rectangularity) or None."""
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (0, 0, 140), (180, 70, 255))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in contours:
        area = cv2.contourArea(c)
        if area < 0.08 * w * h:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.03 * peri, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            hull = cv2.convexHull(c)
            approx = cv2.approxPolyDP(hull, 0.03 * cv2.arcLength(hull, True), True)
            if len(approx) != 4:
                continue
        rect_area = cv2.minAreaRect(approx)[1]
        rect_area = rect_area[0] * rect_area[1]
        rectangularity = area / rect_area if rect_area > 0 else 0
        if best is None or area > best[1]:
            best = (order_quad(approx), area, rectangularity)
    return best


def quad_aspect(q):
    """Width / height of the page from its edge lengths (perspective ignored; good enough to pick)."""
    tl, tr, br, bl = q
    wtop, wbot = np.linalg.norm(tr - tl), np.linalg.norm(br - bl)
    hl, hr = np.linalg.norm(bl - tl), np.linalg.norm(br - tr)
    return (wtop + wbot) / max(1e-6, hl + hr), (min(wtop, wbot) / max(wtop, wbot)) * (min(hl, hr) / max(hl, hr))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1400, help="output page width in px")
    ap.add_argument("--aspect", type=float, default=None, help="page width/height; default from the best frame")
    ap.add_argument("--step", type=int, default=3, help="look at every Nth frame")
    ap.add_argument("--debug", default=None, help="folder for the chosen raw frame + mask")
    ap.add_argument("--frame", type=int, default=None, help="use this frame index instead of scanning")
    ap.add_argument("--corners", default=None, help='page corners in that frame, "x,y x,y x,y x,y" (tl tr br bl), when auto-detection fails')
    a = ap.parse_args()

    cap = cv2.VideoCapture(a.video)
    if not cap.isOpened():
        print(f"cannot open {a.video}", file=sys.stderr)
        return 1
    best = None  # (score, frame_index, frame, quad)
    if a.frame is not None and a.corners:
        cap.set(cv2.CAP_PROP_POS_FRAMES, a.frame)
        ok, frame = cap.read()
        if not ok:
            print(f"cannot read frame {a.frame}", file=sys.stderr)
            return 1
        q = order_quad(np.array([[float(v) for v in c.split(",")] for c in a.corners.split()], np.float32))
        aspect, parallel = quad_aspect(q)
        best = (1.0, a.frame, frame, q, aspect, 0.0, 1.0, parallel)
    i = 0
    while best is None or a.frame is None:
        ok, frame = cap.read()
        if not ok:
            break
        if a.frame is not None and i != a.frame:
            i += 1
            continue
        if i % a.step == 0 or a.frame is not None:
            small = cv2.resize(frame, None, fx=0.5, fy=0.5)
            page = find_page(small)
            if page is not None:
                q, area, rectangularity = page
                aspect, parallel = quad_aspect(q)
                sh, sw = small.shape[:2]
                area_frac = area / (sw * sh)
                # sharpness inside the page only
                m = np.zeros(small.shape[:2], np.uint8)
                cv2.fillConvexPoly(m, q.astype(np.int32), 255)
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                lap = cv2.Laplacian(gray, cv2.CV_64F)
                sharp = float(lap[m > 0].var()) if (m > 0).any() else 0.0
                # keep the page inside the frame: corners near the border mean it is cut off
                margin = min(q[:, 0].min(), q[:, 1].min(), sw - q[:, 0].max(), sh - q[:, 1].max())
                inside = 1.0 if margin > 4 else 0.3
                score = sharp * area_frac * (parallel ** 2) * rectangularity * inside
                if best is None or score > best[0]:
                    best = (score, i, frame.copy(), q * 2.0, aspect, sharp, area_frac, parallel)
        i += 1
    cap.release()
    if best is None:
        print("no page found in any frame", file=sys.stderr)
        return 2
    score, idx, frame, q, aspect, sharp, area_frac, parallel = best
    aspect = a.aspect or aspect
    W = a.width
    H = int(round(W / aspect))
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    M = cv2.getPerspectiveTransform(q.astype(np.float32), dst)
    page = cv2.warpPerspective(frame, M, (W, H), flags=cv2.INTER_CUBIC)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), page)
    if a.debug:
        d = Path(a.debug)
        d.mkdir(parents=True, exist_ok=True)
        dbg = frame.copy()
        cv2.polylines(dbg, [q.astype(np.int32)], True, (0, 255, 0), 4)
        cv2.imwrite(str(d / "chosen-frame.jpg"), dbg)
    print(f"frame {idx}: sharpness {sharp:.0f}, page {area_frac * 100:.0f}% of frame, edges parallel {parallel:.2f}, aspect {aspect:.3f} -> {out} ({W}x{H})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
