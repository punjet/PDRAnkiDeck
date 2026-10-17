"""Category B selection, priority tiers and new-card order, shared by the Anki
deck (build_deck.py) and the web app (build_web.py).

Priority comes from two HSC MVS publications:
  * ticket layout (hsc.gov.ua 2025-09-16): 10 traffic-rules questions,
    4 driving safety, 4 category-specific, 2 first aid -> a question from a
    small pool with many ticket slots is far more likely to show up;
  * top-5 error topics (hsc.gov.ua 2025-12-18): traffic controller gestures,
    unregulated intersections, roundabouts, road markings, first aid.
"""
import re

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

# Exam ticket blocks: (key, questions per ticket, predicate on section major).
TICKET = [
    ("pdr", 10, lambda s, m: m <= 39 and s not in ("35", "37")),
    ("safety", 4, lambda s, m: s == "35"),
    ("category", 4, lambda s, m: 44 <= m <= 47),
    ("firstaid", 2, lambda s, m: s == "37"),
]


def tier_of(q):
    major = int(q["section"].split(".")[0])
    return next(t for t in TIERS if t[2](q, major))


def block_of(q):
    major = int(q["section"].split(".")[0])
    return next(b[0] for b in TICKET if b[2](q["section"], major))


def difficulty(q):
    # No public per-question error stats exist, so approximate: more options
    # means less guessable, a picture means a situation to parse, longer
    # wording means more conditions to keep in mind.
    return (len(q["options"]), bool(q.get("images")),
            len(q["text"]) + sum(len(o) for o in q["options"]))


def ordered(questions):
    """Category B questions, tier first, then hardest first inside the tier."""
    qs = [q for q in questions if is_cat_b(q["section"])]
    qs.sort(key=lambda q: (tier_of(q)[0], tuple(-x for x in difficulty(q))))
    return qs
