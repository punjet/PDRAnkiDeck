"""Search data made once with OpenAI, for the app's offline search:

  data/keywords.json  for every question, 6–10 phrases people would type to find it,
                      in Ukrainian AND Russian ("детское кресло", "тормозной путь"):
                      word search then finds questions across languages and synonyms;
  data/topics.json    ~40 human topics ("Обгін", "Кровотечі", "Знаки пріоритету"),
                      each with synonyms, for browsing and "Тренування за темою".

Run locally, after similar.py (topics reuse its embeddings cached in work/):
  python topics.py                      # asks for the OpenAI API key once
  python topics.py --only keywords      # or --only topics
The key is read with a hidden prompt (or OPENAI_API_KEY) and never stored.
Every answer is cached in work/, so a stopped run resumes and a re-run is free.
Defaults: gpt-5.4-mini for topics, gpt-5-mini for keywords, about $1.5 in all.
Both files are committed; the site build needs nothing else.

Topics:
  1. k-means on the question embeddings -> ~70 clusters;
  2. the LLM names each cluster (short name, one line, synonyms);
  3. one more LLM call merges clusters that are the same topic for a learner;
  4. the group (Дорожні знаки, Домедична допомога, ...) is not the LLM's guess: it is
     the group of the PDR sections most of the topic's questions come from.
"""
import argparse
import collections
import getpass
import hashlib
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from openai import BadRequestError, OpenAI
from sklearn.cluster import KMeans

from deck_order import ordered
from similar import CACHE as EMB_CACHE, GOOD, key_of

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
WORK = os.path.join(ROOT, "work")
OUT_TOPICS = os.path.join(DATA, "topics.json")
OUT_KW = os.path.join(DATA, "keywords.json")

# Group of each PDR section (category B: 1–39, 44–47). Order = order on screen.
GROUPS = {
    "Дорожні знаки": ["33", "30"],
    "Розмітка": ["34"],
    "Світлофори й регулювальник": ["8.1", "8.2"],
    "Перехрестя і черговість проїзду": ["16.1", "16.2", "17", "3"],
    "Маневри: обгін, повороти, розворот": ["10", "11", "14"],
    "Швидкість, дистанція, зупинка і стоянка": ["12", "13", "15"],
    "Сигнали і світлові прилади": ["9", "19"],
    "Пішоходи, велосипедисти, пасажири, вантажі": ["4", "5", "6", "7", "18", "21", "22"],
    "Особливі умови: переїзди, магістралі, буксирування": ["20", "23", "24", "25", "26", "27", "28", "29"],
    "Будова і технічний стан авто": ["31", "45"],
    "Безпечне водіння": ["35", "38", "47"],
    "Домедична допомога": ["37"],
    "Права, обов'язки, відповідальність": ["1", "2", "32", "36", "39", "44", "46"],
}
GROUP_OF = {s: g for g, ss in GROUPS.items() for s in ss}

# Two separate lists, both required: asked for "both languages" in one list, models
# mostly forget Russian. No sample phrases in the prompt: a model copies them into
# every answer (a first run put "детское кресло" on 1268 questions).
KW_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["items"],
    "properties": {"items": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["id", "uk", "ru"],
        "properties": {"id": {"type": "string"},
                       "uk": {"type": "array", "items": {"type": "string"}},
                       "ru": {"type": "array", "items": {"type": "string"}}}}}},
}
KW_PROMPT = """Тренажер до іспиту з ПДР України. Для кожного питання нижче напиши пошукові фрази
(1–3 слова), за якими учень знайде саме це питання:
- uk: 4–6 фраз українською — ключові поняття питання й правильної відповіді, синоніми,
  розмовні назви, які вживають водії;
- ru: 4–6 фраз російською (кирилицею) — як шукав би російськомовний учень: переклад тих самих
  понять і термінів ПДР та російські розмовні назви.
Правила:
- тільки те, що стосується саме цього питання; нічого не вигадуй і не повторюй між питаннями;
- без загальних слів (питання, ПДР, водій, дозволено, заборонено як окреме слово);
- без номерів варіантів і знаків («відповіді 1 і 2», «знак 3»);
- нижній регістр.
Поверни items з тим самим id для кожного питання.

{items}"""
JUNK = re.compile(r"(відповід|варіант|ответ)\S*\s*\d|^знак\S*\s*\d|^\d+$")
MAX_SHARED = 40   # a phrase on more questions than this says nothing about any of them

