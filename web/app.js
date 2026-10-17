// ПДР України, категорія B: FSRS study, mock exam and mistakes drill.
// Scheduling is ts-fsrs (FSRS-6, the algorithm Anki uses) with Anki's defaults;
// progress lives in this browser's localStorage and can be exported as JSON.
import { fsrs, generatorParameters, createEmptyCard, Rating, State }
  from "./vendor/ts-fsrs-5.4.2.mjs";

const STORE_KEY = "pdr-b-v1";
const IMG_CACHE = "pdr-img-v1";
const DAY_START_HOUR = 4;          // Anki's default "next day starts at"
const LEARN_AHEAD_MS = 20 * 60e3;  // Anki's default learn-ahead limit
const EXAM_MINUTES = 20;
const EXAM_MAX_ERRORS = 2;

const PRESETS = {
  two: { label: "2 тижні", newPerDay: 175, retention: 0.9, maxIvl: 36500, steps: ["1m", "10m"] },
  one: { label: "1 тиждень", newPerDay: 350, retention: 0.92, maxIvl: 3, steps: ["10m", "1h"] },
};

const app = document.getElementById("app");
let DB;                 // questions.json
let byId;               // id -> question
let S;                  // persisted state
let scheduler;
let view = { name: "home" };
let timerHandle = null;

// ---------- storage ----------
function defaultState() {
  return {
    settings: { preset: "two", ...PRESETS.two },
    cards: {},        // id -> ts-fsrs card (dates as ISO strings)
    logs: [],         // [id, unix seconds, rating, state before] for a later optimizer
    day: { key: "", newDone: 0, reviewsDone: 0 },
    wrong: {},        // id -> unix ms of the last wrong answer (study or exam)
    exams: [],        // {at, errors, total, passed}
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) { /* private mode or blocked storage: start fresh in memory */ }
  return defaultState();
}

let saveFailed = false;
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
    saveFailed = false;
  } catch (e) {
    saveFailed = true;
  }
}

function makeScheduler() {
  const s = S.settings;
  scheduler = fsrs(generatorParameters({
    request_retention: s.retention,
    maximum_interval: s.maxIvl,
    enable_fuzz: true,           // Anki fuzzes intervals too
    enable_short_term: true,
    learning_steps: s.steps,
    relearning_steps: ["10m"],
  }));
}

// ---------- day bookkeeping ----------
function dayKey(t = Date.now()) {
  const d = new Date(t - DAY_START_HOUR * 3600e3);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function dayEnd(t = Date.now()) {
  const d = new Date(t - DAY_START_HOUR * 3600e3);
  d.setHours(24 + DAY_START_HOUR, 0, 0, 0);
  return d.getTime();
}
function rollDay() {
  const k = dayKey();
  if (S.day.key !== k) S.day = { key: k, newDone: 0, reviewsDone: 0 };
}

// ---------- queue ----------
const due = (c) => new Date(c.due).getTime();
const isLearning = (c) => c.state === State.Learning || c.state === State.Relearning;

function queueCounts() {
  rollDay();
  const now = Date.now(), end = dayEnd();
  let learn = 0, review = 0;
  for (const c of Object.values(S.cards)) {
    if (isLearning(c)) { if (due(c) <= now + LEARN_AHEAD_MS) learn++; }
    else if (c.state === State.Review && due(c) <= end) review++;
  }
  const unseen = DB.questions.length - Object.keys(S.cards).length;
  const fresh = Math.max(0, Math.min(unseen, S.settings.newPerDay - S.day.newDone));
  return { learn, review, fresh };
}

function nextCard() {
  rollDay();
  const now = Date.now(), end = dayEnd();
  let learnNow = null, learnSoon = null, rev = null;
  for (const [id, c] of Object.entries(S.cards)) {
    if (isLearning(c)) {
      const t = due(c);
      if (t <= now) { if (!learnNow || t < due(S.cards[learnNow])) learnNow = id; }
      else if (!learnSoon || t < due(S.cards[learnSoon])) learnSoon = id;
    } else if (c.state === State.Review && due(c) <= end) {
      if (!rev || due(c) < due(S.cards[rev])) rev = id;
    }
  }
  if (learnNow) return { id: learnNow, kind: "learn" };
  if (rev) return { id: rev, kind: "review" };
  if (S.settings.newPerDay - S.day.newDone > 0) {
    const q = DB.questions.find((q) => !S.cards[q.id]);
    if (q) return { id: q.id, kind: "new" };
  }
  if (learnSoon && due(S.cards[learnSoon]) <= now + LEARN_AHEAD_MS) return { id: learnSoon, kind: "learn" };
  return { id: null, nextAt: learnSoon ? due(S.cards[learnSoon]) : null };
}

function rate(id, rating) {
  const before = S.cards[id] || createEmptyCard(new Date());
  const wasNew = !S.cards[id];
  const { card } = scheduler.next(before, new Date(), rating);
  const undo = { id, card: S.cards[id] ? structuredClone(S.cards[id]) : null, day: { ...S.day },
                 wrong: S.wrong[id], logs: S.logs.length };
  S.cards[id] = serialize(card);
  S.logs.push([id, Math.round(Date.now() / 1000), rating, before.state]);
  if (wasNew) S.day.newDone++;
  else if (before.state === State.Review) S.day.reviewsDone++;
  if (rating === Rating.Again) S.wrong[id] = Date.now();
  save();
  return undo;
}

function undoRate(u) {
  if (u.card) S.cards[u.id] = u.card; else delete S.cards[u.id];
  S.day = u.day;
  if (u.wrong === undefined) delete S.wrong[u.id]; else S.wrong[u.id] = u.wrong;
  S.logs.length = u.logs;
  save();
}

function serialize(card) {
  return {
    ...card,
    due: new Date(card.due).toISOString(),
    last_review: card.last_review ? new Date(card.last_review).toISOString() : undefined,
  };
}

function previewIntervals(id) {
  const card = S.cards[id] || createEmptyCard(new Date());
  const now = new Date();
  const p = scheduler.repeat(card, now);
  const out = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    out[r] = fmtInterval(new Date(p[r].card.due).getTime() - now.getTime());
  }
  return out;
}

