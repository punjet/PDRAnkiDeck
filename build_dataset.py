"""Join the parsed official questions with the OCR'd official answer table.

Usage:
  python build_dataset.py questions_official.json ans_ocr.json glyphs_dir out.json [overrides.json]

Answer table walk: the table lists sections in the same order as the question
PDF, eight questions per "Питання" row with a "Відповідь" row under it. Section
sizes are known from the question PDF, so the expected question number of every
token is known; OCR'd question numbers are only used to detect table anomalies
(duplicated or misnumbered rows), which are reported, not guessed.

Answer digits are read twice: tesseract (four modes, majority vote) and a
nearest-template classifier trained on glyphs where all tesseract modes agree.
A value is accepted when both agree; otherwise it is reported for manual review
and can be fixed via overrides.json ({"<section>-<number>": answer}).
"""
import json
import os
import re
import sys
from collections import Counter

import cv2
import numpy as np

QFILE, OCR, GLYPHS, OUT = sys.argv[1:5]
OVERRIDES = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else {}

qdata = json.load(open(QFILE, encoding="utf-8"))
questions = qdata["questions"]
sections = [s["id"] for s in qdata["sections"]]
size = Counter(q["section"] for q in questions)
rows = json.load(open(OCR, encoding="utf-8"))
rows.sort(key=lambda r: (r["page"], r["y"]))

# Column centres per page, from rows that show all eight data cells. Stray ink
# (e.g. the section number of a merged "Розділ N" cell) is dropped.
for page in {r["page"] for r in rows}:
    full = [r for r in rows if r["page"] == page and len(r["cells"]) == 8]
    centres = [float(np.median([r["cells"][k]["x"] for r in full])) for k in range(8)]
    for r in rows:
        if r["page"] != page:
            continue
        kept = []
        for c in r["cells"]:
            k = min(range(8), key=lambda i: abs(centres[i] - c["x"]))
            if abs(centres[k] - c["x"]) < 60:
                c["col"] = k
                kept.append(c)
        r["cells"] = kept


def kind(row):
    lab = row["label"].lower()
    if re.search(r"ит|тан|ання|итан", lab):
        return "q"
    if re.search(r"ідп|дпо|відп|овід|ові", lab):
        return "a"
    return "?"


def to_int(s):
    return int(s) if s.isdigit() else None


