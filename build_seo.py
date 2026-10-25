"""Static, crawlable pages for search engines, written next to the web app.

The app itself renders everything with JavaScript from questions.json, so a
crawler sees an empty page. This adds plain HTML that needs no JS:
  q/<id>/        one page per question: picture, options, answer, explanation,
                 cited PDR clauses, chance to get it in the exam ticket
  r/<section>/   one page per exam section with links to its questions
  pdr/<section>/ official PDR text, each clause with the exam questions that cite it
  tema/<slug>/   one page per topic of data/topics.json
  ispyt/, pro/   mock exam landing (opens the app's exam) and about / how answers are checked
  404.html, sitemap.xml (with lastmod where known), robots.txt, CNAME,
  and the year / section list / JSON-LD in index.html

A question page is indexable only once it has a checked explanation
(data/explanations.json, status "ok", made by explain.py). Until then it is
noindex and left out of the sitemap: bare question + answer pages exist on many
sites already, and a batch of them on a new domain reads as scaled thin content.

SITE_URL (env) is the public address with a trailing slash. With an own domain
the build also writes CNAME for GitHub Pages.
"""
import datetime
import html
import json
import os
import re
from urllib.parse import urlparse

SITE = os.environ.get("SITE_URL", "https://zdaipdr.com.ua/")
YEAR = str(datetime.date.today().year)
APP_NAME = "ПДР України — категорія B"
ROOT = os.path.dirname(os.path.abspath(__file__))


def esc(s):
    return html.escape(str(s), quote=True)


def clip(s, n):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n - 1].rsplit(" ", 1)[0] + "…"


def paras(text):
    return "".join(f"<p>{esc(p.strip())}</p>" for p in re.split(r"\n\s*\n", text) if p.strip())


def ld(obj):
    # "</" inside JSON would close the <script> tag early.
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def rule_key(k):
    return [int(x) if x.isdigit() else 0 for x in k.split(".")]


def load_json(name, default):
    try:
        with open(os.path.join(ROOT, "data", name), encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return default
    return json.loads(text) if text.strip() else default


LAZY = ' loading="lazy"'

# Reveals the answer after the reader picks an option; without JS everything is visible.
QUIZ_JS = """<script>
document.documentElement.classList.add("js");
addEventListener("click", function (e) {
  var b = e.target.closest("[data-opt],[data-show]"), quiz = b && b.closest(".quiz");
  if (!quiz || quiz.classList.contains("done")) return;
  quiz.classList.add("done");
  if (b.dataset.opt !== undefined && b.dataset.opt !== quiz.dataset.a) b.classList.add("wrong");
  quiz.dataset.res = b.dataset.opt === undefined ? "shown" : b.dataset.opt === quiz.dataset.a ? "right" : "wrong";
});
</script>
"""


def page(*, path, title, description, body, depth, jsonld=(), og_type="article", index=True, quiz=False,
         og_image=None):
    up = "../" * depth
    url = SITE + path
    scripts = "".join(f'<script type="application/ld+json">{ld(o)}</script>\n' for o in jsonld)
    robots = "" if index else '<meta name="robots" content="noindex, follow">\n'
    return f"""<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
{robots}<link rel="canonical" href="{esc(url)}">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="{esc(APP_NAME)}">
<meta property="og:locale" content="uk_UA">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(url)}">
<meta property="og:image" content="{esc(og_image or SITE + 'og.png')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1d4ed8">
<link rel="icon" href="{up}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{up}style.css">
{QUIZ_JS if quiz else ""}{scripts}</head>
<body>
<div id="app" class="static">
{body}
<footer class="stack">
  <p>База ГСЦ МВС, наказ № 225 від 29.10.2025</p>
  <p><a href="{up}">Тести ПДР онлайн</a> · <a href="{up}r/">Питання за розділами</a> ·
     <a href="{up}tema/">Теми</a> · <a href="{up}ispyt/">Пробний іспит</a> ·
     <a href="{up}pdr/">Текст ПДР</a> · <a href="{up}pro/">Про проєкт</a> ·
     <a href="https://ankiweb.net/shared/info/1194338664">Колода Anki</a> ·
     <a href="https://github.com/punjet/PDRAnkiDeck">GitHub</a> ·
     <a href="{up}privacy.html">Конфіденційність</a></p>
  <p>Неофіційний проєкт. Тексти питань і малюнки належать ГСЦ МВС України.</p>
</footer>
</div>
</body>
</html>
"""


def crumbs(items):
    """items: [(name, href or None, path)], first is home. Returns (html, JSON-LD)."""
    links = " › ".join(f'<a href="{href}">{esc(n)}</a>' if href is not None else esc(n)
                       for n, href, _ in items)
    data = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + p}
        for i, (n, _, p) in enumerate(items)]}
    return f'<nav class="crumbs small muted">{links}</nav>', data


def cta(up):
    return f"""<section class="card stack cta">
  <h2>Вчити всі питання з інтервальними повтореннями</h2>
  <p class="muted small">Безкоштовний тренажер: спершу питання, які найчастіше трапляються в білеті,
    потім повторення саме тоді, коли ви от-от забудете (FSRS, як в Anki). Пробний іспит на 20 питань
    за 20 хвилин, робота над помилками. Без реєстрації, працює офлайн.</p>
  <a class="btn primary block" href="{up}?src=seo">Почати тренування</a>
</section>"""


