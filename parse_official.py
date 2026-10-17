"""Parse the official HSC MVS question PDF into JSON + images.

Source: https://hsc.gov.ua/index/poslugi/vidacha-posvidchennya-vodiya/pitannya-ta-ispit-z-pdr/
("Екзаменаційні питання", order No. 225 of 29.10.2025).

Usage: python parse_official.py questions.pdf out_dir
Writes out_dir/questions_official.json and out_dir/images/*.
Answers are NOT in this PDF (they are in a separate scanned table).
"""
import json
import os
import re
import sys

import pymupdf

PDF, OUT = sys.argv[1], sys.argv[2]
IMG_DIR = os.path.join(OUT, "images")
os.makedirs(IMG_DIR, exist_ok=True)

HEADER_RE = re.compile(r"^(\d+(?:\.\d+)?)\.\s*(\S.*)$")
QUESTION_RE = re.compile(r"^(\d+)\.\s*(.*)$")
OPTION_RE = re.compile(r"^([1-9])\)\s*(.*)$")


def is_upper(text):
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.85


def page_items(page):
    """Lines (merged by baseline) and image blocks of one page, in reading order."""
    d = page.get_text("dict")
    items = []
    for b in d["blocks"]:
        if b["type"] == 1:
            items.append({"kind": "img", "y": b["bbox"][1], "x": b["bbox"][0], "block": b})
            continue
        for l in b["lines"]:
            text = "".join(s["text"] for s in l["spans"])
            if not text.strip():
                continue
            span = next(s for s in l["spans"] if s["text"].strip())
            items.append({"kind": "text", "y": round(l["bbox"][1]), "x": l["bbox"][0],
                          "text": text, "bold": "Bold" in span["font"],
                          "font": span["font"]})
    # Group text into visual rows: an option marker "2)" and its text can sit
    # a couple of points apart vertically, so cluster by y with a tolerance and
    # then read each row left to right.
    items.sort(key=lambda i: i["y"])
    rows = []
    for it in items:
        if (it["kind"] == "text" and rows and rows[-1][0]["kind"] == "text"
                and abs(it["y"] - rows[-1][0]["y"]) <= 3):
            rows[-1].append(it)
        else:
            rows.append([it])
    merged = []
    for row in rows:
        row.sort(key=lambda i: i["x"])
        first = dict(row[0])
        if first["kind"] == "text":
            first["text"] = " ".join(i["text"].strip() for i in row)
            # A row is bold when its words are; a lone non-bold "2)" marker
            # must not make a bold option look regular, nor the reverse.
            words = [i for i in row if not re.fullmatch(r"[1-9]\)", i["text"].strip())]
            first["bold"] = (words or row)[0]["bold"]
        merged.append(first)
    return merged


def clean(s):
    return re.sub(r"\s+", " ", s).strip()


doc = pymupdf.open(PDF)
sections, questions, warnings = [], [], []
section = None          # current section dict
q = None                # current question dict
in_header = False
bullet_pending = False
img_count = 0

