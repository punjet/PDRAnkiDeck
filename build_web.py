"""Build the static web app (GitHub Pages) from web/ and data/questions.json.

Usage: python build_web.py [data_dir] [out_dir]

Writes out_dir/ = web/* + questions.json (category B only, in new-card order,
same tiers as the Anki deck) + img/ (only the pictures those questions use).
Needs nothing beyond the standard library, so CI can run it as is.
"""
import hashlib
import json
import os
import shutil
import sys

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

out = []
for q in ordered(data["questions"]):
    if q["verified"] not in ("ocr+template+brut", "template+brut", "manual"):
        sys.exit(f"category B answer not verified: {q['id']}")
    imgs = []
    for rel in q.get("images") or []:
        name = os.path.basename(rel)
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

payload = {
    "source": "ГСЦ МВС, наказ № 225 від 29.10.2025",
    "tiers": [{"n": n, "name": name} for n, name, _ in TIERS],
    "ticket": [{"block": k, "count": c} for k, c, _ in TICKET],
    "questions": out,
}
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

print(f"{len(out)} questions, "
      f"{len(os.listdir(os.path.join(OUT, 'img')))} images -> {OUT}/")
