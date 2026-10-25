"""Confusable questions: for each exam question, the ones most like it that have a
different right answer. Shown after a wrong answer ("не сплутайте") and on the
static question pages.

Run once locally:
  python similar.py            # asks for the OpenAI API key, writes data/similar.json
The key is read with a hidden prompt (or from OPENAI_API_KEY) and is not stored.
Embeddings are cached in work/ (git-ignored), so a re-run with other thresholds
costs nothing. The result is committed: the site build needs only the standard library.
Cost: ~3500 short texts with text-embedding-3-large, about $0.02.

How "alike" is measured: each question is embedded twice:
  context = question text + all its options   -> what the question looks like
  answer  = text of the right option          -> what you have to remember
Two questions are confusable when their contexts are close but their answers are
not: people mix them up exactly because they look the same. Questions with a
picture mostly share generic text ("Зображений дорожній знак позначає:"), so
for them the options carry the meaning, which is why they are part of the context.
"""
import getpass
import hashlib
import json
import os
import sys

import numpy as np
from openai import OpenAI

from deck_order import ordered

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "similar.json")
CACHE = os.path.join(ROOT, "work", "embeddings.json")
MODEL = "text-embedding-3-large"
GOOD = ("ocr+template+brut", "template+brut", "manual")
BATCH = 256

CONTEXT_MIN = 0.80   # contexts at least this close count as "looks the same" (below ~0.75: same topic only)
ANSWER_MAX = 0.85    # and right answers less close than this count as "different"
PER_QUESTION = 3


def key_of(text):
    return hashlib.sha1(f"{MODEL}\n{text}".encode()).hexdigest()


def embed(texts):
    cache = {}
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            cache = json.load(f)
    todo = sorted({t for t in texts if key_of(t) not in cache})
    if todo:
        key = os.environ.get("OPENAI_API_KEY") or getpass.getpass("OpenAI API key (не відображається): ").strip()
        if not key:
            sys.exit("Ключ не введено.")
        client = OpenAI(api_key=key)
        for i in range(0, len(todo), BATCH):
            part = todo[i:i + BATCH]
            r = client.embeddings.create(model=MODEL, input=part)
            for t, d in zip(part, r.data):
                cache[key_of(t)] = d.embedding
            print(f"  {min(i + BATCH, len(todo))}/{len(todo)} embedded")
            # Saved after each batch: an interrupted run resumes where it stopped.
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            with open(CACHE, "w", encoding="utf-8") as f:
                json.dump(cache, f)
    v = np.array([cache[key_of(t)] for t in texts], dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def main():
    data = json.load(open(os.path.join(DATA, "questions.json"), encoding="utf-8"))
    qs = [q for q in ordered(data["questions"]) if q["verified"] in GOOD]
    ids = [q["legacyId"] for q in qs]
    context = [q["text"] + "\n" + "\n".join(q["options"]) for q in qs]
    answer = [q["options"][int(q["correctIndex"])] for q in qs]

    print(f"{len(qs)} questions, model {MODEL}")
    v = embed(context + answer)   # one pass: the key is asked once
    cv, av = v[:len(qs)], v[len(qs):]
    cs, as_ = cv @ cv.T, av @ av.T   # cosine similarity
    np.fill_diagonal(cs, -1)

    out = {}
    for i, qid in enumerate(ids):
        picks = []
        for j in np.argsort(-cs[i]):
            if cs[i, j] < CONTEXT_MIN or len(picks) == PER_QUESTION:
                break
            same = as_[i, j] >= ANSWER_MAX or answer[i].strip().lower() == answer[j].strip().lower()
            if not same:
                picks.append([ids[j], round(float(cs[i, j]), 3)])
        if picks:
            out[qid] = picks

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"model": MODEL, "context_min": CONTEXT_MIN, "answer_max": ANSWER_MAX,
                   "similar": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out)} of {len(ids)} questions have confusable neighbours -> {os.path.relpath(OUT, ROOT)}")

    # A few pairs to eyeball the thresholds.
    by_id = dict(zip(ids, qs))
    for qid in list(out)[:5]:
        q = by_id[qid]
        print(f"\n{qid}: {q['text'][:90]}\n   ✓ {answer[ids.index(qid)][:80]}")
        for oid, sim in out[qid]:
            print(f"   ~{sim} {oid}: {by_id[oid]['text'][:80]}\n          ✓ {answer[ids.index(oid)][:80]}")


if __name__ == "__main__":
    main()