for pno, page in enumerate(doc):
    for it in page_items(page):
        if it["kind"] == "img":
            if q is None:
                warnings.append(f"p{pno+1}: image outside question")
                continue
            blk = it["block"]
            x0, y0, x1, y1 = blk["bbox"]
            if x1 - x0 < 20 and y1 - y0 < 20:
                # Tiny picture used as a list bullet (e.g. 45-16): next line is an option.
                bullet_pending = True
                continue
            ext = blk.get("ext", "png")
            name = f"s{section['id'].replace('.', '-')}_q{q['number']}_{len(q['images'])+1}.{ext}"
            with open(os.path.join(IMG_DIR, name), "wb") as f:
                f.write(blk["image"])
            q["images"].append(f"images/{name}")
            img_count += 1
            in_header = False
            continue

        text = it["text"]
        stripped = text.strip()
        # Page numbers (Calibri digits) and the document title on page 1.
        if "Calibri" in it["font"] and stripped.isdigit():
            continue
        if pno == 0 and section is None and not HEADER_RE.match(stripped):
            continue

        m = OPTION_RE.match(stripped)
        if it["bold"] and q is not None and m and int(m.group(1)) == len(q["options"]) + 1:
            # Options set in bold by mistake (e.g. 37-48).
            q["options"].append(m.group(2))
            continue

        if it["bold"]:
            m = HEADER_RE.match(stripped)
            if m and is_upper(m.group(2)):
                section = {"id": m.group(1), "name": clean(m.group(2))}
                sections.append(section)
                q, in_header = None, True
                continue
            if in_header and is_upper(stripped):
                section["name"] = clean(section["name"] + " " + stripped)
                continue
            in_header = False
            m = QUESTION_RE.match(stripped)
            expected = (q["number"] + 1) if q else 1
            if m and (int(m.group(1)) == expected or q is None or q["options"]):
                if int(m.group(1)) != expected:
                    warnings.append(f"p{pno+1}: section {section['id']} q{m.group(1)} "
                                    f"(expected {expected})")
                q = {"section": section["id"], "number": int(m.group(1)),
                     "text": m.group(2), "options": [], "images": [], "page": pno + 1}
                questions.append(q)
            elif q is not None and not q["options"]:
                q["text"] += " " + stripped
            elif q is not None:
                # Bold text after options started: a note under the options.
                q["options"][-1] += " " + stripped
                warnings.append(f"p{pno+1}: bold text after options in "
                                f"{q['section']}-{q['number']}: {stripped[:50]}")
            continue

        in_header = False
        if q is None:
            warnings.append(f"p{pno+1}: text outside question: {stripped[:60]}")
            continue
        m = OPTION_RE.match(stripped)
        mq = QUESTION_RE.match(stripped)
        if m and int(m.group(1)) == len(q["options"]) + 1:
            q["options"].append(m.group(2))
        elif (mq and len(q["options"]) >= 2 and int(mq.group(1)) == q["number"] + 1):
            # Question number set in regular font by mistake (e.g. 16.2-27).
            warnings.append(f"p{pno+1}: non-bold question {section['id']}-{mq.group(1)}")
            q = {"section": section["id"], "number": int(mq.group(1)),
                 "text": mq.group(2), "options": [], "images": [], "page": pno + 1}
            questions.append(q)
        elif bullet_pending or (not q["options"] and q["images"]):
            # Unnumbered options: question text is always bold, so regular text
            # after the question's picture is an answer option (45-16).
            q["options"].append(stripped)
        elif q["options"]:
            q["options"][-1] += " " + stripped
        else:
            q["text"] += " " + stripped
        bullet_pending = False

INLINE_OPTS = re.compile(r"^\s*1\.\s*(.+?)\s+2\.\s*(.+?)$")
for x in questions:
    x["id"] = f"{x['section']}-{x['number']}"
    x["text"] = clean(x["text"])
    m = INLINE_OPTS.match(clean(x["options"][0])) if len(x["options"]) == 1 else None
    if m:
        # Options typed on one line as "1. … 2. …" (e.g. 16.1-34).
        x["options"] = [o.rstrip(".»\" ") + "." for o in m.groups()]
        warnings.append(f"{x['id']}: inline options split")
    x["options"] = [clean(o) for o in x["options"]]
    if len(x["options"]) < 2:
        warnings.append(f"{x['id']}: only {len(x['options'])} options")

with open(os.path.join(OUT, "questions_official.json"), "w", encoding="utf-8") as f:
    json.dump({"source": "hsc.gov.ua, order No. 225 of 29.10.2025",
               "sections": sections, "questions": questions}, f, ensure_ascii=False, indent=1)

print(f"{len(sections)} sections, {len(questions)} questions, {img_count} images")
print(f"{len(warnings)} warnings")
for w in warnings:
    print("  ", w)