function fmtInterval(ms) {
  const m = Math.max(1, Math.round(ms / 60e3));
  if (m < 60) return `${m} хв`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} год`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} дн`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} міс`;
  return `${(d / 365).toFixed(1)} р`;
}

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function h(html) { app.innerHTML = html; window.scrollTo(0, 0); }

function go(v) {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  view = v;
  render();
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function questionHtml(q) {
  const imgs = q.img.map((n) =>
    `<img class="qimg" src="img/${esc(n)}" alt="Ілюстрація до питання" loading="eager" decoding="async">`).join("");
  return `
    <div class="qsec">${esc(q.sec)} · №${q.num}</div>
    <div class="qtext">${esc(q.t)}</div>
    ${imgs}`;
}

function optionsHtml(q, { chosen = null, reveal = false, selected = null } = {}) {
  return `<ul class="opts">${q.o.map((o, i) => {
    let cls = "opt";
    if (reveal) {
      if (i === q.a) cls += " right";
      else if (i === chosen) cls += " wrong";
      else cls += " dim";
    } else if (i === selected) cls += " sel";
    return `<li><button class="${cls}" data-opt="${i}" ${reveal ? "disabled" : ""}>
      <span class="n">${i + 1}</span><span>${esc(o)}</span></button></li>`;
  }).join("")}</ul>`;
}

// ---------- views ----------
function render() {
  ({ home: renderHome, study: renderStudy, exam: renderExam, result: renderResult,
     drill: renderDrill, settings: renderSettings })[view.name]();
}

function tierStats() {
  const rows = DB.tiers.map((t) => ({ ...t, total: 0, known: 0, learning: 0 }));
  const idx = Object.fromEntries(rows.map((r, i) => [r.n, i]));
  for (const q of DB.questions) {
    const r = rows[idx[q.tier]];
    r.total++;
    const c = S.cards[q.id];
    if (c) { if (c.state === State.Review) r.known++; else r.learning++; }
  }
  return rows;
}

function renderHome() {
  const { learn, review, fresh } = queueCounts();
  const tiers = tierStats();
  const total = DB.questions.length;
  const known = tiers.reduce((a, t) => a + t.known, 0);
  const learning = tiers.reduce((a, t) => a + t.learning, 0);
  const wrongCount = Object.keys(S.wrong).length;
  const last = S.exams.slice(-5);
  const pills = Array.from({ length: 5 }, (_, i) => {
    const e = last[i];
    if (!e) return `<span class="pill empty">—</span>`;
    return `<span class="pill ${e.errors <= 1 ? "ok" : "bad"}">${e.total - e.errors}/${e.total}</span>`;
  }).join("");
  const ready = last.length === 5 && last.every((e) => e.errors <= 1);
  const todo = learn + review + fresh;

  h(`
  <div class="top">
    <h1>ПДР · категорія B</h1>
    <button class="ghost" data-go="settings" aria-label="Налаштування">Налаштування</button>
  </div>
  <div class="stack">
    <section class="card stack">
      <div class="row spread">
        <h2>Сьогодні</h2>
        <div class="counts" title="нові · навчання · повторення">
          <span class="c-new">${fresh}</span><span class="c-learn">${learn}</span><span class="c-review">${review}</span>
        </div>
      </div>
      <p class="muted small">${todo
        ? `Нових: ${fresh} · на навчанні: ${learn} · повторень: ${review}`
        : "На сьогодні все. Повертайтеся завтра або пройдіть пробний іспит."}</p>
      <button class="primary block big" data-go="study" ${todo ? "" : "disabled"}>Вчити</button>
    </section>

    <section class="card stack">
      <div class="row spread"><h2>Пробний іспит</h2><span class="badge">20 питань · 20 хв</span></div>
      <p class="muted small">Як у сервісному центрі: 10 ПДР, 4 безпечне водіння, 4 кат. B, 2 домедична допомога. Склав — не більше ${EXAM_MAX_ERRORS} помилок.</p>
      <div class="pills" aria-label="Останні 5 іспитів">${pills}</div>
      <p class="small ${ready ? "" : "muted"}">${ready
        ? "✅ 5 іспитів поспіль з ≤1 помилкою — можна йти на справжній."
        : "Готовність: 5 іспитів поспіль з ≤1 помилкою."}</p>
      <button class="block" data-go="exam">Почати іспит</button>
    </section>

    <section class="card stack">
      <div class="row spread"><h2>Робота над помилками</h2><span class="badge">${wrongCount}</span></div>
      <p class="muted small">Питання, на які ви відповіли неправильно. Правильна відповідь прибирає питання зі списку; розклад FSRS не змінюється.</p>
      <button class="block" data-go="drill" ${wrongCount ? "" : "disabled"}>Повторити помилки</button>
    </section>

    <section class="card stack">
      <div class="row spread"><h2>Прогрес</h2><span class="muted small">${known + learning} з ${total} розпочато</span></div>
      <div class="stat-grid">
        <div><b class="c-review">${known}</b><span>вивчено</span></div>
        <div><b style="color:var(--warn)">${learning}</b><span>на навчанні</span></div>
        <div><b class="c-new">${total - known - learning}</b><span>нових</span></div>
      </div>
      <div>
      ${tiers.map((t) => `
        <div class="tier">
          <div class="row spread"><span class="name">${t.n}. ${esc(t.name)}</span>
            <span class="num">${t.known + t.learning}/${t.total}</span></div>
          <div class="bar" style="margin-top:6px">
            <span class="b-known" style="width:${100 * t.known / t.total}%"></span>
            <span class="b-learn" style="width:${100 * t.learning / t.total}%"></span>
          </div>
        </div>`).join("")}
      </div>
    </section>
    ${saveFailed ? `<p class="small" style="color:var(--bad)">Браузер не дає зберегти прогрес (приватний режим?). Він зникне після закриття вкладки.</p>` : ""}
  </div>
  <footer class="stack">
    <p>${esc(DB.source)} · ${total} питань</p>
    <p><a href="https://github.com/punjet/PDRAnkiDeck">GitHub</a> ·
       <a href="https://ankiweb.net/shared/info/1194338664">Колода Anki</a> ·
       <a href="https://github.com/punjet/PDRAnkiDeck/blob/main/NOTICE">Ліцензія CC BY-NC-SA 4.0</a></p>
    <p>Неофіційний проєкт. Тексти питань і малюнки належать ГСЦ МВС України.</p>
  </footer>`);
}

// ---- study ----
function renderStudy() {
  const pick = view.current || nextCard();
  if (!pick.id) {
    const soon = pick.nextAt;
    h(`
    <div class="top"><button class="ghost" data-go="home">← Назад</button><h1>Навчання</h1></div>
    <div class="card empty-state stack">
      <div class="emoji">${soon ? "⏳" : "🎉"}</div>
      <h2>${soon ? "Перерва" : "На сьогодні все"}</h2>
      <p class="muted">${soon
        ? `Наступна картка на навчанні — о ${new Date(soon).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}.`
        : "Нові картки й повторення на сьогодні закінчилися."}</p>
      ${soon ? `<button class="block" data-act="study-now">Показати зараз</button>` : ""}
      <button class="primary block" data-go="exam">Пробний іспит</button>
    </div>`);
    return;
  }
  view.current = pick;
  const q = byId[pick.id];
  const { learn, review, fresh } = queueCounts();
  const st = view.state || { chosen: null };
  view.state = st;
  const answered = st.chosen !== null;
  const correct = answered && st.chosen === q.a;
  let dock = "";
  if (answered) {
    const iv = previewIntervals(q.id);
    dock = correct
      ? `<div class="grades">
           <button data-rate="${Rating.Hard}">Важко<small>${iv[Rating.Hard]}</small></button>
           <button class="primary" data-rate="${Rating.Good}">Добре<small>${iv[Rating.Good]}</small></button>
           <button data-rate="${Rating.Easy}">Легко<small>${iv[Rating.Easy]}</small></button>
         </div>`
      : `<button class="primary block big" data-rate="${Rating.Again}">Далі · знову через ${iv[Rating.Again]}</button>`;
  } else if (view.undo) {
    dock = `<button class="ghost" data-act="undo">↶ Скасувати попередню відповідь</button>`;
  }
  h(`
  <div class="top">
    <button class="ghost" data-go="home">← Назад</button>
    <div class="grow"></div>
    <div class="counts" title="нові · навчання · повторення">
      <span class="c-new ${pick.kind === "new" ? "on" : ""}">${fresh}</span>
      <span class="c-learn ${pick.kind === "learn" ? "on" : ""}">${learn}</span>
      <span class="c-review ${pick.kind === "review" ? "on" : ""}">${review}</span>
    </div>
  </div>
  <article class="card">
    ${questionHtml(q)}
    ${optionsHtml(q, { chosen: st.chosen, reveal: answered })}
    ${answered ? `<p class="verdict ${correct ? "ok" : "bad"}">${correct
      ? "Правильно. Наскільки легко було?"
      : `Неправильно. Правильна відповідь — ${q.a + 1}.`}</p>` : ""}
  </article>
  ${dock ? `<div class="dock"><div class="dock-inner">${dock}</div></div>` : ""}`);
}

// ---- exam ----
function newExam() {
  const pools = {};
  for (const q of DB.questions) (pools[q.block] ||= []).push(q.id);
  const ids = [];
  for (const { block, count } of DB.ticket) ids.push(...shuffle([...pools[block]]).slice(0, count));
  return { ids, answers: Array(ids.length).fill(null), i: 0, selected: null,
           endsAt: Date.now() + EXAM_MINUTES * 60e3 };
}

function renderExam() {
  if (!view.exam) view.exam = newExam();
  const ex = view.exam;
  if (Date.now() >= ex.endsAt) return finishExam(true);
  const q = byId[ex.ids[ex.i]];
  const dots = ex.ids.map((_, i) =>
    `<span class="dot ${i === ex.i ? "cur" : ex.answers[i] !== null ? "done" : ""}"></span>`).join("");
  h(`
  <div class="top">
    <button class="ghost" data-act="exam-quit">✕ Вийти</button>
    <h1 class="small muted" style="text-align:center">Питання ${ex.i + 1} з ${ex.ids.length}</h1>
    <span class="timer" id="timer"></span>
  </div>
  <div class="dots">${dots}</div>
  <article class="card">
    ${questionHtml(q)}
    ${optionsHtml(q, { selected: ex.selected })}
  </article>
  <div class="dock"><div class="dock-inner">
    <button class="primary block big" data-act="exam-answer" ${ex.selected === null ? "disabled" : ""}>
      ${ex.i + 1 < ex.ids.length ? "Відповісти" : "Відповісти й завершити"}</button>
  </div></div>`);
  tick();
  timerHandle = setInterval(tick, 1000);
}

function tick() {
  const ex = view.exam;
  const left = Math.max(0, ex.endsAt - Date.now());
  const el = document.getElementById("timer");
  if (el) {
    const m = Math.floor(left / 60e3), s = Math.floor(left / 1000) % 60;
    el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    el.classList.toggle("low", left < 3 * 60e3);
  }
  if (left <= 0) finishExam(true);
}

function finishExam(timeout = false) {
  const ex = view.exam;
  const errors = ex.ids.reduce((n, id, i) => n + (ex.answers[i] !== byId[id].a ? 1 : 0), 0);
  ex.ids.forEach((id, i) => { if (ex.answers[i] !== byId[id].a) S.wrong[id] = Date.now(); });
  const rec = { at: Date.now(), errors, total: ex.ids.length, passed: errors <= EXAM_MAX_ERRORS, timeout };
  S.exams.push(rec);
  save();
  go({ name: "result", exam: ex, rec });
}

function renderResult() {
  const { exam: ex, rec } = view;
  const wrong = ex.ids.map((id, i) => ({ q: byId[id], chosen: ex.answers[i] }))
    .filter((x) => x.chosen !== x.q.a);
  h(`
  <div class="top"><button class="ghost" data-go="home">← На головну</button></div>
  <section class="card stack" style="text-align:center">
    <div class="emoji" style="font-size:40px">${rec.passed ? "✅" : "❌"}</div>
    <div class="result-big">${rec.total - rec.errors}/${rec.total}</div>
    <h2>${rec.passed ? "Склав" : "Не склав"}</h2>
    <p class="muted">${rec.errors} ${plural(rec.errors, "помилка", "помилки", "помилок")}${rec.timeout ? " · час вичерпано" : ""}.
      Допускається не більше ${EXAM_MAX_ERRORS}.</p>
    <div class="row" style="justify-content:center">
      <button class="primary" data-go="exam">Ще один іспит</button>
      <button data-go="home">На головну</button>
    </div>
  </section>
  ${wrong.length ? `<h2 style="margin:20px 0 12px">Помилки</h2>
  <div class="stack">${wrong.map(({ q, chosen }) => `
    <article class="card">${questionHtml(q)}${optionsHtml(q, { chosen, reveal: true })}
      ${chosen === null ? `<p class="verdict bad">Без відповіді</p>` : ""}</article>`).join("")}
  </div>` : ""}`);
}

// ---- mistakes drill ----
function renderDrill() {
  if (!view.queue) {
    view.queue = Object.entries(S.wrong).sort((a, b) => b[1] - a[1]).map(([id]) => id)
      .filter((id) => byId[id]);
  }
  const id = view.queue[0];
  if (!id) {
    h(`
    <div class="top"><button class="ghost" data-go="home">← Назад</button><h1>Помилки</h1></div>
    <div class="card empty-state stack"><div class="emoji">🎉</div><h2>Помилок не лишилося</h2>
      <button class="primary block" data-go="home">На головну</button></div>`);
    return;
  }
  const q = byId[id];
  const st = view.state || { chosen: null };
  view.state = st;
  const answered = st.chosen !== null;
  const correct = answered && st.chosen === q.a;
  h(`
  <div class="top"><button class="ghost" data-go="home">← Назад</button>
    <h1 class="small muted" style="text-align:center">Помилки · лишилось ${view.queue.length}</h1></div>
  <article class="card">
    ${questionHtml(q)}
    ${optionsHtml(q, { chosen: st.chosen, reveal: answered })}
    ${answered ? `<p class="verdict ${correct ? "ok" : "bad"}">${correct
      ? "Правильно — питання прибрано зі списку."
      : `Неправильно. Правильна відповідь — ${q.a + 1}. Питання повториться.`}</p>` : ""}
  </article>
  ${answered ? `<div class="dock"><div class="dock-inner">
    <button class="primary block big" data-act="drill-next">Далі</button></div></div>` : ""}`);
}

// ---- settings ----
function renderSettings() {
  const s = S.settings;
  h(`
  <div class="top"><button class="ghost" data-go="home">← Назад</button><h1>Налаштування</h1></div>
  <div class="stack">
    <section class="card stack">
      <h2>Скільки часу до іспиту</h2>
      <div class="seg">${Object.entries(PRESETS).map(([k, p]) =>
        `<button data-preset="${k}" class="${s.preset === k ? "on" : ""}">${p.label}</button>`).join("")}</div>
      <p class="note">2 тижні: 175 нових на день, ~2–2,5 год. 1 тиждень: 350 нових на день 5 днів і 2 дні повторення, ~4–5 год,
        максимальний інтервал 3 дні, кроки навчання 10 хв і 1 год.</p>
      <label class="field"><span>Нових карток на день</span>
        <input type="number" id="newPerDay" min="0" max="2000" value="${s.newPerDay}"></label>
      <label class="field"><span>Бажана утримуваність (FSRS)</span>
        <select id="retention">${[0.85, 0.9, 0.92, 0.95].map((r) =>
          `<option value="${r}" ${s.retention === r ? "selected" : ""}>${Math.round(r * 100)} %</option>`).join("")}</select></label>
      <label class="field"><span>Максимальний інтервал, днів</span>
        <input type="number" id="maxIvl" min="1" max="36500" value="${s.maxIvl}"></label>
      <p class="note">Алгоритм — FSRS-6 (як в Anki) зі стандартними параметрами. Кроки навчання: ${esc(s.steps.join(" "))},
        повторне навчання: 10m.</p>
      <button class="primary block" data-act="save-settings">Зберегти</button>
    </section>

    <section class="card stack">
      <h2>Офлайн</h2>
      <p class="note">Збереже всі малюнки на пристрій (~30 МБ), щоб вчитися без інтернету. На телефоні додайте сайт на головний екран:
        «Поділитися → На початковий екран» (iPhone) або меню браузера → «Встановити застосунок» (Android).</p>
      <button class="block" data-act="offline" id="offlineBtn">Зберегти для офлайну</button>
    </section>

    <section class="card stack">
      <h2>Прогрес</h2>
      <p class="note">Прогрес зберігається лише в цьому браузері. Зробіть резервну копію, щоб перенести його на інший пристрій.</p>
      <div class="row">
        <button class="grow" data-act="export">Експорт</button>
        <label class="btn grow" style="cursor:pointer">Імпорт<input type="file" id="importFile" accept="application/json" hidden></label>
      </div>
      <button class="block" data-act="reset" style="color:var(--bad)">Скинути весь прогрес</button>
    </section>
  </div>`);
}

// ---------- events ----------
app.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-go]");
  if (!t || t.disabled) return;
  if (t.dataset.go) {
    const v = { name: t.dataset.go };
    if (v.name === "exam" && view.name === "exam" && view.exam && !confirm("Почати новий іспит?")) return;
    return go(v);
  }
  if (t.dataset.opt !== undefined) return pickOption(Number(t.dataset.opt));
  if (t.dataset.rate !== undefined) return doRate(Number(t.dataset.rate));
  if (t.dataset.preset) {
    const p = PRESETS[t.dataset.preset];
    S.settings = { preset: t.dataset.preset, ...p };
    save(); makeScheduler(); return render();
  }
  const act = t.dataset.act;
  if (act === "undo" && view.undo) {
    undoRate(view.undo);
    const id = view.undo.id;
    view = { name: "study", current: { id, kind: view.undo.card ? (isLearning(view.undo.card) ? "learn" : "review") : "new" } };
    return render();
  }
  if (act === "study-now") {
    const learning = Object.entries(S.cards).filter(([, c]) => isLearning(c)).sort((a, b) => due(a[1]) - due(b[1]));
    if (learning[0]) { view = { name: "study", current: { id: learning[0][0], kind: "learn" } }; render(); }
    return;
  }
  if (act === "exam-answer") {
    const ex = view.exam;
    ex.answers[ex.i] = ex.selected;
    ex.selected = null;
    if (ex.i + 1 >= ex.ids.length) return finishExam();
    ex.i++;
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    return renderExam();
  }
  if (act === "exam-quit") {
    if (confirm("Вийти з іспиту? Результат не буде зараховано.")) go({ name: "home" });
    return;
  }
  if (act === "drill-next") {
    const id = view.queue.shift();
    if (view.state.chosen === byId[id].a) { delete S.wrong[id]; save(); }
    else view.queue.push(id);
    view.state = null;
    return render();
  }
  if (act === "save-settings") {
    const n = (sel, lo, hi, d) => {
      const v = Number(document.getElementById(sel).value);
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
    };
    S.settings = {
      ...S.settings,
      preset: "custom",
      newPerDay: n("newPerDay", 0, 2000, S.settings.newPerDay),
      retention: Number(document.getElementById("retention").value),
      maxIvl: n("maxIvl", 1, 36500, S.settings.maxIvl),
    };
    save(); makeScheduler();
    return go({ name: "home" });
  }
  if (act === "export") return exportProgress();
  if (act === "reset") {
    if (confirm("Видалити весь прогрес, історію іспитів і помилки? Це не можна скасувати.")) {
      S = defaultState(); save(); makeScheduler(); go({ name: "home" });
    }
    return;
  }
  if (act === "offline") return saveOffline(t);
});

app.addEventListener("change", (e) => {
  if (e.target.id === "importFile" && e.target.files[0]) importProgress(e.target.files[0]);
});

function pickOption(i) {
  if (view.name === "exam") { view.exam.selected = i; return renderExamKeepTimer(); }
  if ((view.name === "study" || view.name === "drill") && view.state && view.state.chosen === null) {
    view.state.chosen = i;
    render();
    // On a phone the right answer can sit under the bottom bar: bring it into view.
    app.querySelector(".opt.right")?.scrollIntoView({ block: "center" });
  }
}

function renderExamKeepTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  const y = window.scrollY;
  renderExam();
  window.scrollTo(0, y);
}

function doRate(r) {
  const id = view.current.id;
  const undo = rate(id, r);
  view = { name: "study", undo };
  render();
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 9) {
    const btn = app.querySelector(`[data-opt="${n - 1}"]:not([disabled])`);
    if (btn) { e.preventDefault(); return pickOption(n - 1); }
  }
  if (e.key === " " || e.key === "Enter") {
    const main = app.querySelector(".dock .primary:not([disabled])");
    if (main) { e.preventDefault(); main.click(); }
  }
});

// ---------- backup & offline ----------
function exportProgress() {
  const blob = new Blob([JSON.stringify({ app: STORE_KEY, exported: new Date().toISOString(), state: S })],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pdr-b-progress-${dayKey()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importProgress(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== STORE_KEY || !data.state || typeof data.state.cards !== "object") throw new Error("format");
    if (!confirm("Замінити поточний прогрес даними з файлу?")) return;
    S = { ...defaultState(), ...data.state };
    save(); makeScheduler(); go({ name: "home" });
  } catch (err) {
    alert("Це не файл прогресу цього застосунку.");
  }
}

async function saveOffline(btn) {
  if (!("caches" in window)) { alert("Цей браузер не підтримує офлайн-збереження."); return; }
  const names = [...new Set(DB.questions.flatMap((q) => q.img))];
  const cache = await caches.open(IMG_CACHE);
  btn.disabled = true;
  let done = 0, failed = 0;
  const queue = [...names];
  async function worker() {
    while (queue.length) {
      const n = queue.shift();
      const url = new URL(`img/${n}`, location.href).href;
      try {
        if (!(await cache.match(url))) {
          const r = await fetch(url);
          if (r.ok) await cache.put(url, r); else failed++;
        }
      } catch (err) { failed++; }
      done++;
      btn.textContent = `Збережено ${done} з ${names.length}…`;
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  btn.textContent = failed ? `Готово, ${failed} не вдалося — спробуйте ще раз` : "✅ Усе збережено для офлайну";
  btn.disabled = false;
}

// ---------- boot ----------
async function boot() {
  S = load();
  makeScheduler();
  try {
    const r = await fetch("questions.json");
    if (!r.ok) throw new Error(r.status);
    DB = await r.json();
  } catch (e) {
    app.innerHTML = `<p class="loading">Не вдалося завантажити питання. Перевірте інтернет і оновіть сторінку.</p>`;
    return;
  }
  byId = Object.fromEntries(DB.questions.map((q) => [q.id, q]));
  // Drop progress for questions that are no longer in the base after an update.
  for (const id of Object.keys(S.cards)) if (!byId[id]) delete S.cards[id];
  for (const id of Object.keys(S.wrong)) if (!byId[id]) delete S.wrong[id];
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && DB && view.name === "home") render();
});

boot();