# --- template classifier for answer digits -------------------------------
def vec(name):
    g = cv2.imread(os.path.join(GLYPHS, name), cv2.IMREAD_GRAYSCALE)
    g = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    ys, xs = np.nonzero(g)
    g = g[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = g.shape
    # Keep the aspect ratio: a "1" is narrow and must not be stretched into a block.
    side = max(h, w)
    sq = np.zeros((side, side), np.uint8)
    sq[(side - h) // 2:(side - h) // 2 + h, (side - w) // 2:(side - w) // 2 + w] = g
    v = cv2.resize(sq, (24, 24), interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
    v = v / (np.linalg.norm(v) + 1e-6)
    return np.append(v, 2.0 * w / h)


answer_cells = [c for r in rows if kind(r) == "a" for c in r["cells"]]
train = [(vec(c["glyph"]), c["value"]) for c in answer_cells
         if c["value"] in "12345" and len(c["value"]) == 1
         and sum(o == c["value"] for o in c["ocr"]) >= 2]
T = np.stack([t[0] for t in train]); L = [t[1] for t in train]


def classify(cell):
    sims = -np.linalg.norm(T - vec(cell["glyph"]), axis=1)
    top = np.argsort(-sims)[:7]
    votes = Counter(L[i] for i in top)
    label, n = votes.most_common(1)[0]
    return label, float(sims[top[0]]), n


# --- walk the table ------------------------------------------------------
answers, issues, review = {}, [], []
sec_i, nxt = 0, 1          # current section index and next expected question number
pending_q = None           # last question row: list of (x, expected number, ocr value)

for row in rows:
    k = kind(row)
    if k == "?":
        # Unlabelled row: decide by content. Answer rows hold only digits 1..5.
        vals = [to_int(c["value"]) for c in row["cells"]]
        k = "a" if pending_q and all(v is None or 1 <= v <= 5 for v in vals) else "q"
        issues.append(f"p{row['page']} y{row['y']}: unreadable label, treated as {k}")
    if k == "q":
        if pending_q:
            issues.append(f"p{row['page']} y{row['y']}: two question rows in a row "
                          f"(previous one had no answers)")
        if sec_i >= len(sections):
            issues.append(f"p{row['page']} y{row['y']}: rows after the last section")
            pending_q = None
            continue
        vals = [to_int(c["value"]) for c in row["cells"]]
        # Row start as read: most common (number - position) among readable cells.
        cand = Counter(v - i for i, v in enumerate(vals) if v is not None)
        start, support = cand.most_common(1)[0] if cand else (None, 0)
        if nxt > size[sections[sec_i]]:
            sec_i, nxt = sec_i + 1, 1
        if support >= 2 and start == 1 and nxt != 1:
            # Table starts a new section earlier than the question PDF says.
            issues.append(f"p{row['page']} y{row['y']}: table restarts numbering, "
                          f"but section {sections[sec_i]} has only {nxt - 1} answers "
                          f"of {size[sections[sec_i]]}")
            sec_i, nxt = sec_i + 1, 1
        elif support >= 2 and start != nxt:
            issues.append(f"p{row['page']} y{row['y']}: table row reads "
                          f"{vals} (start {start}), expected start {sections[sec_i]}-{nxt}")
            if 1 <= start <= size[sections[sec_i]]:
                nxt = start
        if sec_i >= len(sections):
            pending_q = None
            continue
        toks = []
        for c in row["cells"]:
            if nxt > size[sections[sec_i]]:
                issues.append(f"p{row['page']} y{row['y']}: more cells than questions "
                              f"left in section {sections[sec_i]}")
                break
            toks.append((c["col"], sections[sec_i], nxt, to_int(c["value"])))
            nxt += 1
        pending_q = toks
        continue
    # answer row
    if not pending_q:
        issues.append(f"p{row['page']} y{row['y']}: answer row without question row "
                      f"{[c['value'] for c in row['cells']]}")
        continue
    used = set()
    for c in row["cells"]:
        same = [i for i, t in enumerate(pending_q) if t[0] == c["col"]]
        if not same or same[0] in used:
            issues.append(f"p{row['page']} y{row['y']}: answer in column {c['col']} "
                          f"has no question above it")
            continue
        j = same[0]
        x, s, e, _ = pending_q[j]
        used.add(j)
        qid = f"{s}-{e}"
        tess = c["value"]
        tmpl, sim, n = classify(c)
        if tess == tmpl:
            answers[qid] = {"answer": int(tess), "glyph": c["glyph"], "how": "ocr"}
        else:
            answers[qid] = {"answer": int(tmpl), "glyph": c["glyph"], "how": "template",
                            "tesseract": tess}
            review.append(qid)
    for j, (x, s, e, _) in enumerate(pending_q):
        if j not in used:
            issues.append(f"{s}-{e}: no answer cell under it (p{row['page']} y{row['y']})")
    pending_q = None

for qid, a in OVERRIDES.items():
    answers[qid] = {"answer": int(a), "how": "manual"}

out = []
missing = []
for q in questions:
    a = answers.get(q["id"])
    item = dict(q)
    if a is None:
        missing.append(q["id"])
        item["correctNumber"] = None
    else:
        item["correctNumber"] = a["answer"]
        item["answerSource"] = a["how"]
        if not 1 <= a["answer"] <= len(q["options"]):
            issues.append(f"{q['id']}: answer {a['answer']} but only "
                          f"{len(q['options'])} options")
    out.append(item)

json.dump({"source": qdata["source"], "sections": qdata["sections"], "questions": out},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
json.dump({"issues": issues, "review": review, "missing": missing,
           "glyphs": {k: v.get("glyph") for k, v in answers.items()}},
          open(OUT.replace(".json", "_report.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(f"{len(answers)} answers, {len(missing)} missing, {len(review)} need review, "
      f"{len(issues)} issues")
for i in issues:
    print("  ", i)
