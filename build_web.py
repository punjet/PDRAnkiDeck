"""Build the static web app (GitHub Pages) from web/ and data/questions.json.

Usage: python build_web.py [data_dir] [out_dir]

Writes out_dir/ = web/* + questions.json + static SEO pages (build_seo.py) (category B only, in new-card order,
same tiers as the Anki deck) + img/ (only the pictures those questions use).
Needs nothing beyond the standard library, so CI can run it as is.
"""
import hashlib
import json
import os
import shutil
import sys

import build_seo
from deck_order import TICKET, TIERS, block_of, ordered, tier_of

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
OUT = sys.argv[2] if len(sys.argv) > 2 else "_site"
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

data = json.load(open(os.path.join(DATA, "questions.json"), encoding="utf-8"))
sections = {s["id"]: s["name"] for s in data["sections"]}

if os.path.exists(OUT):
    shutil.rmtree(OUT)
shutil.copytree(WEB, OUT)
os.makedirs(os.path.join(OUT, "img"))

# Confusable neighbours from similar.py (optional): ids of look-alike questions with another answer.
sim_path = os.path.join(DATA, "similar.json")
SIMJ = json.load(open(sim_path, encoding="utf-8")) if os.path.exists(sim_path) else {}
SIM = SIMJ.get("similar", {})
NEAR = SIMJ.get("near", {})   # closest questions by meaning, any answer: hints for auto-grading

out = []
seo = []  # same entries plus the section id, for build_seo
for q in ordered(data["questions"]):
    if q["verified"] not in ("ocr+template+brut", "template+brut", "manual"):
        sys.exit(f"category B answer not verified: {q['id']}")
    imgs = []
    pics = q.get("images") or []
    for j, rel in enumerate(pics):
        # Descriptive, stable file names ("16-2-74-yaka-chergovist-proizdu.jpeg"): Google uses
        # them for image search. Built from the question number and text, which never change.
        ext = rel.rsplit(".", 1)[-1].lower()
        stem = f"{q['legacyId'].replace('.', '-')}-{build_seo.slug(q['text'])[:40].strip('-')}"
        name = f"{stem}{'-' + str(j + 1) if len(pics) > 1 else ''}.{ext}"
        shutil.copy(os.path.join(DATA, rel), os.path.join(OUT, "img", name))
        imgs.append(name)
    sec = f"Розділ {q['section']}. {sections[q['section']].capitalize()}"
    sec = sec.replace("в1, в", "B1, B")
    if q.get("signGroup"):
        sec += f" — {q['signGroup'].split('(')[-1].rstrip(')').lower()}"
    out.append({
        # The Anki GUID source, so progress could be mapped between the two.
        "id": q["legacyId"],
        "sec": sec,
        "num": q["number"],
        "t": q["text"],
        "img": imgs,
        "o": q["options"],
        "a": q["correctIndex"],
        "tier": tier_of(q)[0],
        "block": block_of(q),
    })
    if SIM.get(q["legacyId"]):
        out[-1]["sim"] = [i for i, _ in SIM[q["legacyId"]]]
    if NEAR.get(q["legacyId"]):
        out[-1]["nb"] = NEAR[q["legacyId"]]
    seo.append({**out[-1], "section": q["section"]})

# Search keywords from topics.py (optional): phrases people type, Ukrainian and Russian.
kw_path = os.path.join(DATA, "keywords.json")
KW = json.load(open(kw_path, encoding="utf-8"))["kw"] if os.path.exists(kw_path) else {}
for e in out:
    if KW.get(e["id"]):
        e["kw"] = KW[e["id"]]

# Topics from topics.py (optional): groups of questions by meaning, for search and practice.
topics_path = os.path.join(DATA, "topics.json")
TOPICS = json.load(open(topics_path, encoding="utf-8"))["topics"] if os.path.exists(topics_path) else []

known_ids = {e["id"] for e in out}
for e in out:   # a neighbour may be a question left out of category B
    for k in ("sim", "nb"):
        keep = [i for i in e.pop(k, []) if i in known_ids]
        if keep:
            e[k] = keep

payload = {
    "source": "ГСЦ МВС, наказ № 225 від 29.10.2025",
    "tiers": [{"n": n, "name": name} for n, name, _ in TIERS],
    "ticket": [{"block": k, "count": c} for k, c, _ in TICKET],
    "questions": out,
}
if TOPICS:
    payload["topics"] = [{**t, "q": [i for i in t["q"] if i in known_ids]} for t in TOPICS]
body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
with open(os.path.join(OUT, "questions.json"), "w", encoding="utf-8") as f:
    f.write(body)

# Cache version for the service worker: changes whenever the app or data does.
h = hashlib.sha256(body.encode())
for root, _, files in sorted(os.walk(WEB)):
    for name in sorted(files):
        with open(os.path.join(root, name), "rb") as f:
            h.update(f.read())
sw = os.path.join(OUT, "sw.js")
with open(sw, encoding="utf-8") as f:
    src = f.read()
with open(sw, "w", encoding="utf-8") as f:
    f.write(src.replace("__BUILD__", h.hexdigest()[:12]))

seo_stats = build_seo.build(OUT, seo, sections, {k: c for k, c, _ in TICKET})

print(f"{len(out)} questions ({seo_stats['explained']} explained), "
      f"{seo_stats['sitemap']} pages in sitemap, "
      f"{len(os.listdir(os.path.join(OUT, 'img')))} images -> {OUT}/")
