"""Explanations for the category B questions, made once with the OpenAI Batch API (half price).

Two independent passes per question, by two different models:
  blind    the check model answers without being told the right option;
  explain  the writer model gets the verified answer and writes the explanation.
An explanation is published only if the blind answer matches the official one and
the writer did not object to it; everything else goes to `python explain.py review`.

The prompt carries only the PDR clauses that matter for the question: the PDR text
(data/pdr_rules.json) is cut into chunks and embedded once with the same model and
cache as similar.py; each question gets its 8 closest chunks, with a bonus for its
own PDR section. The query is the question and its options only, so the blind pass
never sees a hint of the answer. Cited clause numbers are kept only if they exist,
and the site shows their official text, not the model's.

  python explain.py submit --limit 30                 # pilot: first 30 in deck order
  python explain.py submit --limit 30 --model gpt-5.4-mini --out data/explanations_b.json
  python explain.py status
  python explain.py collect                           # when a batch is done (up to 24 h)
  python explain.py review [--out ...]                # disagreements to check by hand

The API key is read with a hidden prompt (or from OPENAI_API_KEY) and never stored.
Batch state and request files live in work/ (git-ignored).
"""
import argparse
import base64
import datetime
import getpass
import json
import os
import re
import sys

import numpy as np
from openai import OpenAI

import similar
from deck_order import ordered

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
WORK = os.path.join(ROOT, "work")
STATE = os.path.join(WORK, "explain_batches.json")
DEFAULT_OUT = os.path.join(DATA, "explanations.json")
GOOD = ("ocr+template+brut", "template+brut", "manual")
WRITER = "gpt-5.4-mini"
CHECKER = "gpt-5.4-mini"   # gpt-5-mini misread 8 of 30 hard pictures in the test; the blind pass still never sees the answer
TOP_CHUNKS, MAX_CONTEXT = 8, 10000
WHOLE_SECTION = 6000  # a PDR section this small goes into the prompt whole (16 "Проїзд перехресть" is ~4900)
# $ per 1M tokens (input, cached input, output), standard rates; the Batch API bills half.
PRICES = {"gpt-5-nano": (0.05, 0.005, 0.40), "gpt-5-mini": (0.25, 0.025, 2.00),
          "gpt-5.4-nano": (0.20, 0.02, 1.25), "gpt-5.4-mini": (0.75, 0.075, 4.50),
          "gpt-5": (1.25, 0.125, 10.00), "gpt-5.1": (1.25, 0.125, 10.00)}

RULES = json.load(open(os.path.join(DATA, "pdr_rules.json"), encoding="utf-8"))["items"]
QDATA = json.load(open(os.path.join(DATA, "questions.json"), encoding="utf-8"))
SECTIONS = {s["id"]: s["name"] for s in QDATA["sections"]}