def write(out, path, text):
    full = os.path.join(out, path, "index.html")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(text)


def section_title(sid, name):
    return f"Розділ {sid}. {name.capitalize()}".replace("в1, в", "B1, B")


def pdr_section_of(rule):
    return rule.split(".")[0]


def build(out, questions, sections, ticket):
    """questions: build_web.py's entries plus "section"; sections: {id: name};
    ticket: {block: questions of that block per exam ticket}."""
    rules = load_json("pdr_rules.json", {"sections": {}, "items": {}})
    RULES, RSEC = rules["items"], rules["sections"]
    expl = {k: v for k, v in load_json("explanations.json", {}).items() if v.get("status") == "ok"}
    # Pages go live in batches (SEO_MAX_EXPLAINED, deck order: most likely in the ticket first);
    # a new domain that publishes 1800 pages at once looks like scaled content.
    limit = int(os.environ.get("SEO_MAX_EXPLAINED", "0") or 0)
    if limit:
        keep = [q["id"] for q in questions if q["id"] in expl][:limit]
        expl = {k: expl[k] for k in keep}

    by_sec, pool = {}, {}
    for q in questions:
        by_sec.setdefault(q["section"], []).append(q)
        pool[q["block"]] = pool.get(q["block"], 0) + 1
    for qs in by_sec.values():
        qs.sort(key=lambda q: q["num"])
    sec_ids = sorted(by_sec, key=rule_key)
    sitemap = ["", "r/", "pdr/"]

    # clause -> questions whose checked explanation cites it (for the PDR pages)
    cited_by = {}
    for q in questions:
        for k in (expl.get(q["id"]) or {}).get("rules", []):
            cited_by.setdefault(k, []).append(q)

    by_id = {q["id"]: q for q in questions}
    q_topics, topic_paths, _ = build_topics(out, questions, expl)
    lastmod = {}  # sitemap path -> YYYY-MM-DD, only where the date is known
    page_images = {}  # sitemap path -> image URLs, for the image sitemap extension

    def rule_href(up, k):
        return f"{up}pdr/{pdr_section_of(k)}/#p{k}"

    # Titles of explained pages: question + the explanation's label ("знак «Дати дорогу»"), so the
    # many questions that share a text ("Зображений дорожній знак позначає:") still differ.
    text_count = {}
    for q in questions:
        text_count[q["t"].strip()] = text_count.get(q["t"].strip(), 0) + 1

    def expl_title(q, e):
        lab = (e.get("label") or "").strip()
        if lab and text_count[q["t"].strip()] > 1:
            # A shared, generic text: what is on the picture is what people search for.
            return f"{lab[:1].upper() + lab[1:]} — {clip(q['t'].rstrip(' :?.'), 40)}: пояснення ПДР {YEAR}"
        return f"{clip(q['t'], 60)} — пояснення ПДР {YEAR}"
    title_count = {}
    for q in questions:
        if q["id"] in expl:
            t_ = expl_title(q, expl[q["id"]])
            title_count[t_] = title_count.get(t_, 0) + 1

    # ---------- question pages ----------
    for sid in sec_ids:
        qs = by_sec[sid]
        stitle = section_title(sid, sections[sid])
        for i, q in enumerate(qs):
            path = f"q/{q['id']}/"
            up = "../../"
            e = expl.get(q["id"])
            if e:
                sitemap.append(path)
                if e.get("at"):
                    lastmod[path] = e["at"]
                    lastmod[f"r/{sid}/"] = max(lastmod.get(f"r/{sid}/", ""), e["at"])
            right = q["o"][q["a"]]
            situation = (e or {}).get("situation", "").strip()
            alt = clip(situation, 200) if situation else f"Малюнок до питання {q['num']}: {clip(q['t'], 110)}"
            def dims(n):
                wh = img_size(os.path.join(out, "img", n))
                return f' width="{wh[0]}" height="{wh[1]}"' if wh else ""  # no layout jump while loading
            imgs = "".join(f'<img class="qimg" src="{up}img/{esc(n)}" alt="{esc(alt)}"{dims(n)} '
                           f'decoding="async"{LAZY if j else ""}>'
                           for j, n in enumerate(q["img"]))
            opts = "".join(
                f'<li><button type="button" class="opt{" right" if j == q["a"] else ""}" data-opt="{j}">'
                f'<span class="n">{j + 1}</span><span>{esc(o)}'
                f'{"<span class=mark> ✓</span>" if j == q["a"] else ""}</span></button></li>'
                for j, o in enumerate(q["o"]))
            share = 100 * ticket[q["block"]] / pool[q["block"]]
            chance = (f'<span class="xp-meta-i" title="Шанс, що це питання трапиться у вашому білеті">'
                      f'🎯 1 з {round(100 / share)} у білеті</span>')

            rules_box = ""
            if e:
                reveal = explain_block(q, e, up, rule_href)
            else:
                reveal = (f'<div class="xp-answer"><span class="xp-check" aria-hidden="true">✓</span>'
                          f'<div><small>Правильна відповідь</small><b>{q["a"] + 1}. {esc(right)}</b></div></div>')
            if e:
                items = []
                for k in e["rules"]:
                    txt = RULES[k]
                    body = f"<p>{esc(clip(txt, 600))}</p>" if len(txt) <= 900 else ""
                    items.append(f'<li><a href="{rule_href(up, k)}">Пункт {k} ПДР</a>{body}</li>')
                if items:
                    rules_box = f"""<section class="card stack">
  <h2>Пункти ПДР до питання</h2>
  <ul class="rules">{"".join(items)}</ul>
</section>"""
            twins = [by_id[t] for t in q.get("sim", []) if t in by_id]
            twins_box = ""
            if twins:
                rows = "".join(
                    f'<li><a class="sec" href="{up}q/{t["id"]}/"><span class="sec-no" aria-label="Розділ {esc(t["section"])}">{esc(t["section"])}</span>'
                    f'<span class="sec-name">{esc(clip(t["t"], 140))}<small>питання №{t["num"]}'
                    f'{" · з малюнком" if t["img"] else ""}</small></span></a></li>' for t in twins)
                twins_box = f"""<section class="card stack">
  <h2>Не сплутайте: схожі питання</h2>
  <p class="muted small">Виглядають майже так само, але правильна відповідь у них інша.</p>
  <ol class="seclist">{rows}</ol>
</section>"""
            tl = q_topics.get(q["id"], [])
            topic_line = "".join(f'<a class="xp-meta-i" href="{up}{p_}">🏷 {esc(nm)}</a>' for nm, p_ in tl)
            updated = (f'<span class="xp-meta-i" title="Пояснення оновлено">🕒 {ua_date(e["at"])}</span>'
                       if e and e.get("at") else "")
            nav = []
            if i > 0:
                nav.append(f'<a class="btn" href="{up}q/{qs[i - 1]["id"]}/">← Питання {qs[i - 1]["num"]}</a>')
            if i + 1 < len(qs):
                nav.append(f'<a class="btn" href="{up}q/{qs[i + 1]["id"]}/">Питання {qs[i + 1]["num"]} →</a>')
            bc_html, bc_ld = crumbs([("Тести ПДР", up, ""), ("Розділи", f"{up}r/", "r/"),
                                     (stitle, f"{up}r/{sid}/", f"r/{sid}/"),
                                     (f"Питання {q['num']}", None, path)])
            body = f"""{bc_html}
<article class="card stack quiz" data-a="{q['a']}">
  <div class="qsec">{esc(stitle)} · питання №{q['num']}</div>
  <h1 class="qtext">{esc(q['t'])}</h1>
  {imgs}
  {f'<p class="small muted">{esc(situation)}</p>' if situation and q["img"] else ""}
  <ol class="opts static-opts">{opts}</ol>
  <button type="button" class="ghost show" data-show>Показати відповідь</button>
  <div class="reveal stack">{reveal}</div>
  <div class="xp-meta">{chance}{topic_line}{updated}</div>
  {report_link(q, path)}
</article>
{rules_box}
{twins_box}
<div class="row spread qnav">{''.join(nav)}</div>
{cta(up)}"""
            # Many questions share a text ("Яка черговість проїзду…"): the number keeps titles unique.
            if e:
                title = expl_title(q, e)
                if title_count.get(title, 0) > 1:
                    title += f" ({sid}, №{q['num']})"
                # No answer in the snippet: someone who sees it in the results has no reason to click.
                lead = situation or (e.get("label") or "").strip()
                lead = (lead[:1].upper() + lead[1:]).rstrip(".") + ". " if lead else ""
                desc = clip(f"{lead}Як міркувати, чому інші варіанти неправильні і на чому найчастіше "
                            f"помиляються — пояснення за ПДР.", 158)
            else:
                title = f"{clip(q['t'], 60)} — ПДР {YEAR}, розд. {sid}, №{q['num']}"
                desc = clip(f"Правильна відповідь: {right} Питання №{q['num']}, {stitle}.", 158)
            # The official picture is the page's main image: Google prefers a relevant illustration
            # to a logo or an image with text, and link previews show the question's picture.
            img_url = SITE + "img/" + q["img"][0] if q["img"] else None
            ld_items = [bc_ld]
            if img_url:
                ld_items.append({"@context": "https://schema.org", "@type": "WebPage", "url": SITE + path,
                                 "name": title, "primaryImageOfPage": {
                                     "@type": "ImageObject", "contentUrl": img_url, "description": alt}})
                if e:
                    page_images[path] = [SITE + "img/" + n for n in q["img"]]
            write(out, path, page(path=path, depth=2, jsonld=ld_items, title=title, description=desc,
                                  body=body, index=bool(e), quiz=True, og_image=img_url))

    # ---------- exam section pages ----------
    rows = []
    for sid in sec_ids:
        qs = by_sec[sid]
        stitle = section_title(sid, sections[sid])
        path = f"r/{sid}/"
        sitemap.append(path)
        up = "../../"
        # Same tappable rows as the section list: number, question text, what is inside.
        def q_row(q):
            notes = [x for x in ("з малюнком" if q["img"] else "", "є пояснення" if q["id"] in expl else "") if x]
            sub = f'<small>{" · ".join(notes)}</small>' if notes else ""
            return (f'<li><a class="sec" href="{up}q/{q["id"]}/"><span class="sec-no" aria-label="Питання {q["num"]}">{q["num"]}</span>'
                    f'<span class="sec-name">{esc(clip(q["t"], 140))}{sub}</span></a></li>')
        items = "".join(q_row(q) for q in qs)
        n_img = sum(1 for q in qs if q["img"])
        major = sid.split(".")[0]
        pdr_link = (f'<p><a href="{up}pdr/{major}/">Текст розділу {major} ПДР «{esc(RSEC[major])}» →</a></p>'
                    if major in RSEC and int(major) <= 34 else "")
        share = 100 * ticket[qs[0]["block"]] / pool[qs[0]["block"]]
        tcount = {}
        for q in qs:
            for nm, p_ in q_topics.get(q["id"], []):
                tcount[(nm, p_)] = tcount.get((nm, p_), 0) + 1
        sec_topics = [k for k, c in sorted(tcount.items(), key=lambda x: -x[1]) if c >= 3][:8]
        topics_line = ('<p class="small">Теми розділу: ' + ", ".join(
            f'<a href="{up}{p_}">{esc(nm)}</a>' for nm, p_ in sec_topics) + "</p>") if sec_topics else ""
        bc_html, bc_ld = crumbs([("Тести ПДР", up, ""), ("Розділи", f"{up}r/", "r/"), (stitle, None, path)])
        body = f"""{bc_html}
<article class="card stack">
  <h1>{esc(stitle)}: питання ПДР {YEAR} з відповідями</h1>
  <p class="muted">{len(qs)} {plural(len(qs), "питання", "питання", "питань")} офіційної бази ГСЦ МВС
    для категорії B{f", з них {n_img} з малюнками" if n_img else ""}. Натисніть на питання, щоб відповісти
    й одразу побачити, чи правильно.</p>
  <p class="muted small">Шанс, що конкретне питання з цього розділу потрапить у ваш білет, — приблизно
    1 з {round(100 / share)}.</p>
  {topics_line}
  {pdr_link}
  <ol class="seclist">{items}</ol>
</article>
{cta(up)}"""
        write(out, path, page(
            path=path, depth=2, jsonld=[bc_ld],
            title=f"{clip(stitle, 60)} — питання ПДР {YEAR}",
            description=clip(f"{stitle}: усі {len(qs)} питань іспиту ГСЦ МВС для категорії B "
                             f"з правильними відповідями. Безкоштовний тренажер ПДР {YEAR}.", 158),
            body=body))
        # A whole row is the link (easy to tap on a phone): number, name, "79 питань", arrow.
        m = re.match(r"Розділ\s+(\d+(?:\.\d+)*)\.?\s*(.*)", stitle)
        no, name = (m.group(1), m.group(2)) if m else ("", stitle)
        n = len(qs)
        rows.append(f'<li><a class="sec" href="r/{sid}/"><span class="sec-no" aria-label="Розділ {esc(no)}">{esc(no)}</span>'
                    f'<span class="sec-name">{esc(name)}<small>{n} {plural(n, "питання", "питання", "питань")}</small></span></a></li>')

    index_list = "\n".join(rows)
    bc_html, bc_ld = crumbs([("Тести ПДР", "../", ""), ("Розділи", None, "r/")])
    write(out, "r/", page(
        path="r/", depth=1, jsonld=[bc_ld], og_type="website",
        title=f"Питання ПДР {YEAR} за розділами — категорія B",
        description=f"Усі {len(questions)} питань теоретичного іспиту ГСЦ МВС для категорії B "
                    f"за розділами ПДР, з правильними відповідями.",
        body=f"""{bc_html}
<article class="card stack">
  <h1>Питання ПДР {YEAR} за розділами</h1>
  <p class="muted">{len(questions)} питань офіційної бази ГСЦ МВС для категорії B.</p>
  <ol class="seclist">{index_list.replace('href="r/', 'href="')}</ol>
</article>
{cta("../")}"""))

    # ---------- PDR text pages ----------
    by_rsec = {}
    for k in RULES:
        by_rsec.setdefault(pdr_section_of(k), []).append(k)
    pdr_rows = []
    for rs in sorted(by_rsec, key=int):
        if rs not in RSEC:
            continue
        keys = sorted(by_rsec[rs], key=rule_key)
        path = f"pdr/{rs}/"
        sitemap.append(path)
        up = "../../"
        blocks = []
        for k in keys:
            qs = cited_by.get(k, [])
            linked = ("<p class=\"small\">Питання іспиту за цим пунктом: " + ", ".join(
                f'<a href="{up}q/{q["id"]}/">{q["id"].replace("-", ", №")}</a>' for q in qs[:30])
                + ("…" if len(qs) > 30 else "") + "</p>") if qs else ""
            blocks.append(f'<section class="clause" id="p{k}"><h2>{k}</h2>{paras(RULES[k])}{linked}</section>')
        bc_html, bc_ld = crumbs([("Тести ПДР", up, ""), ("ПДР", f"{up}pdr/", "pdr/"),
                                 (f"Розділ {rs}", None, path)])
        name = RSEC[rs]
        n_q = len({q["id"] for k in keys for q in cited_by.get(k, [])})
        write(out, path, page(
            path=path, depth=2, jsonld=[bc_ld],
            title=f"Розділ {rs} ПДР України: {clip(name, 50)} — текст {YEAR}",
            description=clip(f"Розділ {rs} Правил дорожнього руху України «{name}»: повний текст пунктів"
                             + (f" і {n_q} питань іспиту ГСЦ з поясненнями за ними." if n_q else "."), 158),
            body=f"""{bc_html}
<article class="card stack">
  <h1>Розділ {rs} ПДР. {esc(name)}</h1>
  <p class="muted small">Правила дорожнього руху України, постанова КМУ № 1306 від 10.10.2001, чинна редакція.
    Під пунктами — питання теоретичного іспиту, які на них спираються.</p>
  {"".join(blocks)}
</article>
{cta(up)}"""))
        pdr_rows.append(f'<li><a class="sec" href="{rs}/"><span class="sec-no" aria-label="Розділ {rs}">{rs}</span>'
                        f'<span class="sec-name">{esc(name)}</span></a></li>')
    bc_html, bc_ld = crumbs([("Тести ПДР", "../", ""), ("ПДР", None, "pdr/")])
    write(out, "pdr/", page(
        path="pdr/", depth=1, jsonld=[bc_ld], og_type="website",
        title=f"Правила дорожнього руху України {YEAR} — повний текст за розділами",
        description="Повний текст ПДР України за розділами, з посиланнями на питання теоретичного іспиту ГСЦ МВС.",
        body=f"""{bc_html}
<article class="card stack">
  <h1>Правила дорожнього руху України</h1>
  <ol class="seclist">{"".join(pdr_rows)}</ol>
</article>
{cta("../")}"""))

    # ---------- home page placeholders ----------
    idx = os.path.join(out, "index.html")
    with open(idx, encoding="utf-8") as f:
        src = f.read()
    app_ld = {
        "@context": "https://schema.org", "@type": "WebApplication",
        "name": APP_NAME, "url": SITE, "inLanguage": "uk",
        "applicationCategory": "EducationalApplication", "operatingSystem": "Any",
        "description": f"Усі {len(questions)} питань теоретичного іспиту ГСЦ МВС для категорії B "
                       f"з інтервальними повтореннями FSRS і пробним іспитом.",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "UAH"},
        "image": SITE + "og.png",
    }
    src = (src.replace("__YEAR__", YEAR).replace("__SITE__", SITE)
              .replace("__COUNT__", str(len(questions)))
              .replace("<!--SECTIONS-->", index_list)
              .replace("<!--JSONLD-->", f'<script type="application/ld+json">{ld(app_ld)}</script>'))
    with open(idx, "w", encoding="utf-8") as f:
        f.write(src)

    sitemap += topic_paths + build_static_pages(out, questions, ticket, pool, len(expl))
    with open(os.path.join(out, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
                'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n')
        f.writelines(f"<url><loc>{esc(SITE + u)}</loc>"
                     + (f"<lastmod>{lastmod[u]}</lastmod>" if u in lastmod else "")
                     + "".join(f"<image:image><image:loc>{esc(i)}</image:loc></image:image>"
                               for i in page_images.get(u, []))
                     + "</url>\n"
                     for u in sitemap)
        f.write("</urlset>\n")
    # Crawlers read robots.txt only at a domain root, i.e. once the site has its own domain.
    with open(os.path.join(out, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(f"User-agent: *\nAllow: /\n\nSitemap: {SITE}sitemap.xml\n")
    host = urlparse(SITE).hostname or ""
    if not host.endswith("github.io"):
        with open(os.path.join(out, "CNAME"), "w") as f:
            f.write(host + "\n")
    return {"sitemap": len(sitemap), "explained": len(expl)}


def plural(n, one, few, many):
    m10, m100 = n % 10, n % 100
    if m10 == 1 and m100 != 11:
        return one
    if 2 <= m10 <= 4 and not 12 <= m100 <= 14:
        return few
    return many


# ---------- helpers for the pages below ----------
TRANSLIT = dict(zip("абвгґдезиіїйклмнопрстуфхцчшщьюяєжё",
                    ["a", "b", "v", "h", "g", "d", "e", "z", "y", "i", "i", "i", "k", "l", "m", "n", "o", "p",
                     "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "iu", "ia", "ie", "zh", "e"]))


def slug(name):
    s = "".join(TRANSLIT.get(c, c) for c in name.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def img_size(path):
    """(width, height) of a JPEG or PNG, read from its header; None if unknown."""
    import struct
    try:
        with open(path, "rb") as f:
            d = f.read()
    except OSError:
        return None
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", d[16:24])
    if d[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(d):
            if d[i] != 0xFF:
                i += 1
                continue
            m = d[i + 1]
            if m in (0xD8, 0x01, 0xFF) or 0xD0 <= m <= 0xD7:
                i += 2 if m != 0xFF else 1
                continue
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", d[i + 5:i + 9])
                return w, h
            i += 2 + struct.unpack(">H", d[i + 2:i + 4])[0]
    return None


def q_row(up, q, note=""):
    """A tappable row linking to a question page (same look as the section lists)."""
    sub = f"<small>{note}</small>" if note else ""
    return (f'<li><a class="sec" href="{up}q/{q["id"]}/"><span class="sec-no" aria-label="Розділ {esc(q["section"])}">'
            f'{esc(q["section"])}</span><span class="sec-name">{esc(clip(q["t"], 140))}{sub}</span></a></li>')


def split_key(text):
    """First sentence (the main point, shown big) and the rest of the explanation."""
    text = text.strip()
    m = re.search(r"(?<=[.!?])\s+(?=[А-ЯІЇЄҐA-Z«(\d])", text)
    if not m or m.start() > 260:
        return text, ""
    return text[:m.start()], text[m.end():]


def explain_block(q, e, up, rule_href):
    """The explanation as distinct parts instead of one wall of text."""
    right = q["o"][q["a"]]
    key, rest = split_key(e["text"])
    steps = "".join(f"<li>{esc(x)}</li>" for x in e.get("steps", []))
    wrong = "".join(
        f'<li><span class="xp-x" aria-hidden="true">✕</span><div><b>{int(k)}. {esc(clip(q["o"][int(k) - 1], 90))}</b>'
        f'<span>{esc(v)}</span></div></li>'
        for k, v in sorted(e["wrong"].items(), key=lambda x: int(x[0])))
    cards = "".join(
        f'<div class="xp-card xp-{cls}"><b>{icon} {title}</b><p>{esc(e[k])}</p></div>'
        for k, cls, icon, title in (("trap", "trap", "⚠️", "Пастка"), ("what_if", "if", "🔄", "А якщо…"),
                                    ("tip", "if", "💡", "Порада")) if e.get(k))
    chips = "".join(f'<a class="xp-chip" href="{rule_href(up, k)}">📖 {k}</a>' for k in e.get("rules", []))
    return f"""<div class="xp-verdict" aria-live="polite">
    <span class="xp-v-right">✅ Правильно!</span><span class="xp-v-wrong">❌ Не зовсім.</span>
  </div>
  <div class="xp-answer"><span class="xp-check" aria-hidden="true">✓</span>
    <div><small>Правильна відповідь</small><b>{q["a"] + 1}. {esc(right)}</b></div></div>
  <div class="xp">
    <h2 class="xp-h">Пояснення</h2>
    <p class="xp-key">{esc(key)}</p>
    {f'<div class="xp-steps"><h3>Як міркувати</h3><ol>{steps}</ol></div>' if steps else ""}
    {f'<div class="xp-body">{paras(rest)}</div>' if rest else ""}
    {f'<div class="xp-wrong"><h3>Чому не інші</h3><ul>{wrong}</ul></div>' if wrong else ""}
    {f'<div class="xp-cards">{cards}</div>' if cards else ""}
    {f'<div class="xp-rules"><span>Пункти ПДР:</span>{chips}</div>' if chips else ""}
  </div>"""


def report_link(q, path):
    from urllib.parse import quote
    title = f"Помилка в питанні {q['id']}"
    body = f"Сторінка: {SITE}{path}\n\nЩо не так:\n"
    return (f'<p class="small muted">Знайшли помилку в питанні чи поясненні? '
            f'<a href="https://github.com/punjet/PDRAnkiDeck/issues/new?title={quote(title)}&body={quote(body)}" '
            f'rel="nofollow">Повідомте нам</a>.</p>')


def ua_date(iso):
    y, m, d = iso.split("-")
    return f"{d}.{m}.{y}"


# ---------- topic pages ----------
def build_topics(out, questions, expl):
    """tema/<slug>/ for every topic of data/topics.json (made by topics.py). Returns
    ({question id: [(name, path)]}, sitemap paths, [(group, [(name, path, n)])])."""
    data = load_json("topics.json", {})
    by_id = {q["id"]: q for q in questions}
    q_topics, paths, groups, used = {}, [], [], set()
    for t in data.get("topics", []):
        qs = [by_id[i] for i in t.get("q", []) if i in by_id]
        if len(qs) < 3:
            continue
        s = slug(t["name"]) or t["id"]
        while s in used:
            s += "-2"
        used.add(s)
        path = f"tema/{s}/"
        paths.append(path)
        up = "../../"
        for q in qs:
            q_topics.setdefault(q["id"], []).append((t["name"], path))
        secs = sorted({q["section"] for q in qs}, key=rule_key)
        rows = "".join(q_row(up, q, " · ".join(x for x in ("з малюнком" if q["img"] else "",
                                                           "є пояснення" if q["id"] in expl else "") if x))
                       for q in qs)
        bc_html, bc_ld = crumbs([("Тести ПДР", up, ""), ("Теми", f"{up}tema/", "tema/"), (t["name"], None, path)])
        n = len(qs)
        write(out, path, page(
            path=path, depth=2, jsonld=[bc_ld],
            title=f"{t['name']} — питання ПДР {YEAR} з відповідями, тест онлайн",
            description=clip(f"{t['name']}: {n} {plural(n, 'питання', 'питання', 'питань')} іспиту ГСЦ МВС "
                             f"для категорії B з правильними відповідями. {t.get('desc', '')}", 158),
            body=f"""{bc_html}
<article class="card stack">
  <h1>{esc(t['name'])}: питання ПДР {YEAR}</h1>
  <p>{esc(t.get('desc', ''))}</p>
  <p class="muted small">{n} {plural(n, "питання", "питання", "питань")} офіційної бази ГСЦ МВС для категорії B
    з розділів {", ".join(f'<a href="{up}r/{s_}/">{esc(s_)}</a>' for s_ in secs)}. Натисніть на питання, щоб
    відповісти й побачити пояснення.</p>
  <a class="btn primary block" href="{up}?topic={esc(t['id'])}">Тренувати тему «{esc(t['name'])}»</a>
  <ol class="seclist">{rows}</ol>
</article>
{cta(up)}"""))
        g = next((g for g in groups if g[0] == t.get("group")), None)
        if not g:
            groups.append(g := (t.get("group") or "Інше", []))
        g[1].append((t["name"], path, n))
    if paths:
        blocks = "".join(
            f'<h2>{esc(g)}</h2><ol class="seclist">' + "".join(
                f'<li><a class="sec" href="{p.split("/", 1)[1]}"><span class="sec-name">{esc(nm)}'
                f'<small>{n} {plural(n, "питання", "питання", "питань")}</small></span></a></li>'
                for nm, p, n in items) + "</ol>" for g, items in groups)
        bc_html, bc_ld = crumbs([("Тести ПДР", "../", ""), ("Теми", None, "tema/")])
        write(out, "tema/", page(
            path="tema/", depth=1, jsonld=[bc_ld], og_type="website",
            title=f"Питання ПДР {YEAR} за темами: знаки, перехрестя, обгін, домедична допомога",
            description=f"{len(paths)} тем теоретичного іспиту ГСЦ МВС для категорії B: дорожні знаки, розмітка, "
                        f"перехрестя, обгін, швидкість, домедична допомога та інші. Питання з відповідями.",
            body=f"""{bc_html}
<article class="card stack">
  <h1>Питання ПДР {YEAR} за темами</h1>
  <p class="muted">Ті самі питання іспиту, згруповані за змістом, а не за розділами. Зручно, щоб підтягнути
    конкретну тему: обгін, знаки пріоритету, кровотечі.</p>
  {blocks}
</article>
{cta("../")}"""))
        paths.insert(0, "tema/")
    return q_topics, paths, groups


# ---------- exam landing, about page, 404 ----------
def build_static_pages(out, questions, ticket, pool, n_explained):
    names = {"pdr": "ПДР (загальні розділи)", "safety": "основи безпечного водіння",
             "category": "додаткові питання категорії B", "firstaid": "домедична допомога"}
    parts = "".join(f"<li><b>{c}</b> — {names.get(k, k)} (з {pool.get(k, 0)} питань)</li>" for k, c in ticket.items())
    bc_html, bc_ld = crumbs([("Тести ПДР", "../", ""), ("Пробний іспит", None, "ispyt/")])
    write(out, "ispyt/", page(
        path="ispyt/", depth=1, jsonld=[bc_ld], og_type="website",
        title=f"Пробний іспит ПДР онлайн {YEAR} — 20 питань за 20 хвилин, як у сервісному центрі",
        description="Безкоштовний пробний іспит з ПДР для категорії B: 20 питань за 20 хвилин, склад білета як у "
                    "сервісному центрі МВС, не більше 2 помилок. Офіційна база ГСЦ, миттєва перевірка.",
        body=f"""{bc_html}
<article class="card stack">
  <h1>Пробний іспит ПДР онлайн</h1>
  <p>Білет зібрано так само, як на теоретичному іспиті в сервісному центрі МВС для категорії B: 20 питань,
    20 хвилин, допускається не більше двох помилок. Питання — з офіційної бази ГСЦ (наказ № 225 від 29.10.2025).</p>
  <a class="btn primary block big" href="../?go=exam">Почати пробний іспит</a>
  <h2>Як складається білет</h2>
  <ul>{parts}</ul>
  <h2>Як проходить</h2>
  <p>Після кожної відповіді одразу видно, правильна вона чи ні, а смужка вгорі показує прогрес. Питання можна
    пропустити й повернутися до нього. Помилки потрапляють у «Роботу над помилками».</p>
  <h2>Коли можна йти на справжній іспит</h2>
  <p>Хороший орієнтир — п'ять пробних іспитів поспіль з не більше ніж однією помилкою. Якщо до цього далеко,
    краще спершу пройти питання в режимі навчання: тренажер показує спершу ті, що найчастіше трапляються в білеті.</p>
  <h2>Часті питання</h2>
  <h3>Скільки помилок можна зробити на іспиті з ПДР?</h3>
  <p>Не більше двох. Третя помилка означає, що іспит не складено.</p>
  <h3>Скільки часу дається?</h3>
  <p>20 хвилин на 20 питань.</p>
  <h3>Це платно?</h3>
  <p>Ні, безкоштовно й без реєстрації. Прогрес зберігається у вашому браузері.</p>
  <p><a href="../tema/">Питання за темами</a> · <a href="../r/">Питання за розділами</a></p>
</article>"""))

    by_v = {}
    data = load_json("questions.json", {"questions": []})
    for q in data.get("questions", []):
        by_v[q.get("verified")] = by_v.get(q.get("verified"), 0) + 1
    bc_html, bc_ld = crumbs([("Тести ПДР", "../", ""), ("Про проєкт", None, "pro/")])
    write(out, "pro/", page(
        path="pro/", depth=1, jsonld=[bc_ld], og_type="website",
        title="Про проєкт і як ми перевіряємо відповіді — тести ПДР категорії B",
        description="Звідки питання, як перевірено відповіді (три незалежні способи), як написано пояснення "
                    "і як повідомити про помилку. Відкритий код, безкоштовно, без реклами.",
        body=f"""{bc_html}
<article class="card stack">
  <h1>Про проєкт</h1>
  <p>Безкоштовний тренажер для підготовки до теоретичного іспиту з ПДР на категорію B. Без реклами й реєстрації,
    з відкритим кодом на <a href="https://github.com/punjet/PDRAnkiDeck">GitHub</a>. Є також
    <a href="https://ankiweb.net/shared/info/1194338664">колода для Anki</a> з тими самими питаннями.
    Проєкт неофіційний: він не пов'язаний із ГСЦ МВС.</p>
  <h2>Звідки питання</h2>
  <p>Усі {len(questions)} питань категорії B (розділи 1–39 і 44–47) і малюнки взято з офіційної бази ГСЦ МВС,
    наказ № 225 від 29.10.2025 — чинна редакція.</p>
  <h2>Як перевірено відповіді</h2>
  <p>Офіційна таблиця відповідей — це скан, тому кожну відповідь категорії B звірено трьома незалежними способами:
    розпізнаванням тексту (tesseract), власним класифікатором цифр і незалежним відкритим набором даних
    <a href="https://github.com/Brut322/pdr-test">Brut322/pdr-test</a>. Там, де вони розходились
    ({by_v.get("manual", 0)} питань), відповідь звірено вручну зі сканом.</p>
  <h2>Як написано пояснення</h2>
  <p>Пояснення до питань пише мовна модель (ШІ) на основі тексту Правил дорожнього руху. Друга, незалежна модель
    відповідає на те саме питання наосліп, не знаючи правильної відповіді. Пояснення публікується, лише якщо обидві
    збігаються з офіційною відповіддю ГСЦ; розбіжності ми перевіряємо вручну. Номери пунктів ПДР під поясненнями
    ведуть на офіційний текст правил. Зараз пояснення є до {n_explained} питань, решта додається поступово.</p>
  <h2>Знайшли помилку?</h2>
  <p>Напишіть нам через <a href="https://github.com/punjet/PDRAnkiDeck/issues/new">GitHub</a> або натисніть
    «Повідомте нам» під будь-яким питанням. Ми виправляємо помилки й оновлюємо сайт.</p>
  <h2>Дані й конфіденційність</h2>
  <p>Тренажер збирає анонімну статистику навчання для відкритого дослідження про підготовку до іспиту.
    Що саме збирається і як це вимкнути — на сторінці <a href="../privacy.html">«Конфіденційність»</a>.</p>
  <h2>Ліцензія</h2>
  <p>Код і перевірений набір даних — CC BY-NC-SA 4.0. Тексти питань і малюнки належать ГСЦ МВС України.</p>
</article>"""))

    # GitHub Pages serves 404.html for any missing path, at any depth: absolute links only.
    html404 = page(path="404.html", depth=0, index=False, title="Сторінку не знайдено — тести ПДР",
                   description="Сторінку не знайдено.",
                   body=f"""<article class="card stack">
  <h1>Сторінку не знайдено</h1>
  <p>Можливо, адресу змінено або в ній помилка. Ось що є на сайті:</p>
  <ul>
    <li><a href="{SITE}">Тренажер: усі питання ПДР категорії B</a></li>
    <li><a href="{SITE}ispyt/">Пробний іспит онлайн</a></li>
    <li><a href="{SITE}tema/">Питання за темами</a></li>
    <li><a href="{SITE}r/">Питання за розділами</a></li>
    <li><a href="{SITE}pdr/">Текст ПДР</a></li>
  </ul>
</article>""")
    html404 = html404.replace('href="icon.svg"', f'href="{SITE}icon.svg"').replace(
        'href="style.css"', f'href="{SITE}style.css"').replace('href=""', f'href="{SITE}"')
    html404 = re.sub(r'href="(r/|pdr/|tema/|ispyt/|pro/|privacy\.html)"', lambda m: f'href="{SITE}{m.group(1)}"', html404)
    with open(os.path.join(out, "404.html"), "w", encoding="utf-8") as f:
        f.write(html404)
    return ["ispyt/", "pro/"]
