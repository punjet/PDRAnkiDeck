"""OCR the official scanned answer table (HSC MVS, order No. 225) into JSON.

Usage: python ocr_answers.py <dir with a01.png..a11.png at 300 dpi> out.json

Rows come from the table's horizontal rules. Vertical rules are too faint on
some pages, so cells are not used: inside a row, ink is split into tokens by
horizontal gaps; wide tokens are the "Розділ"/"Питання"/"Відповідь" labels and
everything right of the last label is data. Answers are later paired with the
question numbers above them by x position (see build_dataset.py).
Every token's crop is saved to glyphs/ so any value can be checked by eye.
"""
import glob
import json
import os
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np
import pytesseract

SRC, OUT = sys.argv[1], sys.argv[2]
GLYPHS = os.path.join(os.path.dirname(os.path.abspath(OUT)), "glyphs")
os.makedirs(GLYPHS, exist_ok=True)


def deskew(gray):
    bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    lines = cv2.HoughLinesP(bw, 1, np.pi / 1800, 400, minLineLength=gray.shape[1] // 3,
                            maxLineGap=10)
    segs = np.asarray(lines).reshape(-1, 4) if lines is not None else []
    angles = [np.degrees(np.arctan2(y1 - y0, x1 - x0)) for x0, y0, x1, y1 in segs]
    angles = [a for a in angles if abs(a) < 5]
    if not angles:
        return gray, 0.0
    a = float(np.median(angles))
    h, w = gray.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), a, 1.0)
    return cv2.warpAffine(gray, m, (w, h), flags=cv2.INTER_CUBIC, borderValue=255), a


def row_bounds(bw):
    """y positions of horizontal table rules."""
    k = bw.shape[1] // 6
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((1, k), np.uint8))
    proj = (horiz > 0).sum(axis=1)
    idx = np.where(proj > bw.shape[1] * 0.15)[0]
    ys, cur = [], []
    for i in idx:
        if cur and i - cur[-1] > 3:
            ys.append(int(np.mean(cur))); cur = []
        cur.append(i)
    if cur:
        ys.append(int(np.mean(cur)))
    return ys


def text_mask(bw):
    """Ink with table rules removed."""
    h = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((1, 50), np.uint8))
    v = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((35, 1), np.uint8))
    return cv2.subtract(bw, cv2.bitwise_or(h, v))


def tokens(mask, y0, y1):
    """Horizontal ink runs in a row strip -> list of (x0, x1, top, bottom)."""
    strip = mask[y0 + 4:y1 - 4]
    n, _, stats, _ = cv2.connectedComponentsWithStats(strip)
    comps = sorted((s for s in stats[1:]
                    if s[cv2.CC_STAT_AREA] > 30 and s[cv2.CC_STAT_HEIGHT] > 14),
                   key=lambda s: s[0])
    out = []
    for s in comps:
        x0, x1 = s[0], s[0] + s[2]
        top, bot = s[1], s[1] + s[3]
        if out and x0 - out[-1][1] < 22:
            px0, px1, pt, pb = out[-1]
            out[-1] = (px0, max(px1, x1), min(pt, top), max(pb, bot))
        else:
            out.append((x0, x1, top, bot))
    return [(x0, x1, t + y0 + 4, b + y0 + 4) for x0, x1, t, b in out]


def read_digits(gray, box):
    x0, x1, t, b = box
    g = gray[max(t - 3, 0):b + 3, max(x0 - 3, 0):x1 + 3]
    pad = cv2.copyMakeBorder(g, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
    pad = cv2.resize(pad, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    outs = [pytesseract.image_to_string(
        pad, config=f"--psm {psm} -c tessedit_char_whitelist=0123456789").strip()
        for psm in (10, 8, 7, 13)]
    votes = Counter(o for o in outs if o)
    best = votes.most_common(1)[0][0] if votes else ""
    return g, outs, best


def process(path):
    page = int(os.path.basename(path)[1:3])
    gray, angle = deskew(cv2.imread(path, cv2.IMREAD_GRAYSCALE))
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 31, 12)
    mask = text_mask(bw)
    ys = row_bounds(bw)
    rows = []
    for r in range(len(ys) - 1):
        y0, y1 = ys[r], ys[r + 1]
        if not 40 <= y1 - y0 <= 120:
            continue
        toks = tokens(mask, y0, y1)
        wide = [t for t in toks if t[1] - t[0] > 110]
        if not wide:
            continue
        label = wide[-1]
        data = [t for t in toks if t[0] > label[1] and t[1] - t[0] < 110]
        lab_img = gray[y0:y1, label[0]:label[1]]
        lab_txt = pytesseract.image_to_string(lab_img, lang="ukr", config="--psm 7").strip()
        cells = []
        for t in data:
            g, outs, best = read_digits(gray, t)
            gname = f"p{page:02d}_y{y0:04d}_x{t[0]:04d}.png"
            cv2.imwrite(os.path.join(GLYPHS, gname), g)
            cells.append({"x": float(t[0] + t[1]) / 2, "w": int(t[1] - t[0]), "ocr": outs,
                          "value": best, "glyph": gname})
        rows.append({"page": page, "y": int(y0), "angle": round(angle, 2),
                     "label": lab_txt, "label_x1": int(label[1]), "cells": cells})
    cv2.imwrite(os.path.join(GLYPHS, f"page{page:02d}_deskewed.png"), gray)
    return rows


if __name__ == "__main__":
    pages = sorted(glob.glob(os.path.join(SRC, "a*.png")))
    with ProcessPoolExecutor() as ex:
        result = [row for rows in ex.map(process, pages) for row in rows]
    json.dump(result, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(len(result), "rows")