# Hand-written references for the format and tone. Facts checked against the PDR text.
EXAMPLES = [
    {"question": "Трамвайна колія – елемент дороги, призначений для руху рейкових транспортних засобів, "
                 "який обмежується по ширині: 1) спеціально виділеним вимощенням трамвайної лінії; "
                 "2) дорожньою розміткою; 3) відповіді, зазначені в пунктах 1 та 2. Правильна: 3.",
     "answer": {"agrees": True,
                "label": 'визначення трамвайної колії', "situation": '',
                "steps": ["Це питання на визначення з пункту 1.10.",
                          "У визначенні трамвайної колії названо обидві межі: вимощення або розмітку."],
                "explanation": "За пунктом 1.10 трамвайна колія обмежується по ширині спеціально виділеним "
                               "вимощенням трамвайної лінії або дорожньою розміткою. Підходить будь-яка з двох "
                               "меж, тому правильна відповідь та, що об'єднує обидві.",
                "wrong": [{"option": 1, "why": "це лише одна з двох меж, а розмітка теж обмежує колію."},
                          {"option": 2, "why": "так само неповно: без розмітки межею є вимощення."}],
                "trap": "Обирають перший варіант, бо вимощення видно на малюнку, і не дочитують до «1 та 2».",
                "what_if": "Якщо в питанні про межі елемента дороги є варіант «1 та 2», спершу перевірте, "
                           "чи не названо обидві межі у визначенні.",
                "rules": ["1.10"]}},
    {"question": "Яка черговість проїзду на даному перехресті? На малюнку: велосипедист їде дорогою зі "
                 "знаком 2.3 «Головна дорога», трамвай під'їжджає зі знаком 2.1 «Дати дорогу». "
                 "1) Велосипедист, трамвай; 2) Трамвай, велосипедист; 3) Залежить від швидкості. Правильна: 1.",
     "answer": {"agrees": True,
                "label": 'трамвай і велосипедист на нерівнозначному перехресті', "situation": "Велосипедист їде дорогою зі знаком «Головна дорога», трамвай під'їжджає до перехрестя зі знаком «Дати дорогу».",
                "steps": ["Світлофора й регулювальника немає, тож перехрестя нерегульоване.",
                          "Є знаки пріоритету: велосипедист на головній дорозі, трамвай на другорядній.",
                          "Той, хто на другорядній, пропускає всіх на головній (16.11)."],
                "explanation": "Черговість тут задають знаки пріоритету. Велосипедист їде головною дорогою, "
                               "трамвай під'їжджає з другорядної, тому за пунктом 16.11 трамвай пропускає "
                               "велосипедиста. Перевага трамвая з пункту 16.12 діє лише на перехресті "
                               "рівнозначних доріг, а тут дороги нерівнозначні.",
                "wrong": [{"option": 2, "why": "трамвай має перевагу лише на рівнозначних дорогах, а тут він на другорядній."},
                          {"option": 3, "why": "черговість визначають знаки й правила, а не швидкість."}],
                "trap": "Пам'ятають «трамвай завжди перший» і забувають, що знаки пріоритету важливіші.",
                "what_if": "Якби знаків не було (рівнозначні дороги), першим проїхав би трамвай.",
                "rules": ["16.11", "16.12"]}},
    {"question": "Яка частота натискань на грудну клітку при проведенні серцево-легеневої реанімації: "
                 "1) 80 в хв; 2) 100 в хв; 3) немає різниці, головне тиснути без зупинки. Правильна: 2.",
     "answer": {"agrees": True,
                "label": 'частота натискань під час серцево-легеневої реанімації', "situation": '',
                "steps": ["Питання про техніку серцево-легеневої реанімації.",
                          "Стандарт для дорослих — 100–120 натискань за хвилину, з трьох варіантів підходить лише 100."],
                "explanation": "Під час реанімації дорослого натискають на центр грудної клітки з частотою "
                               "100–120 разів на хвилину. Рідше — кров рухається недостатньо, частіше — серце "
                               "не встигає наповнитися між натисканнями.",
                "wrong": [{"option": 1, "why": "80 за хвилину замало, щоб підтримати кровообіг."},
                          {"option": 3, "why": "частота має значення: і надто рідкі, і надто часті натискання неефективні."}],
                "trap": "Обирають «головне тиснути без зупинки», бо безперервність справді важлива, але частота теж.",
                "what_if": "Орієнтир для запам'ятовування — темп пісні «Stayin' Alive», близько 100 ударів за хвилину.",
                "rules": []}},
    {"question": "Увімкнення яких світлових приладів забезпечить найкращу видимість уночі за сильної "
                 "хуртовини? 1) Протитуманні фари разом із дальнім світлом; 2) протитуманні фари разом із "
                 "ближнім світлом. Правильна: 2.",
     "answer": {"agrees": True,
                "label": 'фари в сильну хуртовину вночі', "situation": '',
                "steps": ["У хуртовину світло відбивається від сніжинок.",
                          "Дальнє світло б'є високо, відбивається назад і засліплює самого водія.",
                          "Ближнє й протитуманне світять низько, під снігову завісу."],
                "explanation": "За сильної хуртовини дальнє світло освітлює сніг у повітрі прямо перед "
                               "машиною, і водій бачить білу стіну. Протитуманні фари разом із ближнім світлом "
                               "спрямовані низько й широко, тому краще освітлюють дорогу й узбіччя.",
                "wrong": [{"option": 1, "why": "дальнє світло відбивається від снігу й погіршує видимість."}],
                "trap": "Здається, що чим яскравіше світло, тим краще видно, але в сніг і туман це не так.",
                "what_if": "У туман діє те саме правило: дальнє світло вимикають.",
                "rules": []}},
    {"question": "Яку максимальну швидкість руху встановлено в населених пунктах, позначених даним "
                 "дорожнім знаком (на малюнку білий знак з назвою міста; опис знаків 5.49 і 5.51 є в тексті ПДР)? "
                 "1) 50; 2) 60; 3) 70; 4) 80 км/год. Правильна: 1.",
     "answer": {"agrees": True,
                "label": 'знак «Початок населеного пункту» на білому фоні', "situation": 'Білий прямокутний знак із назвою міста «Одеса» — знак 5.49 «Початок населеного пункту».',
                "steps": ["Білий знак із назвою — це знак 5.49 «Початок населеного пункту».",
                          "За ним діють правила для населених пунктів, зокрема обмеження швидкості з пункту 12.4."],
                "explanation": "Знак 5.49 на білому фоні означає, що далі діють вимоги ПДР для населених пунктів. "
                               "За пунктом 12.4 у населених пунктах можна їхати не швидше 50 км/год, якщо інші "
                               "знаки не встановлюють іншого.",
                "wrong": [{"option": 2, "why": "60 км/год — старе обмеження, яке давно не діє."},
                          {"option": 3, "why": "70 км/год можна лише там, де це дозволено окремим знаком."},
                          {"option": 4, "why": "80 км/год — обмеження поза населеними пунктами для деяких ТЗ, а не в місті."}],
                "trap": "Плутають із колишнім обмеженням 60 км/год.",
                "what_if": "На синьому знаку 5.51 правила для населених пунктів не діють, і 50 км/год там не обов'язкові.",
                "rules": ["12.4"]}},
]