NAME_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["name", "desc", "syn"],
    "properties": {
        "name": {"type": "string"}, "desc": {"type": "string"},
        "syn": {"type": "array", "items": {"type": "string"}},
    },
}
NAME_PROMPT = """Тренажер до іспиту з ПДР України. Нижче — група схожих екзаменаційних питань з відповідями.
Дай:
- name: назву теми, 1–4 слова, як заголовок у підручнику («Обгін», «Зупинка і стоянка», «Кровотечі»,
  «Знаки пріоритету», «Залізничні переїзди»). Без слів «правила», «питання», «ПДР».
- desc: одне коротке речення, про що ці питання.
- syn: 8–12 пошукових слів/фраз у нижньому регістрі — і українські, і російські (кирилицею), розмовні.

Питання:
{items}"""

MERGE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["topics"],
    "properties": {"topics": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["name", "desc", "clusters"],
        "properties": {"name": {"type": "string"}, "desc": {"type": "string"},
                       "clusters": {"type": "array", "items": {"type": "string"}}}}}},
}
MERGE_PROMPT = """Тренажер до іспиту з ПДР України. Нижче — {n} груп питань (кластерів) з назвами.
Багато з них — та сама тема для учня (наприклад, кілька кластерів про зупинку і стоянку).
Об'єднай їх приблизно у {target} тем, щоб учень легко знайшов потрібну:
- об'єднуй лише кластери про одне й те саме; різне за змістом не зливай;
- у темі не більше ~70 питань (кількість указана біля кластера), тож великі теми не роби;
- кожен кластер — рівно в одній темі (поверни їхні id);
- назва теми 1–4 слова і описує ВСІ її кластери; різні теми — різні назви; без «правила», «питання», «ПДР»;
- desc — одне коротке речення.

Кластери:
{items}"""


PARALLEL = 8   # requests at a time: reasoning models take several seconds each


def get_client():
    key = os.environ.get("OPENAI_API_KEY") or getpass.getpass("OpenAI API key (не відображається): ").strip()
    if not key:
        sys.exit("Ключ не введено.")
    os.environ["OPENAI_API_KEY"] = key   # this process only: asked once for both steps
    return OpenAI(api_key=key, max_retries=5)


POLISH_PROMPT = """Тренажер до іспиту з ПДР України. Нижче — {n} тем з кількістю питань і прикладами.
Деякі назви майже однакові або незрозумілі. Для КОЖНОЇ теми (за id) дай:
- name: назву 1–4 слова, яка відрізняє цю тему від усіх інших (якщо дві теми про зупинку —
  назви, чим вони різняться); без «правила», «питання», «ПДР»; усі назви різні;
- group: одну групу зі списку, куди учень шукав би цю тему;
- desc: одне коротке речення, про що питання теми.
Теми не об'єднуй і не розділяй.

Групи: {groups}

Теми:
{items}"""


def polish_schema(groups):
    return {
        "type": "object", "additionalProperties": False, "required": ["topics"],
        "properties": {"topics": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["id", "name", "group", "desc"],
            "properties": {"id": {"type": "string"}, "name": {"type": "string"},
                           "group": {"type": "string", "enum": groups}, "desc": {"type": "string"}}}}},
    }


