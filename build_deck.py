"""Build an Anki deck (category B) from data/questions.json.

Source: official HSC MVS base, order No. 225 of 29.10.2025, parsed by
parse_official.py + ocr_answers.py + build_dataset.py + finalize_dataset.py.
Usage: python build_deck.py [data_dir] [out.apkg]

Cards are split into priority tiers (subdecks) and new-card order inside the
whole deck goes hardest/most-likely first. Priority comes from two HSC MVS
publications:
  * ticket layout (hsc.gov.ua 2025-09-16): 10 traffic-rules questions,
    4 driving safety, 4 category-specific, 2 first aid -> a question from a
    small pool with many ticket slots is far more likely to show up;
  * top-5 error topics (hsc.gov.ua 2025-12-18): traffic controller gestures,
    unregulated intersections, roundabouts, road markings, first aid.
"""
import html
import json
import os
import re
import sys

import genanki

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
OUT = sys.argv[2] if len(sys.argv) > 2 else "PDR_UA_category_B.apkg"

# Sections 1-39 are common to all categories; 44-47 are the B1/B extras.
def is_cat_b(section_id):
    major = int(section_id.split(".")[0])
    return major <= 39 or 44 <= major <= 47

# HSC top-5 error topics: whole sections plus keyword hits anywhere else.
HOT_SECTIONS = {"8.1", "8.2", "16.2", "34"}
HOT_WORDS = re.compile(r"регулювальник|кругов|розмітк")

TIERS = [
    # (number, deck title, predicate on question)
    (1, "Додаткові питання кат. B — 4 з 20 у білеті",
     lambda q, m: 44 <= m <= 47),
    (2, "Домедична допомога — 2 з 20 у білеті, топ помилок ГСЦ",
     lambda q, m: q["section"] == "37"),
    (3, "Основи безпечного водіння — 4 з 20 у білеті",
     lambda q, m: q["section"] == "35"),
    (4, "Топ помилок ГСЦ — регулювальник, перехрестя, круг, розмітка",
     lambda q, m: q["section"] in HOT_SECTIONS
     or HOT_WORDS.search((q["text"] + " " + " ".join(q["options"])).lower())),
    (5, "Решта ПДР — ситуації з малюнком", lambda q, m: bool(q.get("images"))),
    (6, "Решта ПДР — текстові питання", lambda q, m: True),
]

def tier_of(q):
    major = int(q["section"].split(".")[0])
    return next(t for t in TIERS if t[2](q, major))

def difficulty(q):
    # No public per-question error stats exist, so approximate: more options
    # means less guessable, a picture means a situation to parse, longer
    # wording means more conditions to keep in mind.
    return (len(q["options"]), bool(q.get("images")),
            len(q["text"]) + sum(len(o) for o in q["options"]))

MODEL_ID = 1729150001
DECK_ROOT_ID = 1729150200

CSS = """
.card { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 18px;
        text-align: left; color: #1d1d1f; background: #fff; max-width: 760px; margin: 0 auto; }
.nightMode.card, .night_mode .card { color: #eee; background: #1e1e1e; }
.sec { font-size: 12px; color: #888; margin-bottom: 8px; }
.q { font-weight: 600; margin-bottom: 12px; }
img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 8px auto; }
ol.opts { padding-left: 1.4em; } ol.opts li { margin: 6px 0; padding: 4px 6px; border-radius: 6px; }
.back ol.opts li.ok { background: #d9f5df; font-weight: 600; }
.nightMode .back ol.opts li.ok, .night_mode .back ol.opts li.ok { background: #1f4d2b; }
.back ol.opts li:not(.ok) { opacity: .55; }
.ans { margin-top: 10px; font-size: 16px; }
.src { font-size: 11px; color: #999; margin-top: 14px; }
"""

FRONT = """
<div class="sec">{{Section}} · №{{Number}}</div>
<div class="q">{{Question}}</div>
{{Image}}
<ol class="opts">{{Options}}</ol>
"""

BACK = """
<div class="back">
<div class="sec">{{Section}} · №{{Number}}</div>
<div class="q">{{Question}}</div>
{{Image}}
<ol class="opts">{{OptionsMarked}}</ol>
<div class="ans">✅ Правильна відповідь: <b>{{CorrectNumber}}</b></div>
<div class="src">ID {{QID}} · база ГСЦ МВС, наказ №225 від 29.10.2025</div>
</div>
"""

model = genanki.Model(
    MODEL_ID,
    "PDR UA (multiple choice)",
    fields=[{"name": n} for n in (
        "QID", "Section", "Number", "Question", "Image",
        "Options", "OptionsMarked", "CorrectNumber")],
    templates=[{"name": "Card 1", "qfmt": FRONT, "afmt": BACK}],
    css=CSS,
    sort_field_index=0,
)


data = json.load(open(os.path.join(DATA, "questions.json"), encoding="utf-8"))
missing_check = [q["id"] for q in data["questions"]
                 if is_cat_b(q["section"]) and q["verified"] not in
                 ("ocr+template+brut", "template+brut", "manual")]
if missing_check:
    sys.exit(f"category B answers not verified: {missing_check}")
sections = {s["id"]: s["name"] for s in data["sections"]}

questions = [q for q in data["questions"] if is_cat_b(q["section"])]
# Tier first, then hardest first inside the tier; `due` is the new-card position.
questions.sort(key=lambda q: (tier_of(q)[0], tuple(-x for x in difficulty(q))))

decks = {}
media = set()
count = 0
for rank, q in enumerate(questions):
    sid = q["section"]
    tier_no, tier_name, _ = tier_of(q)
    if tier_no not in decks:
        decks[tier_no] = genanki.Deck(
            DECK_ROOT_ID + tier_no, f"ПДР України (кат. B)::{tier_no}. {tier_name}")

    imgs = []
    for rel in q.get("images") or []:
        path = os.path.join(DATA, rel)
        if not os.path.exists(path):
            sys.exit(f"missing image {path}")
        media.add(path)
        imgs.append(f'<img src="{html.escape(os.path.basename(rel))}">')

    opts = [html.escape(o) for o in q["options"]]
    plain = "".join(f"<li>{o}</li>" for o in opts)
    marked = "".join(
        f'<li class="ok">{o}</li>' if i == q["correctIndex"] else f"<li>{o}</li>"
        for i, o in enumerate(opts))

    sec_label = f"Розділ {sid}. {sections[sid].capitalize()}"
    if q.get("signGroup"):
        sec_label += f" — {q['signGroup'].split('(')[-1].rstrip(')').lower()}"
    note = genanki.Note(
        model=model,
        # GUID from the earlier (Brut322-based) id, so re-importing keeps study progress.
        guid=genanki.guid_for("pdr-ua", q["legacyId"]),
        fields=[q["id"], html.escape(sec_label),
                str(q["number"]), html.escape(q["text"]), "".join(imgs),
                plain, marked, str(q["correctNumber"])],
        tags=[f"pdr::section_{sid.replace('.', '_')}", "pdr::cat_B", f"pdr::tier_{tier_no}"]
             + (["pdr::with_image"] if imgs else []),
        due=rank,
    )
    decks[tier_no].add_note(note)
    count += 1

pkg = genanki.Package(list(decks.values()))
pkg.media_files = sorted(media)
pkg.write_to_file(OUT)
print(f"{count} notes, {len(decks)} subdecks, {len(media)} images -> {OUT}")