SYSTEM = """Ти досвідчений інструктор автошколи в Україні. Пояснюєш питання теоретичного іспиту ГСЦ МВС \
(категорія B) людині, яка готується до іспиту. Пиши українською, просто, коротко й точно.

Формат відповіді:
- label: коротка мітка до 8 слів, що відрізняє це питання від інших з таким самим текстом: що зображено або про що \
питання, словами, якими люди шукають («знак «Дати дорогу»», «трамвай і велосипедист на нерівнозначному перехресті», \
«лампа тиску масла»). Без слова «питання» і без відповіді;
- situation: 1–2 речення, що саме на малюнку (знак і його назва, хто де стоїть і куди їде, сигнали); \
якщо малюнка немає — порожній рядок;
- steps: 2–4 короткі кроки міркування, як дійти до відповіді (що перевірити першим, що далі);
- explanation: 1–2 абзаци, 50–130 слів, чому правильна відповідь правильна, з номерами пунктів ПДР;
- wrong: для кожного неправильного варіанта одне речення, чому він хибний;
- trap: одне речення, на чому найчастіше помиляються;
- what_if: одне речення, як змінилася б відповідь за інших умов, або як це запам'ятати;
- rules: номери пунктів ПДР, на які спираєшся.

Правила:
- Офіційна відповідь ГСЦ перевірена й правильна. Твоє завдання — пояснити її. agrees = false став лише тоді, \
коли наданий текст ПДР прямо їй суперечить; якщо в тексті ПДР потрібної норми просто немає, це не привід.
- Спирайся на наданий текст ПДР. Посилайся лише на пункти з наданого тексту й пиши номери точно. \
Не вигадуй номерів пунктів і знаків: номер знака пиши лише тоді, коли його опис є в наданому тексті ПДР, \
інакше називай знак словами («білий знак з назвою населеного пункту»).
- rules — лише номери пунктів ПДР (наприклад 16.11, 12.4). Знаки й розмітку згадуй у тексті як «знак 2.1», \
«розмітка 1.1», але не додавай у rules.
- Для питань поза ПДР (безпечне водіння, домедична допомога, будова авто) спирайся на загальновизнані знання; \
для питань про права й відповідальність — на КУпАП, Закон «Про Національну поліцію», КПК та інші чинні закони \
України, називаючи закон словами. Якщо пункту ПДР немає, rules порожній.
- Кроки (steps) — про саму ситуацію й логіку («Хто на головній дорозі?»), а не «прочитай пункт» чи \
«подивись на малюнок»: кожен крок має щось додавати.
- Не закінчуй пояснення фразою «Тому правильна відповідь — …»: відповідь читач уже бачить.
- Ніколи не пиши «у наданому тексті», «у наведених пунктах», «офіційна таблиця», «варіант N»: читач бачить \
лише питання й пояснення.
- Якщо є малюнок, використай у кроках те, що на ньому важливо: знаки, сигнали, хто де стоїть і куди їде.
- Без markdown. Не повторюй текст питання.

Приклади (питання і відповідь у потрібному форматі):
""" + "\n\n".join(f"Питання: {e['question']}\nВідповідь: {json.dumps(e['answer'], ensure_ascii=False)}"
                 for e in EXAMPLES)