class LLM:
    def __init__(self, cache_name):
        self.path = os.path.join(WORK, cache_name)
        self.cache = json.load(open(self.path, encoding="utf-8")) if os.path.exists(self.path) else {}
        self.client = None
        self.lock = threading.Lock()

    def ask(self, model, prompt, schema, name):
        k = hashlib.sha1(f"{model}\n{prompt}".encode()).hexdigest()
        with self.lock:
            if k in self.cache:
                return self.cache[k]
            if self.client is None:
                self.client = get_client()
        # GPT-4.x takes a temperature; GPT-5 / o-series reason first and take reasoning_effort instead.
        reasoning = model.startswith(("gpt-5", "o1", "o3", "o4"))
        extra = {"reasoning_effort": "low"} if reasoning else {"temperature": 0.2}
        req = dict(model=model, messages=[{"role": "user", "content": prompt}],
                   response_format={"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}})
        try:
            r = self.client.chat.completions.create(**req, **extra)
        except BadRequestError as e:   # a model that does not know that parameter: ask without it
            if not any(p in str(e) for p in extra):
                raise
            r = self.client.chat.completions.create(**req)
        result = json.loads(r.choices[0].message.content)
        with self.lock:
            self.cache[k] = result
            os.makedirs(WORK, exist_ok=True)
            with open(self.path, "w", encoding="utf-8") as f:   # saved after each call: a stopped run resumes
                json.dump(self.cache, f, ensure_ascii=False)
        return result

    def ask_many(self, model, jobs, schema, name, label):
        """jobs: list of prompts; answers in the same order, PARALLEL at a time."""
        if any(hashlib.sha1(f"{model}\n{p}".encode()).hexdigest() not in self.cache for p in jobs) and self.client is None:
            self.client = get_client()   # asked here, before the threads start
        done = [0]

        def one(p):
            r = self.ask(model, p, schema, name)
            with self.lock:
                done[0] += 1
                print(f"  {label} {done[0]}/{len(jobs)}", flush=True)
            return r
        with ThreadPoolExecutor(PARALLEL) as pool:
            return list(pool.map(one, jobs))


def clean_list(xs, limit, drop=()):
    out = []
    for x in xs:
        x = " ".join(x.strip().lower().split())
        if x and x not in out and x not in drop:
            out.append(x)
    return out[:limit]


def keywords(qs, model):
    llm = LLM("keywords_cache.json")
    parts = [qs[i:i + 25] for i in range(0, len(qs), 25)]
    prompts = [KW_PROMPT.format(items="\n".join(
        f"id={q['legacyId']} | {q['text'][:240]}{' [з малюнком]' if q.get('images') else ''} | "
        f"відповідь: {q['options'][int(q['correctIndex'])][:160]}" for q in part)) for part in parts]
    out = {}
    for part, r in zip(parts, llm.ask_many(model, prompts, KW_SCHEMA, "keywords", "keywords")):
        got = {it["id"]: it["uk"] + it["ru"] for it in r["items"]}
        for q in part:
            out[q["legacyId"]] = [k for k in clean_list(got.get(q["legacyId"], []), 14) if not JUNK.search(k)]
    shared = collections.Counter(k for v in out.values() for k in v)
    out = {i: [k for k in v if shared[k] <= MAX_SHARED] for i, v in out.items()}
    print(f"  dropped {sum(1 for n in shared.values() if n > MAX_SHARED)} phrases shared by >{MAX_SHARED} questions")
    missing = [k for k, v in out.items() if not v]
    with open(OUT_KW, "w", encoding="utf-8") as f:
        json.dump({"model": model, "kw": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"keywords for {len(out) - len(missing)} of {len(out)} questions -> {os.path.relpath(OUT_KW, ROOT)}")


def topics(qs, model, k, target):
    if not os.path.exists(EMB_CACHE):
        sys.exit("Немає work/embeddings.json — спершу запустіть python similar.py")
    cache = json.load(open(EMB_CACHE, encoding="utf-8"))
    texts = [q["text"] + "\n" + "\n".join(q["options"]) for q in qs]
    if any(key_of(t) not in cache for t in texts):
        sys.exit("Не всі питання мають вектори — запустіть python similar.py")
    v = np.array([cache[key_of(t)] for t in texts], dtype=np.float32)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    del cache

    km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(v)
    clusters = []
    for c in range(k):
        m = np.where(km.labels_ == c)[0]
        centre = km.cluster_centers_[c] / np.linalg.norm(km.cluster_centers_[c])
        clusters.append([int(i) for i in m[np.argsort(-(v[m] @ centre))]])   # most typical first

    llm = LLM("topics_cache.json")
    prompts = [NAME_PROMPT.format(items="\n".join(
        f"- {qs[i]['text'][:220]}{' [з малюнком]' if qs[i].get('images') else ''}\n"
        f"  Відповідь: {qs[i]['options'][int(qs[i]['correctIndex'])][:160]}" for i in m[:30])) for m in clusters]
    named = llm.ask_many(model, prompts, NAME_SCHEMA, "topic", "topic names")
    print("  merging clusters into topics…", flush=True)

    lines = "\n".join(
        f"c{n}: {t['name']} ({len(m)} питань) — {t['desc']} Приклади: "
        + "; ".join(qs[i]["text"][:90] for i in m[:3])
        for n, (t, m) in enumerate(zip(named, clusters)))
    merged = llm.ask(model, MERGE_PROMPT.format(n=k, target=target, items=lines), MERGE_SCHEMA, "merge")["topics"]

    used, result = set(), []
    for t in merged:
        cs = [int(c.lstrip("c")) for c in t["clusters"] if c.lstrip("c").isdigit()]
        cs = [c for c in cs if 0 <= c < k and c not in used]
        if cs:
            used.update(cs)
            result.append({"name": t["name"].strip(), "desc": t["desc"].strip(), "clusters": cs})
    # A merge that came out too big is undone: its clusters become topics of their own.
    TOO_BIG = 120
    split = []
    for t in result:
        if len(t["clusters"]) > 1 and sum(len(clusters[c]) for c in t["clusters"]) > TOO_BIG:
            split += [{"name": named[c]["name"].strip(), "desc": named[c]["desc"].strip(), "clusters": [c]} for c in t["clusters"]]
        else:
            split.append(t)
    result = split
    for c in range(k):   # a cluster the merge left out keeps its own topic
        if c not in used:
            result.append({"name": named[c]["name"].strip(), "desc": named[c]["desc"].strip(), "clusters": [c]})

    out = []
    for t in result:
        members = [i for c in t["clusters"] for i in clusters[c]]
        votes = collections.Counter(GROUP_OF.get(qs[i]["section"], "Права, обов'язки, відповідальність") for i in members)
        syn = clean_list([s for c in t["clusters"] for s in named[c]["syn"]] + [named[c]["name"] for c in t["clusters"]],
                         25, drop={t["name"].lower()})
        out.append({"name": t["name"], "group": votes.most_common(1)[0][0], "desc": t["desc"], "syn": syn,
                    "q": [qs[i]["legacyId"] for i in members]})
    order = list(GROUPS)
    # Final pass: distinct names and a group a learner would look in. The section-based
    # group stays wherever the answer is missing, outside the list, or a name repeats.
    by_q = {q["legacyId"]: q for q in qs}
    lines = "\n".join(
        f"id=p{n}: «{t['name']}» ({len(t['q'])} питань) — {t['desc']} Приклади: "
        + "; ".join(by_q[i]["text"][:90] for i in t["q"][:4]) for n, t in enumerate(out))
    pol = llm.ask(model, POLISH_PROMPT.format(n=len(out), groups="; ".join(order), items=lines),
                  polish_schema(order), "polish")["topics"]
    fix = {x["id"]: x for x in pol}
    taken = collections.Counter(x["name"].strip().lower() for x in pol)
    for n, t in enumerate(out):
        x = fix.get(f"p{n}")
        if not x:
            continue
        if x["group"] in GROUPS:
            t["group"] = x["group"]
        if x["name"].strip() and taken[x["name"].strip().lower()] == 1:
            old = t["name"]
            t["name"], t["desc"] = x["name"].strip(), x["desc"].strip() or t["desc"]
            if old.lower() != t["name"].lower() and old.lower() not in t["syn"]:
                t["syn"] = [old.lower()] + t["syn"]   # the old name still finds the topic
    for t in out:   # "Питання про те, кому…" on every topic says nothing: start with the substance
        d = re.sub(r"^Питання\s+(про те,?\s*|про|щодо)\s*", "", t["desc"]).strip()
        t["desc"] = d[:1].upper() + d[1:] if d else t["desc"]
    out.sort(key=lambda t: (order.index(t["group"]), -len(t["q"])))
    for n, t in enumerate(out, 1):
        t["id"] = f"t{n:02d}"
    with open(OUT_TOPICS, "w", encoding="utf-8") as f:
        json.dump({"model": model, "k": k, "groups": order,
                   "topics": [{"id": t["id"], **{x: t[x] for x in ("name", "group", "desc", "syn", "q")}} for t in out]},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"\n{len(out)} topics -> {os.path.relpath(OUT_TOPICS, ROOT)}")
    for g in order:
        ts = [t for t in out if t["group"] == g]
        if ts:
            print(f"\n{g}:")
            for t in ts:
                print(f"  {t['name']} ({len(t['q'])}) — {', '.join(t['syn'][:6])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["keywords", "topics"])
    ap.add_argument("--model", default="gpt-5.4-mini", help="for topic names and merging")
    ap.add_argument("--kw-model", default="gpt-5-mini", help="for per-question keywords (many calls)")
    ap.add_argument("--k", type=int, default=70, help="clusters before merging")
    ap.add_argument("--target", type=int, default=40, help="topics after merging, roughly")
    args = ap.parse_args()

    data = json.load(open(os.path.join(DATA, "questions.json"), encoding="utf-8"))
    qs = [q for q in ordered(data["questions"]) if q["verified"] in GOOD]
    print(f"{len(qs)} questions")
    if args.only != "topics":
        keywords(qs, args.kw_model)
    if args.only != "keywords":
        topics(qs, args.model, args.k, args.target)


if __name__ == "__main__":
    main()
