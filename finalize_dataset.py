"""Cross-check our dataset against Brut322/pdr-test and record verification status.

Usage: python finalize_dataset.py dataset.json brut_questions.json overrides.json out.json

For every question sets:
  verified: "ocr+template+brut"  - our two OCR readings and the independent dataset agree
            "template+brut"      - tesseract unsure, our template reading and the dataset agree
            "manual"             - checked by eye against the scan (overrides.json)
            "brut-only"          - our OCR could not read it (faded last page); answer from
                                   the independent dataset, not confirmed by us
            "brut-unconfirmed"   - outside category B, our OCR disagrees and nobody checked
                                   by eye; answer from the independent dataset
Category B conflicts are never auto-resolved: the script exits with an error.
  legacyId: the Brut322 id (section 33 there is split by sign type), used for stable
            Anki note GUIDs so study progress survives a rebuild.
Exits with an error if any answer still disagrees and was not resolved manually.
"""
import json
import sys

DATA, BRUT, OVR, OUT = sys.argv[1:5]
data = json.load(open(DATA, encoding="utf-8"))
brut = json.load(open(BRUT, encoding="utf-8"))
overrides = json.load(open(OVR))

by_official = {}
for q in brut["questions"]:
    s = q["section"]
    oid = f"33-{q['number']}" if s.startswith("33.") else f"{s}-{q['number']}"
    by_official[oid] = q

conflicts = []
for q in data["questions"]:
    b = by_official[q["id"]]
    q["legacyId"] = b["id"]
    q["signGroup"] = b["sectionName"] if q["section"] == "33" else None
    if q["id"] in overrides:
        q["correctNumber"] = overrides[q["id"]]
        q["verified"] = "manual"
    elif q["correctNumber"] is None:
        q["correctNumber"] = b["correctNumber"]
        q["verified"] = "brut-only"
    elif q["correctNumber"] != b["correctNumber"]:
        major = int(q["section"].split(".")[0])
        if major <= 39 or 44 <= major <= 47:
            conflicts.append((q["id"], q["correctNumber"], b["correctNumber"],
                              q.get("answerSource")))
            q["verified"] = "CONFLICT"
        else:
            # Outside category B, mostly the faded last scan page: not resolved by eye.
            q["correctNumber"] = b["correctNumber"]
            q["verified"] = "brut-unconfirmed"
    else:
        q["verified"] = ("ocr+template+brut" if q.get("answerSource") == "ocr"
                         else "template+brut")
    q.pop("answerSource", None)
    q["correctIndex"] = q["correctNumber"] - 1
    if q["verified"] != "CONFLICT":
        assert 0 <= q["correctIndex"] < len(q["options"]), q["id"]

json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
from collections import Counter
print(Counter(q["verified"] for q in data["questions"]))
if conflicts:
    print("unresolved conflicts (ours, brut, source):")
    for c in conflicts:
        print("  ", c)
    sys.exit(1)