BLIND_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "integer"}, "rules": {"type": "array", "items": {"type": "string"}}},
    "required": ["answer", "rules"], "additionalProperties": False,
}
EXPLAIN_SCHEMA = {
    "type": "object",
    "properties": {
        "agrees": {"type": "boolean"},
        "label": {"type": "string"},
        "situation": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "string"}},
        "explanation": {"type": "string"},
        "wrong": {"type": "array", "items": {
            "type": "object", "properties": {"option": {"type": "integer"}, "why": {"type": "string"}},
            "required": ["option", "why"], "additionalProperties": False}},
        "trap": {"type": "string"},
        "what_if": {"type": "string"},
        "rules": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["agrees", "label", "situation", "steps", "explanation", "wrong", "trap", "what_if", "rules"],
    "additionalProperties": False,
}


# ---------- retrieval ----------
def terms():
    """Clause 1.10 split into its terms: [(name, full text)]; "- ..." lines belong to the term above."""
    out = []
    for p in [p.strip() for p in RULES["1.10"].split("\n\n")[1:] if p.strip()]:
        if " — " in p[:90] and not p.startswith("-"):
            out.append([p.split(" — ", 1)[0], p])
        elif out:
            out[-1][1] += "\n" + p
    return [tuple(t) for t in out]


TERMS = terms()


def term_pattern(name):
    # Word stems, so "дати дорогу" also matches "дав дорогу", "перехрестя" matches "перехрестях".
    words = re.findall(r"\w+", name.lower())
    return re.compile(r"\b" + r"\W+".join(w[:max(4, len(w) - 2)] + r"\w*" if len(w) > 4 else w
                                          for w in words) + r"\b")


TERM_RE = [(name, text, term_pattern(name)) for name, text in TERMS]


def chunks():
    """PDR text cut at paragraph breaks into pieces up to ~900 characters, each tagged with its clause.
    The terms of 1.10 are one chunk each: in bigger pieces a single definition gets lost."""
    out = [("1.10", text) for _, text in TERMS]
    for k, text in RULES.items():
        if k == "1.10":
            continue
        cur = ""
        for p in [p.strip() for p in text.split("\n\n") if p.strip()]:
            if cur and len(cur) + len(p) > 900:
                out.append((k, cur))
                cur = ""
            cur = f"{cur}\n\n{p}" if cur else p
        if cur:
            out.append((k, cur))
    return out


def query_text(q):
    # Same text as similar.py's "context", so these embeddings are already in the cache.
    return q["text"] + "\n" + "\n".join(q["options"])


class Retriever:
    def __init__(self, qs):
        self.chunks = chunks()
        vecs = similar.embed([f"Пункт {k} ПДР. {t}" for k, t in self.chunks] + [query_text(q) for q in qs])
        self.cv, qv = vecs[:len(self.chunks)], vecs[len(self.chunks):]
        self.qv = {q["legacyId"]: v for q, v in zip(qs, qv)}

    def context(self, q):
        score = self.cv @ self.qv[q["legacyId"]]
        major = q["section"].split(".")[0]
        if int(major) <= 34:  # exam sections 1-34 follow the PDR sections
            score = score + np.array([0.05 if k.split(".")[0] == major else 0 for k, _ in self.chunks])
        # Always in: the whole PDR section when it is small (the picture often decides which of its
        # clauses applies, and the text of the question does not say), and for intersections and
        # traffic controllers the priority signs and plate 7.8 "Напрямок головної дороги".
        own = [i for i, (k, _) in enumerate(self.chunks) if k.split(".")[0] == major and k != "1.10"]
        first = own if int(major) <= 34 and sum(len(self.chunks[i][1]) for i in own) <= WHOLE_SECTION else []
        if q["section"] == "8.1":  # traffic controller: the clause with his signals, whatever the vectors say
            first += [i for i, (k, _) in enumerate(self.chunks) if k == "8.8" or k.startswith("8.8.")]
        if q["section"].split(".")[0] in ("8", "16"):
            first += [i for i, (k, t) in enumerate(self.chunks)
                      if k == "33.2" or (k == "33.7" and "7.8 «Напрямок головної дороги»" in t)]
        # Terms named in the question itself, whatever the vectors say.
        hay = query_text(q).lower()
        named = {text for _, text, rx in TERM_RE if rx.search(hay)}
        first += sorted((i for i, (k, t) in enumerate(self.chunks) if k == "1.10" and t in named),
                        key=lambda i: -score[i])[:3]
        first = list(dict.fromkeys(first))
        picked, size = list(first), sum(len(self.chunks[i][1]) for i in first)
        for i in np.argsort(-score):
            if len(picked) >= len(first) + TOP_CHUNKS:
                break
            if i in first:
                continue
            k, t = self.chunks[i]
            if size + len(t) > MAX_CONTEXT:
                continue
            picked.append(i)
            size += len(t)
        picked.sort(key=lambda i: [int(x) if x.isdigit() else 0 for x in self.chunks[i][0].split(".")])
        return "\n\n".join(f"{self.chunks[i][0]}. {self.chunks[i][1]}" for i in picked)


# ---------- requests ----------
def user_content(q, ctx, verified):
    opts = "\n".join(f"{i + 1}. {o}" for i, o in enumerate(q["options"]))
    text = (f"Розділ {q['section']}. {SECTIONS[q['section']].capitalize()}\n\n"
            f"Текст ПДР, що може стосуватися питання:\n{ctx}\n\n"
            f"Питання: {q['text']}\n\nВаріанти:\n{opts}\n")
    if verified:
        a = q["correctIndex"]
        text += (f"\nПравильна відповідь за офіційною таблицею ГСЦ: {a + 1}. {q['options'][a]}\n"
                 "Якщо вважаєш, що за ПДР правильна інша відповідь, постав agrees = false і поясни чому.")
    else:
        text += "\nОбери номер правильного варіанта (answer) і вкажи пункти ПДР, на які спираєшся."
    content = [{"type": "text", "text": text}]
    for rel in q.get("images") or []:
        ext = rel.rsplit(".", 1)[-1].lower()
        with open(os.path.join(DATA, rel), "rb") as f:
            b64 = base64.standard_b64encode(f.read()).decode()
        content.append({"type": "image_url", "image_url": {
            "url": f"data:image/{'png' if ext == 'png' else 'jpeg'};base64,{b64}",
            "detail": "high"}})  # small plates under signs and car colours need full resolution
    return content


def line(q, ctx, kind, model):
    schema = EXPLAIN_SCHEMA if kind == "explain" else BLIND_SCHEMA
    body = {
        "model": model,
        # The system prompt is the same for every request, so it is served from the prompt cache.
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": user_content(q, ctx, kind == "explain")}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": kind, "strict": True, "schema": schema}},
        "max_completion_tokens": 16000,  # reasoning on busy intersections can take ~8000 alone
    }
    if model.startswith(("gpt-5", "o")):
        body["reasoning_effort"] = "medium"
    return {"custom_id": f"{kind}__{q['legacyId']}", "method": "POST",
            "url": "/v1/chat/completions", "body": body}


# ---------- plumbing ----------
def client():
    key = os.environ.get("OPENAI_API_KEY") or getpass.getpass("OpenAI API key (не відображається): ").strip()
    if not key:
        sys.exit("Ключ не введено.")
    return OpenAI(api_key=key)


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return default
    return json.loads(text) if text.strip() else default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


def category_b():
    return [q for q in ordered(QDATA["questions"]) if q["verified"] in GOOD]


def cmd_submit(a):
    allq = category_b()
    out_path = os.path.abspath(a.out)
    done = load(out_path, {})
    qs = allq
    if a.ids:
        want = set(a.ids.split(","))
        qs = [q for q in qs if q["legacyId"] in want]
    if a.sections:
        qs = [q for q in qs if q["section"] in set(a.sections.split(","))]
    if a.skip_sections:
        qs = [q for q in qs if q["section"] not in set(a.skip_sections.split(","))]
    elif not a.redo:
        qs = [q for q in qs if q["legacyId"] not in done]
    if a.limit:
        qs = qs[:a.limit]  # deck order: questions most likely to be in the ticket come first
    if not qs:
        sys.exit("nothing to submit")
    ret = Retriever(allq)
    ctx = {q["legacyId"]: ret.context(q) for q in qs}
    # Clauses the model actually saw: cited clauses outside this set are dropped at collect time
    # (e.g. "знак 2.1" taken for clause 2.1 about the driver's documents).
    seen = {qid: sorted({k for k in re.findall(r"^(\d+(?:\.\d+)+)\. ", c, re.M) if k in RULES})
            for qid, c in ctx.items()}
    os.makedirs(WORK, exist_ok=True)
    n0 = len(load(STATE, {"batches": []})["batches"])
    # OpenAI wants one model per batch, so each pass is its own batch.
    files = {}
    for kind, model in (("blind", a.check_model), ("explain", a.model)):
        path = os.path.join(WORK, f"explain_requests_{n0}_{kind}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(line(q, ctx[q["legacyId"]], kind, model), ensure_ascii=False) + "\n"
                         for q in qs)
        files[kind] = (path, model)
        print(f"{kind}: {len(qs)} requests to {model}, {os.path.getsize(path) / 1e6:.1f} MB -> {path}")
    if a.dry_run:
        return
    c = client()
    jobs = {}
    for kind, (path, model) in files.items():
        up = c.files.create(file=open(path, "rb"), purpose="batch")
        b = c.batches.create(input_file_id=up.id, endpoint="/v1/chat/completions", completion_window="24h")
        jobs[kind] = {"id": b.id, "model": model}
        print(f"submitted {kind}: {b.id}")
    st = load(STATE, {"batches": []})
    st["batches"].append({"jobs": jobs, "out": os.path.relpath(out_path, ROOT), "n": len(qs),
                          "seen": seen, "collected": False})
    save(STATE, st)


def pending(st):
    # Entries in the old one-batch format (before the split) are skipped.
    return [b for b in st["batches"] if "jobs" in b and not b["collected"]]


def cmd_status(a):
    c = client()
    for b in load(STATE, {"batches": []})["batches"]:
        if "jobs" not in b:
            continue
        for kind, j in b["jobs"].items():
            r = c.batches.retrieve(j["id"])
            n = r.request_counts
            print(f"{kind:7} {j['id']} {r.status} done={n.completed}/{n.total} failed={n.failed} "
                  f"model={j['model']} collected={b['collected']}")
            for e in (r.errors.data if r.errors else [])[:3]:
                print(f"         error: {e.code} line {e.line}: {e.message}")


# Phrases that only make sense to the model, not to a reader of the page. "Варіант 1" is fine:
# the page numbers the options in the same order. "Із наведених варіантів" is plain language too.
META = re.compile(r"наданому тексті|наданого тексту|наведених пунктах|наведеному тексті|"
                  r"офіційн\w* (таблиц|відповід)|таблиц\w* ГСЦ|\bГСЦ\b", re.I)


def lint(v):
    """Reasons an explanation must not be published as is."""
    text = " ".join([v["text"], v["trap"], v["what_if"]] + v["steps"] + list(v["wrong"].values()))
    reasons = sorted({m.group(0).lower() for m in META.finditer(text)})
    return [f"службова фраза: {r}" for r in reasons]


def cost(usage, model):
    p = PRICES.get(model)
    if not p or not usage:
        return 0.0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    fresh = usage["prompt_tokens"] - cached
    return (fresh * p[0] + cached * p[1] + usage["completion_tokens"] * p[2]) / 1e6 / 2  # batch: half price


def cmd_collect(a):
    c = client()
    st = load(STATE, {"batches": []})
    byid = {q["legacyId"]: q for q in QDATA["questions"]}
    for b in pending(st):
        runs = {kind: c.batches.retrieve(j["id"]) for kind, j in b["jobs"].items()}
        waiting = [f"{k}: {r.status}" for k, r in runs.items()
                   if r.status in ("validating", "in_progress", "finalizing", "cancelling")]
        if waiting:
            print("not finished yet — " + ", ".join(waiting))
            continue
        got, spent = {}, 0.0
        for kind, r in runs.items():
            model = b["jobs"][kind]["model"]
            if not r.output_file_id:  # failed / cancelled before anything ran
                print(f"{kind}: {r.status}, no results")
                continue
            for raw in c.files.content(r.output_file_id).text.splitlines():
                row = json.loads(raw)
                qid = row["custom_id"].split("__", 1)[1]
                body = (row.get("response") or {}).get("body") or {}
                spent += cost(body.get("usage"), model)
                choice = (body.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                if row.get("error") or choice.get("finish_reason") != "stop" or not msg.get("content"):
                    print(f"{row['custom_id']}: failed ({choice.get('finish_reason')}) — resubmit with --ids {qid}")
                    continue
                got.setdefault(qid, {})[kind] = json.loads(msg["content"])
            if r.error_file_id:
                print(f"{kind}: some requests errored: {c.files.content(r.error_file_id).text[:300]}")
        out_path = os.path.join(ROOT, b["out"])
        out = load(out_path, {})
        for qid, g in got.items():
            if "blind" not in g or "explain" not in g:
                continue
            q, e = byid[qid], g["explain"]
            n, right = len(q["options"]), q["correctIndex"] + 1
            blind_ok = g["blind"]["answer"] == right
            out[qid] = {
                "label": e["label"].strip(),
                "situation": e["situation"].strip(),
                "steps": [s.strip() for s in e["steps"] if s.strip()],
                "text": e["explanation"].strip(),
                "wrong": {str(w["option"]): w["why"].strip() for w in e["wrong"]
                          if 1 <= w["option"] <= n and w["option"] != right},
                "trap": e["trap"].strip(),
                "what_if": e["what_if"].strip(),
                "rules": [k for k in dict.fromkeys(e["rules"])
                          if k in RULES and k in b.get("seen", {}).get(qid, RULES)],
                "model": b["jobs"]["explain"]["model"], "check_model": b["jobs"]["blind"]["model"],
                "blind": g["blind"]["answer"],
                "at": datetime.date.today().isoformat(),  # shown as "оновлено" and used as sitemap lastmod
            }
            out[qid]["flags"] = ([] if blind_ok else [f"сліпа відповідь {g['blind']['answer']}"]) + \
                ([] if e["agrees"] else ["модель не погодилась"]) + lint(out[qid])
            # published only when both passes agree with the official answer and the text is clean
            out[qid]["status"] = "review" if out[qid]["flags"] else "ok"
        save(out_path, out)
        b["collected"] = True
        b["cost_usd"] = round(spent, 4)
        save(STATE, st)
        both = [qid for qid, g in got.items() if len(g) == 2]
        ok = sum(1 for qid in both if out[qid]["status"] == "ok")
        print(f"{len(both)} questions, {ok} publishable, {len(both) - ok} to review, ${spent:.3f} -> {b['out']}")


def cmd_recheck(a):
    """Re-apply lint() to an existing results file (after the rules change); no API calls."""
    path = os.path.abspath(a.out)
    out = load(path, {})
    for v in out.values():
        keep = [f for f in v.get("flags", []) if not f.startswith("службова фраза")]
        if "flags" not in v and v["status"] != "ok":
            keep = ["перевірка до появи flags"]
        v["flags"] = keep + lint(v)
        v["status"] = "review" if v["flags"] else "ok"
    save(path, out)
    ok = sum(1 for v in out.values() if v["status"] == "ok")
    print(f"{ok} publishable, {len(out) - ok} to review -> {a.out}")


def cmd_review(a):
    byid = {q["legacyId"]: q for q in QDATA["questions"]}
    for qid, v in sorted(load(os.path.abspath(a.out), {}).items()):
        if v["status"] == "ok":
            continue
        q = byid[qid]
        print(f"\n{qid}: {q['text']}\n  official: {q['correctIndex'] + 1}, blind: {v['blind']}, "
              f"flags: {'; '.join(v.get('flags', []))}\n  {v['text'][:300]}")
    print(f"\nAfter checking, set \"status\": \"ok\" (or fix the text) in {a.out}.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("submit")
    s.add_argument("--limit", type=int)
    s.add_argument("--ids")
    s.add_argument("--sections", help="only these exam sections, e.g. 8.1,8.2,16.1,16.2")
    s.add_argument("--skip-sections", help="all but these sections")
    s.add_argument("--redo", action="store_true", help="include questions that already have one")
    s.add_argument("--model", default=WRITER)
    s.add_argument("--check-model", default=CHECKER)
    s.add_argument("--out", default=DEFAULT_OUT)
    s.add_argument("--dry-run", action="store_true", help="write the request file, send nothing")
    sub.add_parser("status")
    sub.add_parser("collect")
    r = sub.add_parser("review")
    r.add_argument("--out", default=DEFAULT_OUT)
    r = sub.add_parser("recheck")
    r.add_argument("--out", default=DEFAULT_OUT)
    a = p.parse_args()
    {"submit": cmd_submit, "status": cmd_status, "collect": cmd_collect, "review": cmd_review,
     "recheck": cmd_recheck}[a.cmd](a)
