// ПДР України, категорія B: FSRS study, mock exam and mistakes drill.
// Scheduling is ts-fsrs (FSRS-6, the algorithm Anki uses) with Anki's defaults;
// progress lives in this browser's localStorage and can be exported as JSON.
import { fsrs, generatorParameters, createEmptyCard, Rating, State }
  from "./vendor/ts-fsrs-5.4.2.mjs";
import * as tele from "./telemetry.js";
import MiniSearch from "./vendor/minisearch-7.2.0.mjs";
import * as grader from "./grade.js";
import { esc, plural, clipText, shuffle, ICON, topBar, dock, emptyState, announce, toast,
  confetti as confettiRaw, ask } from "./ui.js";

const APP_VER = "1.4";
const STORE_KEY = "pdr-b-v1";
const IMG_CACHE = "pdr-img-v2";
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
function newDay(key) {
  // ready0: pass chance at the first look today, to show today's gain.
  return { key, newDone: 0, reviewsDone: 0, answers: 0, correct: 0, bonus: 0, ready0: null, goalDone: false };
}

function defaultState() {
  return {
    settings: { preset: "two", ...PRESETS.two },
    cards: {},        // id -> ts-fsrs card (dates as ISO strings)
    logs: [],         // [id, unix seconds, rating, state before] for a later optimizer
    day: newDay(""),
    days: {},         // day index -> answers that day (any mode): streak and activity strip
    best: { combo: 0 },
    plan: { examDate: null, remindAt: null },   // "YYYY-MM-DD", "HH:MM"
    ui: { installLaterAt: 0, tourDone: false },
    // shuffle: options in a new order each time, like the HSC exam; auto: a right answer
    // is graded by grade.js and the next question comes by itself; autoAsked: auto was
    // offered after the first manual grades (it starts off); motion: animations.
    prefs: { shuffle: true, auto: false, autoAsked: false, motion: true },
    grade: null,      // grade.js model: this person's pace and how they grade by hand
    wrong: {},        // id -> unix ms of the last wrong answer (study or exam)
    exams: [],        // {at, errors, total, passed}
    firstSeen: null,  // unix ms of the first launch: "day of preparation" for stats
    // Anonymous telemetry: random id, on/off and the self-reported real exam result.
    tele: { uid: null, on: null, outcome: null, outcomeAt: 0, visited: false, firstSrc: null },
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
  if (S.day.key !== k) S.day = newDay(k);
}

// ---------- queue ----------
const newLeft = () => S.settings.newPerDay + (S.day.bonus || 0) - S.day.newDone;
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
  const fresh = Math.max(0, Math.min(unseen, newLeft()));
  return { learn, review, fresh };
}

// Order within the day:
//  1. learning steps that are due (short-term memory first, as in Anki);
//  2. due reviews by descending retrievability: the ones most likely remembered go first.
//     FSRS simulations show this keeps the most knowledge when a session is cut short
//     (ankitects/anki#3460), and a run of right answers early keeps people going;
//  3. new cards spread evenly between the reviews instead of after all of them, so
//     neither a wall of reviews nor a wall of new cards. `skip` lets the caller exclude
//     the card just shown so the same question never comes twice in a row.
function nextCard(skip = null) {
  rollDay();
  const now = Date.now(), end = dayEnd(), nowD = new Date(now);
  let learnNow = null, learnSoon = null, rev = null, revR = -1, revN = 0;
  for (const [id, c] of Object.entries(S.cards)) {
    if (id === skip) continue;
    if (isLearning(c)) {
      const t = due(c);
      if (t <= now) { if (!learnNow || t < due(S.cards[learnNow])) learnNow = id; }
      else if (!learnSoon || t < due(S.cards[learnSoon])) learnSoon = id;
    } else if (c.state === State.Review && due(c) <= end) {
      revN++;
      const r = scheduler.get_retrievability(c, nowD, false);
      if (r > revR) { rev = id; revR = r; }
    }
  }
  if (learnNow) return { id: learnNow, kind: "learn" };
  const fresh = newLeft() > 0 ? DB.questions.find((q) => !S.cards[q.id]) : null;
  if (rev && fresh) {
    const left = Math.min(newLeft(), DB.questions.length - Object.keys(S.cards).length);
    const every = Math.max(2, Math.round((revN + left) / left));   // one new card per `every` answers
    if ((S.day.answers || 0) % every === every - 1) return { id: fresh.id, kind: "new" };
  }
  if (rev) return { id: rev, kind: "review" };
  if (fresh) return { id: fresh.id, kind: "new" };
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
  S.day.answers = (S.day.answers || 0) + 1;
  if (rating !== Rating.Again) S.day.correct = (S.day.correct || 0) + 1;
  save();
  return undo;
}

function undoRate(u) {
  if (u.card) S.cards[u.id] = u.card; else delete S.cards[u.id];
  S.day = u.day;
  if (u.wrong === undefined) delete S.wrong[u.id]; else S.wrong[u.id] = u.wrong;
  S.logs.length = u.logs;
  if (u.grade) S.grade = u.grade;
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

// ---------- telemetry context ----------
let SID = crypto.randomUUID();
const SESSION_GAP_MS = 30 * 60e3;   // hidden longer than this -> next visit is a new session
const BEAT_MS = 60e3;               // one ping per minute of visible time

// Visible-time clock: stops while the tab is hidden, so answer times and session
// length do not count minutes spent in another app.
let hiddenTotal = 0;
let hiddenSince = document.visibilityState === "hidden" ? performance.now() : null;
function activeNow() {
  const t = performance.now();
  return t - hiddenTotal - (hiddenSince !== null ? t - hiddenSince : 0);
}

// Session bookkeeping for the pings table.
const sess = { base: 0, seq: 0, answers: 0, lastBeat: 0, hidePinged: false, src: null, ref: null };

function cleanTag(v) {
  if (!v) return null;
  const t = String(v).toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return t || null;
}

// ?src=reddit_ukraina, or utm_source[+utm_campaign]; referrer is kept as a bare domain.
function readSource() {
  const q = new URLSearchParams(location.search);
  const utm = q.get("utm_source") && [q.get("utm_source"), q.get("utm_campaign")].filter(Boolean).join("-");
  sess.src = cleanTag(q.get("src") || utm);
  try {
    const host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "";
    sess.ref = host && host !== location.hostname ? host.slice(0, 64) : null;
  } catch (e) { sess.ref = null; }
  if (q.has("src") || q.has("utm_source") || q.has("utm_campaign") || q.has("utm_medium") || q.has("go")) {
    // Drop the tag from the address bar so a shared or bookmarked link does not reuse it.
    for (const k of ["src", "utm_source", "utm_campaign", "utm_medium", "utm_content", "utm_term", "go"]) q.delete(k);
    const rest = q.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  }
}

function currentQid() {
  if (view.name === "study") return view.current?.id || null;
  if (view.name === "drill") return view.queue?.[0] || null;
  if (view.name === "exam") return view.exam ? view.exam.ids[view.exam.i] : null;
  if (view.name === "practice") return view.ids?.[view.i] || null;
  return null;
}

function ping(kind) {
  const start = kind === "start";
  tele.track("pings", {
    uid: S.tele.uid, sid: SID, seq: sess.seq++, kind,
    active_s: Math.min(86400, Math.round((activeNow() - sess.base) / 1000)),
    answers: sess.answers, screen: view.name, qid: currentQid(),
    first_visit: start ? !S.tele.visited : null,
    src: start ? sess.src : null,
    first_src: start ? S.tele.firstSrc : null,
    ref: start ? sess.ref : null,
    streak: start ? streakInfo().n : null,
    ready_pct: start && DB ? passChance() : null,
    exam_in: start ? examDaysLeft() : null,
    day_n: dayN(), local_hour: new Date().getHours(), device: device(),
    standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    app_ver: APP_VER,
  });
  if (start && !S.tele.visited) { S.tele.visited = true; save(); }
  sess.lastBeat = activeNow();
}

function startSession() {
  sess.base = activeNow();
  sess.seq = 0;
  sess.answers = 0;
  ping("start");
}

document.addEventListener("visibilitychange", () => {
  if (!S) return;
  if (document.visibilityState === "hidden") {
    hiddenSince = performance.now();
    if (!sess.hidePinged) { ping("hide"); sess.hidePinged = true; tele.flush(true); }
  } else if (hiddenSince !== null) {
    const away = performance.now() - hiddenSince;
    hiddenTotal += away;
    hiddenSince = null;
    sess.hidePinged = false;
    if (away > SESSION_GAP_MS && DB) {
      SID = crypto.randomUUID();
      sess.src = null; sess.ref = null;
      startSession();
    }
  }
});
window.addEventListener("pagehide", () => {
  if (S && !sess.hidePinged) { ping("hide"); sess.hidePinged = true; tele.flush(true); }
});
setInterval(() => {
  if (S && DB && document.visibilityState === "visible" && activeNow() - sess.lastBeat >= BEAT_MS) ping("beat");
}, 5e3);

function dayN() {
  const start = new Date((S.firstSeen || Date.now()) - DAY_START_HOUR * 3600e3); start.setHours(0, 0, 0, 0);
  const now = new Date(Date.now() - DAY_START_HOUR * 3600e3); now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((now - start) / 864e5));
}

function device() {
  // Some browsers report a fine primary pointer on touch devices; any touch input counts.
  const touch = matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: coarse)").matches
    || navigator.maxTouchPoints > 0;
  const side = Math.min(screen.width, screen.height);
  if (touch && side < 600) return "phone";
  if (touch && side < 1100) return "tablet";
  return "desktop";
}

function progressCounts() {
  let known = 0, started = 0;
  for (const c of Object.values(S.cards)) { started++; if (c.state === State.Review) known++; }
  return { known, started };
}

// ---------- motivation: streak, daily goal, pass chance, reminders ----------
// Calendar day index in local time, with the day starting at DAY_START_HOUR like the queue.
function dayIdx(t = Date.now()) {
  const d = new Date(t - DAY_START_HOUR * 3600e3);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
}

// Progress saved before v1.3 has no S.days: rebuild it from the review log and exams.
function seedDays() {
  if (Object.keys(S.days).length) return;
  for (const l of S.logs) { const k = dayIdx(l[1] * 1000); S.days[k] = (S.days[k] || 0) + 1; }
  for (const e of S.exams) { const k = dayIdx(e.at); S.days[k] = (S.days[k] || 0) + e.total; }
}

function markActive() {   // true for the first answer of the day
  const k = dayIdx();
  const first = !S.days[k];
  S.days[k] = (S.days[k] || 0) + 1;
  return first;
}

function streakInfo() {
  const today = dayIdx();
  const doneToday = !!S.days[today];
  let d = doneToday ? today : today - 1, n = 0;
  while (S.days[d]) { n++; d--; }
  return { n, doneToday };
}

function weekStrip() {
  const today = dayIdx();
  return Array.from({ length: 7 }, (_, i) => {
    const k = today - 6 + i, n = S.days[k] || 0;
    const d = new Date(k * 864e5);
    const wd = d.toLocaleDateString("uk-UA", { weekday: "short", timeZone: "UTC" });
    return `<span class="${n ? "on" : ""} ${k === today ? "today" : ""}" title="${n} ${plural(n, "відповідь", "відповіді", "відповідей")}">
      <i>${n ? "✓" : ""}</i><small>${wd}</small></span>`;
  }).join("");
}

// Chance to pass a real ticket right now (<= EXAM_MAX_ERRORS errors), from FSRS memory.
// A studied question is answered right if remembered (FSRS retrievability) or, if not, guessed;
// an unseen one only by guessing. The guess rate is this person's own first-try accuracy.
// Each ticket slot draws from its block, so its chance is the block average; the error
// count over the 20 slots is then a sum of independent Bernoullis.
function passChance() {
  let firstN = 0, firstOk = 0;
  for (const l of S.logs) if (l[3] === State.New) { firstN++; if (l[2] !== Rating.Again) firstOk++; }
  const guess = (firstOk + 10) / (firstN + 20);   // prior: 50 % worth 20 answers
  const now = new Date(), sum = {}, cnt = {};
  for (const q of DB.questions) {
    const c = S.cards[q.id];
    let p = guess;
    if (c && c.state !== State.New) {
      const r = scheduler.get_retrievability(c, now, false);
      p = r + (1 - r) * guess;
    }
    sum[q.block] = (sum[q.block] || 0) + p;
    cnt[q.block] = (cnt[q.block] || 0) + 1;
  }
  let dist = Array(EXAM_MAX_ERRORS + 2).fill(0); dist[0] = 1;   // last cell: too many errors
  for (const { block, count } of DB.ticket) {
    const p = cnt[block] ? sum[block] / cnt[block] : guess;
    for (let k = 0; k < count; k++) {
      const next = dist.map(() => 0);
      dist.forEach((v, e) => { next[e] += v * p; next[Math.min(e + 1, dist.length - 1)] += v * (1 - p); });
      dist = next;
    }
  }
  return Math.round(100 * dist.slice(0, -1).reduce((a, b) => a + b, 0));
}

function readyNow() {
  const pct = passChance();
  if (S.day.ready0 === null || S.day.ready0 === undefined) { S.day.ready0 = pct; save(); }
  return { pct, gain: pct - S.day.ready0 };
}

// Early on the chance is near 0 % whatever you do; showing it then only discourages.
const chanceShown = ({ pct }) => S.logs.length >= 20 && (pct >= 5 || S.logs.length >= 300);

function readyHtml({ pct, gain }) {
  const color = pct >= 90 ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--bad)";
  return `
    <div class="ready">
      <div class="row spread"><span>Шанс скласти іспит зараз</span>
        <b style="color:${color}">${pct}%${gain > 0 ? ` <small class="gain">+${gain} сьогодні</small>` : ""}</b></div>
      <div class="bar">${barSpan("ready", pct, "", `background:${color}`)}</div>
    </div>`;
}

function examDaysLeft() {
  if (!S.plan.examDate) return null;
  const exam = new Date(`${S.plan.examDate}T00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((exam - today) / 864e5);
}

function todayGoal() {
  const { learn, review, fresh } = queueCounts();
  const done = S.day.answers || 0, left = learn + review + fresh;
  return { done, left, pct: done + left ? Math.round(100 * done / (done + left)) : 0 };
}

function siteUrl() {
  const c = document.querySelector('link[rel="canonical"]')?.href;
  return c && !c.includes("__SITE__") ? c : location.origin + location.pathname.replace(/index\.html$/, "");
}

async function shareApp(where, text) {
  const url = `${siteUrl()}?src=share_${where}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Тести ПДР — категорія B", text, url });
      ev("share", where, 1);
    } else {
      await navigator.clipboard.writeText(`${text} ${url}`);
      ev("share", where, 0);
      toast("Посилання скопійовано — надішліть його другу");
    }
  } catch (e) { /* share sheet closed */ }
}

// Daily reminder as a calendar file: works with no server and no notification permission.
function downloadReminder(hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const start = new Date(); start.setHours(hh, mm, 0, 0);
  if (start <= new Date()) start.setDate(start.getDate() + 1);
  const left = examDaysLeft();
  const count = Math.min(60, left && left > 0 ? left : 14);
  const p2 = (n) => String(n).padStart(2, "0");
  const local = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const url = `${siteUrl()}?src=ics`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PDRAnkiDeck//UA", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${crypto.randomUUID()}@pdr-b`, `DTSTAMP:${stamp}`,
    `DTSTART:${local(start)}`, "DURATION:PT30M", `RRULE:FREQ=DAILY;COUNT=${count}`,
    "SUMMARY:🚗 ПДР: повторення на сьогодні",
    `DESCRIPTION:Не втрачайте серію днів. ${url}`, `URL:${url}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", "DESCRIPTION:Час повторити ПДР", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = "pdr-nahaduvannia.ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  S.plan.remindAt = hhmm; save();
  ev("ics", hhmm.replace(":", ""), count);
}

// Install to home screen: Chrome/Android hands over a prompt; iOS needs manual steps.
let installEvt = null, installShown = false;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  if (DB && view.name === "home") render();
});
window.addEventListener("appinstalled", () => { installEvt = null; if (S) ev("install_done"); });

function installHtml() {
  if (isStandalone() || (!installEvt && !isIOS())) return "";
  if (S.logs.length < 30 || Date.now() - S.ui.installLaterAt < 3 * 864e5) return "";
  if (!installShown) { installShown = true; ev("install_shown", installEvt ? "prompt" : "ios"); }
  return `
  <section class="card stack">
    <h2>📲 Встановіть на телефон</h2>
    <p class="muted small">Відкривається з головного екрана одним дотиком і працює без інтернету.${installEvt ? "" :
      " Натисніть «Поділитися» внизу Safari → «На початковий екран»."}</p>
    <div class="row">
      ${installEvt ? `<button class="primary grow" data-act="install">Встановити</button>` : ""}
      <button class="grow" data-act="install-later">Не зараз</button>
    </div>
  </section>`;
}

// Number of cards waiting: on the installed app icon and in the tab title while away.
const BASE_TITLE = document.title;
function updateBadge(hidden = document.visibilityState === "hidden") {
  if (!S || !DB) return;
  const { learn, review, fresh } = queueCounts();
  const n = learn + review + fresh;
  try {
    if ("setAppBadge" in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch (e) { /* not supported */ }
  document.title = hidden && n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

function ev(kind, detail = null, n = null) {
  tele.track("events", {
    uid: S.tele.uid, sid: SID, kind, detail: detail === null ? null : cleanTag(String(detail)), n,
    streak: streakInfo().n, day_n: dayN(), local_hour: new Date().getHours(), device: device(),
    standalone: isStandalone(), app_ver: APP_VER,
  });
}

let combo = 0;   // right answers in a row this session (study and drill)
let comboRecord = false;

function trackAnswer(q, mode, chosen, rtMs, rating = null, before = null, extra = {}) {
  sess.answers++;
  tele.track("answers", {
    uid: S.tele.uid, sid: SID, qid: q.id, mode, chosen, correct: chosen === q.a,
    n_options: q.o.length,
    rt_ms: Number.isFinite(rtMs) ? Math.min(3600000, Math.max(0, Math.round(rtMs))) : null,
    rating,
    state: before ? before.state : null,
    stability: before ? before.stability : null,
    difficulty: before ? before.difficulty : null,
    reps: before ? before.reps : null,
    lapses: before ? before.lapses : null,
    elapsed_days: before && before.last_review
      ? Math.max(0, (Date.now() - new Date(before.last_review).getTime()) / 864e5) : null,
    day_n: dayN(), local_hour: new Date().getHours(),
    preset: S.settings.preset, new_per_day: S.settings.newPerDay, retention: S.settings.retention,
    device: device(),
    standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    app_ver: APP_VER,
    ...extra,
  });
}

// ---------- helpers ----------
// Draws a screen. After a screen change (go) focus moves to its heading, so keyboard
// and screen-reader users start at the top of the new screen instead of nowhere.
let focusNext = false;
function h(html) {
  app.innerHTML = html;
  window.scrollTo(0, 0);
  if (focusNext) {
    focusNext = false;
    app.querySelector("h1[tabindex], h2[tabindex], h1, h2")?.focus({ preventScroll: true });
  }
  // Bars are drawn at their previous width, then grow to the new one.
  requestAnimationFrame(() => requestAnimationFrame(() =>
    app.querySelectorAll("[data-w], [data-off]").forEach((el) => {
      if (el.dataset.w) el.style.width = `${el.dataset.w}%`;
      else el.style.strokeDashoffset = el.dataset.off;
    })));
}

const lastBar = {};
function barSpan(key, pct, cls = "", style = "") {
  const from = lastBar[key] ?? pct;
  lastBar[key] = pct;
  return `<span class="${cls}" data-w="${pct}" style="width:${from}%;${style}"></span>`;
}

const motionOn = () => S.prefs.motion && !matchMedia("(prefers-reduced-motion: reduce)").matches;
const applyMotion = () => document.documentElement.classList.toggle("no-motion", !S.prefs.motion);
const confetti = () => { if (motionOn()) confettiRaw(); };

// Screen changes cross-fade; the next question slides in (View Transitions, where supported).
function vt(fn, kind = "nav") {
  if (!document.startViewTransition || !motionOn()) return fn();
  const root = document.documentElement;
  root.dataset.vt = kind;
  const t = document.startViewTransition(fn);
  t.finished.finally(() => { if (root.dataset.vt === kind) delete root.dataset.vt; });
}

function go(v) {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  cancelAuto();
  view = v;
  focusNext = true;
  vt(render);
}

// ---- auto-advance after a right answer ----
const AUTO_MS = 2500;   // long enough to read the verdict and the grade picked
let autoTimer = null;
function armAuto(fn) {
  if (autoTimer) clearTimeout(autoTimer);
  const st = view.state;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (view.state === st && document.visibilityState === "visible") fn();
  }, AUTO_MS);
}
function cancelAuto() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (view?.state?.auto) {
    view.state.auto = false;
    app.querySelectorAll(".auto").forEach((b) => b.classList.remove("auto"));
  }
}

// ---- small rewards ----
const MILESTONES = [50, 100, 250, 500, 1000, 1500];
function checkMilestone() {
  const { known } = progressCounts();
  const hit = [...MILESTONES, DB.questions.length].filter((m) => known >= m).pop();
  if (hit && hit > (S.best.milestone || 0)) {
    S.best.milestone = hit; save();
    toast(hit === DB.questions.length ? "🏆 Усі питання вивчено!" : `🏆 ${hit} питань вивчено!`);
    confetti();
  }
}

function streakToast() {
  const n = streakInfo().n;
  toast(n >= 2 ? `🔥 ${n} ${plural(n, "день", "дні", "днів")} поспіль — серію продовжено!` : "🔥 Перший день серії!");
}

function questionHtml(q) {
  const imgs = q.img.map((n) =>
    `<img class="qimg" src="img/${esc(n)}" alt="${esc(`Малюнок до питання ${q.num}: ${q.t.slice(0, 110)}`)}" loading="eager" decoding="async">`).join("");
  return `
    <div class="qsec">${esc(q.sec)} · №${q.num}${(S.cards[q.id]?.lapses || 0) >= 3
      ? ` <span class="leech" title="Скільки разів ви забули це питання">⚠️ складне · ${S.cards[q.id].lapses}×</span>` : ""}</div>
    <div class="qtext">${esc(q.t)}</div>
    ${imgs}`;
}

// The HSC exam shows the options in a new order every time, so a fixed order here
// would teach "the answer is 3" instead of the answer. Not shuffled: questions whose
// options cite other options by number ("Відповіді 1 і 2", 13 % of the base). Kept in
// place: summary options like "Усе вищеперелічене" / "Жодного з них".
const NUM_REF = /(відповід|варіант)[^.]*\d/i;
// Options that are only picture numbers ("1.", "1 і 4."): shuffled, the badge number and
// the text number disagree ("2 · 1 і 4."), so they keep the base order.
const PIC_NUMS = /^\s*\d+(\s*(,|і|й|та)\s*\d+)*\.?\s*$/;
const SUMMARY = /^(усі|всі|все|усе|жод\S*|обидва|обидві)\b.*(відповід|варіант|перелічен|перерахован|наведен|вище|них)|вищеперелічен|вищеперерахован|вищенаведен/i;
function makePerm(q) {
  const ids = q.o.map((_, i) => i);
  if (!S.prefs.shuffle || q.o.some((o) => NUM_REF.test(o)) || q.o.every((o) => PIC_NUMS.test(o))) return ids;
  const free = ids.filter((i) => !SUMMARY.test(q.o[i]));
  const mixed = shuffle([...free]);
  return ids.map((i) => (free.includes(i) ? mixed.shift() : i));
}
const isShuffled = (perm) => perm.some((v, i) => v !== i);
const shownNo = (perm, i) => (perm ? perm.indexOf(i) : i) + 1;   // number on screen for option i

// data-opt carries the option's index in the base; the number shown is its place on screen.
function optionsHtml(q, { chosen = null, reveal = false, selected = null, perm = null, anim = false } = {}) {
  const order = perm || q.o.map((_, i) => i);
  return `<ul class="opts ${anim ? "just" : ""}">${order.map((i, pos) => {
    let cls = "opt";
    if (reveal) {
      if (i === q.a) cls += " right";
      else if (i === chosen) cls += " wrong";
      else cls += " dim";
    } else if (i === selected) cls += " sel";
    return `<li><button class="${cls}" data-opt="${i}" ${reveal ? "disabled" : ""}>
      <span class="n">${pos + 1}</span><span>${esc(q.o[i])}</span></button></li>`;
  }).join("")}</ul>`;
}

// ---- first-launch tour ----
// Four short cards before the first question: why spaced repetition, what comes first,
// how to answer and grade, and the pace. Shown once to people with no progress yet,
// and again from Settings -> "Як це працює". A modal over the home screen, so the
// home page itself (and its text for search engines) stays as it is.
function tourSlides() {
  const n = DB.questions.length;
  const g = (label, sub, cls = "") => `<span class="tour-grade ${cls}"><b>${label}</b><small>${sub}</small></span>`;
  return [
    { emoji: "🧠", title: "Вчіть розумніше, а не довше",
      body: `<p>Алгоритм <b>FSRS</b> — той самий, що в Anki, — показує кожне питання саме тоді, коли ви от-от його забудете.</p>
        <p>Знайоме повторюється рідше, складне — частіше. Тому всі ${n} питань вкладаються в 1–2 тижні по 2 години на день, без зубріння по колу.</p>` },
    { emoji: "🎯", title: "Спершу — те, що буде в білеті",
      body: `<p>Питання йдуть від тих, що найчастіше трапляються на іспиті, до рідкісних.</p>
        <p><b>Пробний іспит</b> — як у сервісному центрі: 20 питань, 20 хвилин, не більше 2 помилок. А <b>«Шанс скласти»</b> на головній покаже, чи ви вже готові.</p>` },
    { emoji: "✋", title: "Як відповідати",
      body: `<p>Оберіть варіант. Якщо правильно — скажіть, наскільки легко було:</p>
        <div class="tour-grades">${g("Важко", "повторимо скоро")}${g("Добре", "як зазвичай", "on")}${g("Легко", "нескоро")}</div>
        <p>Помилка — питання повернеться за кілька хвилин, а поруч будуть схожі питання, які легко сплутати.</p>
        <p class="note">Коли звикнете, можна ввімкнути автоперехід: алгоритм сам оцінюватиме відповіді за часом і вашою історією.</p>` },
    { emoji: "📅", title: "Скільки часу до іспиту?",
      body: `<div class="seg" role="radiogroup" aria-label="Темп підготовки">${Object.entries(PRESETS).map(([k, p]) =>
          `<button role="radio" aria-checked="${S.settings.preset === k}" data-tour-preset="${k}" class="${S.settings.preset === k ? "on" : ""}">
            ${p.label}<small>${p.newPerDay} нових на день</small></button>`).join("")}</div>
        <p class="note">${esc(PACE_NOTE[S.settings.preset] || PACE_NOTE.custom)} Змінити можна будь-коли в налаштуваннях.</p>` },
  ];
}

function showTour(from = "start") {
  if (typeof HTMLDialogElement !== "function") { S.ui.tourDone = true; save(); return; }
  const slides = tourSlides();
  let i = 0;
  const d = document.createElement("dialog");
  d.className = "sheet tour";
  d.setAttribute("aria-label", "Як це працює");
  const draw = () => {
    const sl = slides[i], last = i === slides.length - 1;
    d.innerHTML = `<div class="sheet-body">
      <div class="tour-dots" aria-hidden="true">${slides.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="tour-emoji" aria-hidden="true">${sl.emoji}</div>
      <h2 tabindex="-1">${sl.title}</h2>
      <div class="tour-body stack">${sl.body}</div>
      <div class="tour-nav">
        ${last ? "" : `<button class="ghost" data-tour="skip">Пропустити</button>`}
        <button class="primary grow" data-tour="next">${last ? (from === "start" ? "Почати навчання" : "Зрозуміло") : "Далі"}</button>
      </div></div>`;
    d.querySelector("h2").focus({ preventScroll: true });
  };
  d.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tourPreset) {
      S.settings = { preset: b.dataset.tourPreset, ...PRESETS[b.dataset.tourPreset] };
      save(); makeScheduler();
      d.querySelectorAll("[data-tour-preset]").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on); x.setAttribute("aria-checked", on);
      });
      d.querySelector(".tour-body .note").textContent = `${PACE_NOTE[b.dataset.tourPreset]} Змінити можна будь-коли в налаштуваннях.`;
      return;
    }
    if (b.dataset.tour === "skip") return d.close("skip");
    if (b.dataset.tour === "next") {
      if (i === slides.length - 1) return d.close("done");
      i++; draw();
    }
  });
  d.addEventListener("close", () => {
    const how = d.returnValue || "skip";
    d.remove();
    S.ui.tourDone = true; save();
    ev("tour", how, i + 1);
    if (how === "done" && from === "start") go({ name: "study" });
    else if (view.name === "home" || view.name === "settings") render();
  });
  document.body.appendChild(d);
  draw();
  d.showModal();
}

// ---- auto-grading (grade.js) ----
const RATING_LABEL = { [Rating.Hard]: "Важко", [Rating.Good]: "Добре", [Rating.Easy]: "Легко" };
const AUTO_OFFER_AFTER = 20;   // right answers graded by hand before auto-advance is offered

// What the person knows of a question, for the neighbour hints: 1 known, 0.5 learning,
// 0 a mistake in the last week, null not seen yet.
function knowOf(id) {
  if (S.wrong[id] && Date.now() - S.wrong[id] < 7 * 864e5) return 0;
  const c = S.cards[id];
  if (!c) return null;
  return c.state === State.Review ? 1 : 0.5;
}

function lastRatingOf(id) {
  for (let i = S.logs.length - 1; i >= 0; i--) if (S.logs[i][0] === id) return S.logs[i][2];
  return null;
}

function autoGrade(q, rtMs) {
  return grader.grade(q, rtMs, {
    model: S.grade, card: S.cards[q.id], lastRating: lastRatingOf(q.id),
    wrongAt: S.wrong[q.id] || null, know: knowOf,
  });
}

// Offered once, after enough grades by hand: by then the algorithm has learnt this
// person's pace and how they grade.
async function offerAuto() {
  if (S.prefs.autoAsked || S.prefs.auto || S.grade.manual < AUTO_OFFER_AFTER) return;
  S.prefs.autoAsked = true; save();
  const yes = await ask("Увімкнути автоперехід?", {
    note: "Після правильної відповіді алгоритм сам оцінить, наскільки легко було — за часом відповіді, "
      + "вашою історією цього питання і схожими питаннями — і натисне «Важко», «Добре» чи «Легко» за вас. "
      + "Ви бачитимете, що він обрав і чому. Вимкнути можна в налаштуваннях.",
    ok: "Так, увімкнути", cancel: "Ні, оцінюватиму сам" });
  S.prefs.auto = yes; save();
  // The time spent on the dialog is not time spent thinking about the card under it.
  if (view.name === "study" && view.state && view.state.chosen === null) view.state.shownAt = activeNow();
  ev("auto_offer", yes ? "yes" : "no", S.grade.manual);
  if (yes) toast("Автоперехід увімкнено");
}

// The question with its options and, once answered, the verdict. Study, drill, topic
// practice and the exam all show a question this way; `right` / `wrong` add a line
// to the verdict, `extra` goes under it (look-alike questions).
function quizCard(q, { chosen, perm, anim = false, right = "", wrong = "", extra = "" }) {
  const answered = chosen !== null && chosen !== undefined;
  const ok = answered && chosen === q.a;
  return `
  <article class="card qcard">
    ${questionHtml(q)}
    ${optionsHtml(q, { chosen, reveal: answered, perm, anim })}
    ${answered ? `<p class="verdict ${ok ? "ok" : "bad"}">${ok ? `Правильно.${right}`
      : `Неправильно. Правильна відповідь — ${shownNo(perm, q.a)}.${wrong}`}</p>` : ""}
    ${answered && !ok ? extra : ""}
  </article>`;
}

// Screen readers hear the verdict once, right after the answer.
function announceVerdict(q, chosen, perm) {
  announce(chosen === q.a ? "Правильно" : `Неправильно. Правильна відповідь ${shownNo(perm, q.a)}: ${q.o[q.a]}`);
}

// ---------- views ----------
const about = document.getElementById("about");

function render() {
  // The static SEO text under the app belongs to the home screen only.
  const home = view.name === "home";
  if (about) about.hidden = !home;
  app.classList.toggle("with-about", home && !!about);
  ({ home: renderHome, study: renderStudy, exam: renderExam, result: renderResult,
     drill: renderDrill, settings: renderSettings,
     search: renderSearch, topic: renderTopic, practice: renderPractice })[view.name]();
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


// Today's goal as a ring: drawn at its previous value, then turns to the new one (see h()).
function ringHtml(pct, done) {
  const C = 2 * Math.PI * 32;
  const off = (p) => (C * (1 - p / 100)).toFixed(1);
  const from = lastBar.ring ?? pct;
  lastBar.ring = pct;
  return `
    <div class="ring" role="img" aria-label="Ціль на сьогодні: ${pct}%">
      <svg viewBox="0 0 80 80" width="80" height="80">
        <circle cx="40" cy="40" r="32" class="ring-bg"/>
        <circle cx="40" cy="40" r="32" class="ring-fg" stroke-dasharray="${C.toFixed(1)}"
          style="stroke-dashoffset:${off(from)}" data-off="${off(pct)}"/>
      </svg>
      <span>${done ? "✓" : `${pct}<small>%</small>`}</span>
    </div>`;
}

function renderHome() {
  const { learn, review, fresh } = queueCounts();
  const tiers = tierStats();
  const total = DB.questions.length;
  const known = tiers.reduce((a, t) => a + t.known, 0);
  const learning = tiers.reduce((a, t) => a + t.learning, 0);
  const wrongCount = Object.keys(S.wrong).length;
  const last = S.exams.slice(-5);
  const ready = last.length === 5 && last.every((e) => e.errors <= 1);
  const todo = learn + review + fresh;
  const unseen = total - Object.keys(S.cards).length;
  const streak = streakInfo();
  const goal = todayGoal();
  const left = examDaysLeft();
  const chance = readyNow();
  const finished = !todo && goal.done > 0;
  updateBadge(false);

  const meta = [];
  // The chip is the date field itself (transparent on top), so the browser opens and
  // closes its own picker: tapping outside or Esc dismisses it as usual.
  if (left === null) meta.push(`<label class="chip date-chip">📅 Коли іспит?
    <input type="date" id="examDateHome" aria-label="Дата іспиту" min="${new Date().toISOString().slice(0, 10)}"></label>`);
  else if (left > 0) meta.push(`<span>До іспиту <b>${left} ${plural(left, "день", "дні", "днів")}</b></span>`);
  else if (left === 0) meta.push(`<span><b>Іспит сьогодні</b> — удачі!</span>`);
  if (chanceShown(chance)) {
    const c = chance.pct >= 90 ? "ok" : chance.pct >= 50 ? "warn" : "bad";
    meta.push(`<span>Шанс скласти <b class="t-${c}">${chance.pct}%</b>${chance.gain > 0 ? ` <small class="gain">+${chance.gain}</small>` : ""}</span>`);
  }
  const slowTip = left !== null && left > 0 && left <= 7 && S.settings.preset === "two" && unseen > 300;

  const examDots = Array.from({ length: 5 }, (_, i) => {
    const e = last[i];
    return `<i class="${!e ? "" : e.errors <= 1 ? "ok" : e.passed ? "warn" : "bad"}"></i>`;
  }).join("");

  h(`
  <header class="top">
    <h1 class="brand" tabindex="-1">ПДР <span>· категорія B</span></h1>
    ${streak.n ? `<span class="streak ${streak.doneToday ? "" : "risk"}" title="Днів поспіль"
      aria-label="${streak.n} ${plural(streak.n, "день", "дні", "днів")} поспіль">🔥 ${streak.n}</span>` : ""}
    <button class="icon-btn" data-go="settings" aria-label="Налаштування" title="Налаштування">${ICON.gear}</button>
  </header>
  <button class="search-bar" data-go="search">${ICON.search} Пошук питань і тем</button>
  <div class="stack">
    ${outcomeHtml()}
    <section class="card hero">
      <div class="hero-row">
        ${ringHtml(finished ? 100 : goal.pct, finished)}
        <div class="hero-text">
          <h2>${finished ? "Ціль виконано" : goal.done ? "Продовжимо" : "Сьогодні"}</h2>
          <p class="muted">${todo
            ? `${fresh ? `${fresh} ${plural(fresh, "нове", "нових", "нових")}` : ""}${fresh && learn + review ? " · " : ""}${learn + review
              ? `${learn + review} ${plural(learn + review, "повторення", "повторення", "повторень")}` : ""}`
            : unseen ? "Можна взяти ще нових" : "Усі питання пройдено"}</p>
        </div>
      </div>
      ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
      ${slowTip ? `<p class="small risk-note">Часу мало — увімкніть темп «1 тиждень» у <a href="#" data-go="settings">налаштуваннях</a>.</p>` : ""}
      ${streak.n && !streak.doneToday ? `<p class="small risk-note">Дайте хоч одну відповідь до ${String(DAY_START_HOUR).padStart(2, "0")}:00, щоб не втратити серію.</p>` : ""}
      ${todo || !unseen
        ? `<button class="primary block big" data-go="study" ${todo ? "" : "disabled"}>${goal.done && todo ? "Продовжити" : "Вчити"}</button>`
        : `<button class="primary block big" data-act="bonus">Ще 20 нових питань</button>`}
      <div class="week" aria-label="Активність за тиждень">${weekStrip()}</div>
    </section>
    ${installHtml()}

    <div class="tiles">
      <button class="tile" data-go="exam">
        <span class="tile-title">Пробний іспит</span>
        <span class="tile-sub">${ready ? "✅ Готові до справжнього" : "20 питань · 20 хв"}</span>
        <span class="exam-dots" title="Останні 5 іспитів">${examDots}</span>
      </button>
      <button class="tile" data-go="drill" ${wrongCount ? "" : "disabled"}>
        <span class="tile-title">Помилки</span>
        <span class="tile-sub">${wrongCount ? "Повторити" : "Поки немає"}</span>
        <span class="tile-num ${wrongCount ? "t-bad" : ""}">${wrongCount}</span>
      </button>
    </div>

    <section class="card stack">
      <div class="row spread"><h2>Прогрес</h2>
        <span class="muted small">${known ? `${Math.round(100 * known / total)}% вивчено`
          : `розпочато ${known + learning} з ${total}`}</span></div>
      <div class="bar">
        <span class="b-known" style="width:${100 * known / total}%"></span>
        <span class="b-learn" style="width:${100 * learning / total}%"></span>
      </div>
      <div class="legend">
        <span><i class="k"></i>${known} вивчено</span>
        <span><i class="l"></i>${learning} вчу</span>
        <span><i></i>${total - known - learning} нових</span>
      </div>
      <details class="tiers">
        <summary>За темами</summary>
        ${tiers.map((t) => `
          <div class="tier">
            <div class="row spread"><span class="name">${esc(t.name)}</span>
              <span class="num">${t.known + t.learning}/${t.total}</span></div>
            <div class="bar">
              <span class="b-known" style="width:${100 * t.known / t.total}%"></span>
              <span class="b-learn" style="width:${100 * t.learning / t.total}%"></span>
            </div>
          </div>`).join("")}
      </details>
    </section>
    ${saveFailed ? `<p class="small text-bad">Браузер не дає зберегти прогрес (приватний режим?). Він зникне після закриття вкладки.</p>` : ""}
  </div>`);
}

const OUTCOMES = [
  ["passed_first", "Склав з першої спроби"],
  ["passed_retry", "Склав, але не з першої"],
  ["failed", "Не склав"],
  ["not_yet", "Ще не складав"],
];
const FINAL_OUTCOME = (o) => o && o !== "not_yet";

function outcomeHtml() {
  const t = S.tele;
  if (!tele.configured || !t.on || FINAL_OUTCOME(t.outcome)) return "";
  if (t.outcome === "not_yet" && Date.now() - t.outcomeAt < 3 * 864e5) return "";
  const left = examDaysLeft();
  if (left !== null && left > 0) return "";
  if (left === null && dayN() < 5 && S.exams.length < 3) return "";
  return `
  <section class="card stack">
    <h2>Як пройшов справжній іспит?</h2>
    <p class="muted small">Одна відповідь — і ми зрозуміємо, що в підготовці справді допомагає.</p>
    <div class="stack">${OUTCOMES.map(([k, label]) =>
      `<button class="block" data-outcome="${k}">${label}</button>`).join("")}</div>
  </section>`;
}

// Look-alike questions with another right answer (similar.py), shown after a mistake:
// seeing the twins side by side is what stops mixing them up.
function twinsHtml(q) {
  const twins = (q.sim || []).map((id) => byId[id]).filter(Boolean).slice(0, 2);
  if (!twins.length) return "";
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  return `
    <div class="twins">
      <p class="twins-h">Не сплутайте: ${twins.length > 1 ? "схожі питання" : "схоже питання"} з іншою відповіддю</p>
      ${twins.map((t) => `
        <details class="twin" data-twin="${esc(t.id)}">
          <summary>${t.img[0] ? `<img class="thumb" src="img/${esc(t.img[0])}" alt="" loading="lazy">` : ""}
            <span>${esc(clip(t.t, 120))}</span></summary>
          <div class="twin-body">
            ${t.img.map((n) => `<img class="qimg" src="img/${esc(n)}" alt="Малюнок до схожого питання" loading="lazy">`).join("")}
            ${optionsHtml(t, { reveal: true })}
          </div>
        </details>`).join("")}
    </div>`;
}

function comboHtml() {
  if (combo < 3) return "";
  return ` <span class="combo">🔥 ${combo} поспіль${comboRecord ? " · рекорд!" : ""}</span>`;
}

// ---- study ----
function renderStudy() {
  const pick = view.current || nextCard();
  if (!pick.id) return renderStudyDone(pick.nextAt);
  view.current = pick;
  const q = byId[pick.id];
  const { learn, review, fresh } = queueCounts();
  const goal = todayGoal();
  const st = view.state || { chosen: null, shownAt: activeNow(), perm: makePerm(q) };
  view.state = st;
  const answered = st.chosen !== null;
  const correct = answered && st.chosen === q.a;
  const autoOn = answered && correct && st.auto;
  // With auto-advance the algorithm's grade is the highlighted button that fills up;
  // by hand "Добре" is the default, as in Anki.
  const pickR = autoOn && st.g ? st.g.rating : Rating.Good;
  let actions = "";
  if (answered) {
    const iv = previewIntervals(q.id);
    actions = correct
      ? `<div class="grades">${[Rating.Hard, Rating.Good, Rating.Easy].map((r) =>
           `<button class="${r === pickR ? `primary ${autoOn ? "auto" : ""}` : ""}" data-rate="${r}" style="--auto:${AUTO_MS}ms">${
             RATING_LABEL[r]}<small>${iv[r]}</small></button>`).join("")}
         </div>`
      : `<button class="primary block big" data-rate="${Rating.Again}">Далі · знову через ${iv[Rating.Again]}</button>`;
  } else if (view.undo) {
    actions = `<button class="ghost undo" data-act="undo">↶ Скасувати попередню відповідь</button>`;
  }
  // Anki's three counters, each with a caption: people who never used Anki read them too.
  const counter = (cls, kind, n, label) =>
    `<span class="${cls} ${pick.kind === kind ? "on" : ""}">${n}<small>${label}</small></span>`;
  h(`
  ${topBar({ right: `<div class="counts" aria-label="Нових ${fresh}, на навчанні ${learn}, повторень ${review}">
      ${counter("c-new", "new", fresh, "нові")}${counter("c-learn", "learn", learn, "вчу")}${counter("c-review", "review", review, "повт.")}
    </div>` })}
  <div class="bar thin" role="progressbar" aria-label="Ціль на сьогодні" aria-valuenow="${goal.pct}" aria-valuemin="0" aria-valuemax="100"
    title="Ціль на сьогодні: ${goal.done} з ${goal.done + goal.left}">${barSpan("goal", goal.pct, "b-known")}</div>
  ${quizCard(q, { chosen: st.chosen, perm: st.perm, anim: st.anim,
    right: `${comboHtml()}<span class="hint">${autoOn
      ? `Оцінка «${RATING_LABEL[pickR]}»: ${st.g.reason}. Далі за мить — торкніться картки, щоб зупинитися, або оцініть самі.`
      : "Наскільки легко було?"}</span>`,
    extra: twinsHtml(q) })}
  ${dock(actions)}`);
}

// Nothing due right now: a break until the next learning step, or the day is done.
function renderStudyDone(soon) {
  const unseen = DB.questions.length - Object.keys(S.cards).length;
  const done = S.day.answers || 0, ok = S.day.correct || 0;
  const streak = streakInfo();
  const chance = readyNow();
  if (!soon && done && !S.day.goalDone) {
    S.day.goalDone = true; save(); ev("goal_done", null, done);
    setTimeout(confetti, 150);
  }
  const at = S.plan.remindAt || `${String(new Date().getHours()).padStart(2, "0")}:00`;
  h(`
  ${topBar({ title: "Навчання" })}
  ${emptyState({
    emoji: soon ? "⏳" : "🎉",
    title: soon ? "Перерва" : "Ціль на сьогодні виконано",
    text: soon
      ? `Наступна картка на навчанні — о ${new Date(soon).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}.`
      : "Нові картки й повторення на сьогодні закінчилися.",
    body: `${done ? `<div class="stat-grid">
        <div><b>${done}</b><span>${plural(done, "відповідь", "відповіді", "відповідей")}</span></div>
        <div><b>${Math.round(100 * ok / done)}%</b><span>правильно</span></div>
        <div><b>🔥 ${streak.n}</b><span>${plural(streak.n, "день", "дні", "днів")} поспіль</span></div>
      </div>` : ""}
      ${chanceShown(chance) ? readyHtml(chance) : ""}`,
    actions: `
      ${soon ? `<button class="primary block" data-act="study-now">Показати зараз</button>` : ""}
      <button class="${soon ? "" : "primary"} block" data-go="exam">Пробний іспит</button>
      ${unseen ? `<button class="block" data-act="bonus">Ще 20 нових питань</button>` : ""}
      ${!soon && !S.plan.remindAt ? `<button class="block" data-act="remind" data-at="${at}">📅 Нагадувати щодня о ${at}</button>` : ""}
      ${!soon ? `<button class="ghost block" data-act="share" data-where="done">Порадити другу</button>` : ""}`,
  })}`);
}

// ---- exam ----
function newExam() {
  const pools = {};
  for (const q of DB.questions) (pools[q.block] ||= []).push(q.id);
  const ids = [];
  for (const { block, count } of DB.ticket) ids.push(...shuffle([...pools[block]]).slice(0, count));
  return { ids, answers: Array(ids.length).fill(null), i: 0, perms: ids.map((id) => makePerm(byId[id])),
           startedAt: Date.now(), shownAt: activeNow(),
           endsAt: Date.now() + EXAM_MINUTES * 60e3 };
}

// Works like the HSC exam (hsc.gov.ua, 12.02.2026): each answer is marked right or
// wrong at once, the number strip turns green/red, and a question can be skipped
// and answered later while time remains.
function renderExam() {
  if (!view.exam) view.exam = newExam();
  const ex = view.exam;
  if (Date.now() >= ex.endsAt) return finishExam(true);
  const q = byId[ex.ids[ex.i]];
  const chosen = ex.answers[ex.i];
  const answered = chosen !== null;
  const errors = ex.ids.reduce((n, id, i) => n + (ex.answers[i] !== null && ex.answers[i] !== byId[id].a ? 1 : 0), 0);
  const left = ex.answers.filter((a) => a === null).length;
  const dots = ex.ids.map((id, i) => {
    const a = ex.answers[i];
    const cls = a === null ? "" : a === byId[id].a ? "ok" : "bad";
    return `<button class="dot ${cls} ${i === ex.i ? "cur" : ""}" data-jump="${i}" aria-label="Питання ${i + 1}">${i + 1}</button>`;
  }).join("");
  let action;
  if (!left) action = `<button class="primary block big" data-act="exam-finish">Завершити іспит</button>`;
  else if (answered) action = `<button class="primary block big" data-act="exam-next">Далі</button>`;
  else action = `<button class="block" data-act="exam-next" ${left > 1 ? "" : "disabled"}>Пропустити</button>`;
  const errCls = errors > EXAM_MAX_ERRORS ? "t-bad" : errors ? "t-warn" : "";
  h(`
  ${topBar({ back: 'data-act="exam-quit"', close: true, title: `Питання ${ex.i + 1} з ${ex.ids.length}`,
    sub: `<span class="${errCls}">${errors} ${plural(errors, "помилка", "помилки", "помилок")}</span> з ${EXAM_MAX_ERRORS} допустимих`,
    right: `<span class="timer" id="timer" role="timer" aria-label="Залишилось часу"></span>` })}
  <div class="dots">${dots}</div>
  ${quizCard(q, { chosen, perm: ex.perms?.[ex.i], anim: ex.anim === ex.i })}
  ${dock(action)}`);
  if (answered) app.querySelector(".opt.right")?.scrollIntoView({ block: "center" });
  tick();
  timerHandle = setInterval(tick, 1000);
}

function examGoto(i) {
  const ex = view.exam;
  ex.i = i;
  ex.shownAt = activeNow();
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  vt(renderExam, "next");
}

function nextUnanswered(ex) {
  for (let k = 1; k <= ex.ids.length; k++) {
    const i = (ex.i + k) % ex.ids.length;
    if (ex.answers[i] === null) return i;
  }
  return null;
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
  document.querySelectorAll("dialog.sheet[open]").forEach((d) => d.close(""));   // e.g. "Вийти з іспиту?"
  const errors = ex.ids.reduce((n, id, i) => n + (ex.answers[i] !== byId[id].a ? 1 : 0), 0);
  ex.ids.forEach((id, i) => { if (ex.answers[i] !== byId[id].a) S.wrong[id] = Date.now(); });
  const rec = { at: Date.now(), errors, total: ex.ids.length, passed: errors <= EXAM_MAX_ERRORS, timeout };
  S.exams.push(rec);
  save();
  tele.track("exams", {
    uid: S.tele.uid, sid: SID, errors, total: ex.ids.length, passed: rec.passed, timeout,
    duration_s: Math.min(7200, Math.round((Date.now() - ex.startedAt) / 1000)),
    wrong_qids: ex.ids.filter((id, i) => ex.answers[i] !== byId[id].a),
    day_n: dayN(), local_hour: new Date().getHours(), ...progressCounts(),
    device: device(), app_ver: APP_VER,
    abandoned: false, answered: ex.answers.filter((a) => a !== null).length, quit_at: null, quit_qid: null,
  });
  tele.flush();
  go({ name: "result", exam: ex, rec });
}

function renderResult() {
  const { exam: ex, rec } = view;
  if (rec.passed && !view.celebrated) { view.celebrated = true; setTimeout(confetti, 200); }
  const wrong = ex.ids.map((id, i) => ({ q: byId[id], chosen: ex.answers[i] }))
    .filter((x) => x.chosen !== x.q.a);
  h(`
  ${topBar({ title: "Результат іспиту" })}
  <section class="card stack result">
    <div class="emoji" aria-hidden="true">${rec.passed ? "✅" : "❌"}</div>
    <div class="result-big">${rec.total - rec.errors}/${rec.total}</div>
    <h2 tabindex="-1">${rec.passed ? "Іспит складено" : "Іспит не складено"}</h2>
    <p class="muted">${rec.errors} ${plural(rec.errors, "помилка", "помилки", "помилок")}${rec.timeout ? " · час вичерпано" : ""}.
      Допускається не більше ${EXAM_MAX_ERRORS}.</p>
    <div class="actions two">
      <button class="primary" data-go="exam">Ще один іспит</button>
      <button data-go="home">На головну</button>
    </div>
    ${rec.passed ? `<button class="ghost block" data-act="share" data-where="exam"
      data-text="Склав(ла) пробний іспит ПДР на ${rec.total - rec.errors}/${rec.total} 🚗 Готуюся безкоштовно тут:">Поділитися результатом</button>` : ""}
  </section>
  ${wrong.length ? `<h2 class="section-h">Розбір помилок <span class="muted">${wrong.length}</span></h2>
  <div class="stack">${wrong.map(({ q, chosen }) => `
    <article class="card">${questionHtml(q)}${optionsHtml(q, { chosen, reveal: true, perm: ex.perms?.[ex.ids.indexOf(q.id)] })}
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
    ${topBar({ title: "Помилки" })}
    ${emptyState({ emoji: "🎉", title: "Помилок не лишилося",
      text: "Кожне питання з помилкою ви тепер відповіли правильно.",
      actions: `<button class="primary block" data-go="home">На головну</button>` })}`);
    return;
  }
  const q = byId[id];
  const st = view.state || { chosen: null, shownAt: activeNow(), perm: makePerm(q) };
  view.state = st;
  const answered = st.chosen !== null;
  const auto = answered && st.chosen === q.a && st.auto;
  h(`
  ${topBar({ title: "Робота над помилками", sub: `лишилось ${view.queue.length}` })}
  ${quizCard(q, { chosen: st.chosen, perm: st.perm, anim: st.anim,
    right: ` Питання прибрано зі списку.${comboHtml()}`, wrong: " Питання повториться.", extra: twinsHtml(q) })}
  ${dock(answered ? `<button class="primary block big ${auto ? "auto" : ""}" style="--auto:${AUTO_MS}ms" data-act="drill-next">Далі</button>` : "")}`);
}

// ---- settings ----
const PACE_NOTE = {
  two: "~2–2,5 год на день. За 10 днів пройдете всю базу, далі — повторення.",
  one: "~4–5 год на день: 5 днів нових питань і 2 дні повторення. Інтервали не довші за 3 дні.",
  custom: "Свій темп: параметри змінено вручну.",
};
// Every field saves on change; there is no "Save" button to forget.
function renderSettings() {
  const s = S.settings;
  const custom = !PRESETS[s.preset];
  h(`
  ${topBar({ title: "Налаштування" })}
  <div class="stack">
    <section class="card stack">
      <h2>Скільки часу до іспиту</h2>
      <div class="seg" role="radiogroup" aria-label="Темп підготовки">${Object.entries(PRESETS).map(([k, p]) =>
        `<button role="radio" aria-checked="${s.preset === k}" data-preset="${k}" class="${s.preset === k ? "on" : ""}">
          ${p.label}<small>${p.newPerDay} нових на день</small></button>`).join("")}</div>
      <p class="note" id="paceNote">${PACE_NOTE[s.preset] || PACE_NOTE.custom}</p>
      <details class="more" ${custom ? "open" : ""}>
        <summary>Додатково: параметри FSRS</summary>
        <label class="field"><span>Нових карток на день</span>
          <input type="number" inputmode="numeric" id="newPerDay" min="0" max="2000" value="${s.newPerDay}"></label>
        <label class="field"><span>Бажана утримуваність</span>
          <select id="retention">${[0.85, 0.9, 0.92, 0.95].map((r) =>
            `<option value="${r}" ${s.retention === r ? "selected" : ""}>${Math.round(r * 100)} %</option>`).join("")}</select></label>
        <label class="field"><span>Максимальний інтервал, днів</span>
          <input type="number" inputmode="numeric" id="maxIvl" min="1" max="36500" value="${s.maxIvl}"></label>
        <p class="note">FSRS-6, як в Anki, зі стандартними параметрами. Кроки навчання: ${esc(s.steps.join(" "))},
          повторне навчання: 10m. Зміни зберігаються одразу.</p>
      </details>
    </section>

    <section class="card stack">
      <h2>Навчання</h2>
      ${[["shuffle", "Перемішувати варіанти відповідей", "Як на іспиті в сервісному центрі: запам'ятовуєте відповідь, а не її номер. Питання з варіантами «Відповіді 1 і 2» не перемішуються."],
         ["auto", "Автоперехід після правильної відповіді", `Алгоритм сам ставить «Важко», «Добре» чи «Легко» — за часом відповіді, вашою історією цього питання і схожими питаннями — і через ${String(AUTO_MS / 1000).replace(".", ",")} с переходить далі. Торкніться картки, щоб зупинити, або оцініть самі.`],
         ["motion", "Анімації", "Переходи між питаннями, конфеті за досягнення."]].map(([k, title, note]) => `
        <div class="pref">
          <div id="pref-${k}"><b>${title}</b><p class="note">${note}</p></div>
          <button class="switch ${S.prefs[k] ? "on" : ""}" data-pref="${k}" role="switch" aria-checked="${S.prefs[k]}" aria-labelledby="pref-${k}"><span></span></button>
        </div>`).join("")}
    </section>

    <section class="card stack">
      <h2>Іспит і нагадування</h2>
      <label class="field"><span>Дата іспиту в сервісному центрі</span>
        <input type="date" id="examDate" value="${S.plan.examDate || ""}"></label>
      <label class="field"><span>Нагадування щодня о</span>
        <input type="time" id="remindAt" value="${S.plan.remindAt || "19:00"}"></label>
      <button class="block" data-act="remind">📅 Додати нагадування в календар</button>
      <p class="note">Файл .ics для вашого календаря: щодня до дати іспиту, або 14 днів, якщо дату не вказано.</p>
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
      <div class="actions two">
        <button data-act="export">Експорт</button>
        <label class="btn">Імпорт<input type="file" id="importFile" accept="application/json" hidden></label>
      </div>
      <button class="block text-bad" data-act="reset">Скинути весь прогрес</button>
    </section>
    <button class="block" data-act="tour">Як це працює</button>
    <footer><p><a href="privacy.html">Конфіденційність</a> · <a href="https://github.com/punjet/PDRAnkiDeck">GitHub</a></p></footer>
  </div>`);
}

// Pace fields under "Додатково": any edit turns the preset into "custom".
function saveSettingField(el) {
  const num = (lo, hi, d) => {
    const v = Number(el.value);
    return Number.isFinite(v) && el.value !== "" ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  };
  const s = { ...S.settings };
  if (el.id === "newPerDay") s.newPerDay = num(0, 2000, s.newPerDay);
  if (el.id === "retention") s.retention = Number(el.value);
  if (el.id === "maxIvl") s.maxIvl = num(1, 36500, s.maxIvl);
  if (el.type === "number") el.value = s[el.id];   // show the clamped value
  if (s.newPerDay === S.settings.newPerDay && s.retention === S.settings.retention && s.maxIvl === S.settings.maxIvl) return;
  S.settings = { ...s, preset: "custom" };
  save(); makeScheduler();
  // Only the parts that show the preset change; a full redraw would steal focus and the next tap.
  app.querySelectorAll("[data-preset]").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-checked", "false"); });
  const note = document.getElementById("paceNote");
  if (note) note.textContent = PACE_NOTE.custom;
  toast("Збережено");
}

// ---------- search and topics ----------
// Topics come from topics.py (questions grouped by meaning and named by an LLM, with
// synonyms people type, Russian included). Search is plain word search with MiniSearch:
// offline, instant, forgiving to typos and word endings.
let topicById = {}, qIndex = null, tIndex = null, searchQuery = "", searchHits = [];

// One spelling for Ukrainian and Russian forms of a word: і/и/ы/е/є/э all become "и", so
// "обгон" finds "обгін", "светофор" finds "світлофор", "кресло" finds "крісло"; fuzzy
// matching covers the rest. Words that differ more ("детское" / "дитяче") are found
// through the keywords topics.py wrote for each question in both languages.
const FOLD = { "і": "и", "ї": "и", "ы": "и", "е": "и", "є": "и", "э": "и", "ё": "и", "ґ": "г", "ъ": "", "ь": "", "'": "", "’": "", "ʼ": "" };
const STOP = new Set(["і", "й", "в", "у", "на", "з", "із", "зі", "до", "що", "як", "чи", "при", "для", "за", "не", "та",
  "а", "або", "від", "по", "це", "ви", "вам", "вас", "и", "с", "о", "об", "к"]);
function foldTerm(term) {
  const t = term.toLowerCase();
  if (STOP.has(t) || t.length < 2) return null;
  return t.replace(/[іїыеєэёґъь'’ʼ]/g, (c) => FOLD[c]);
}
const fuzzyOf = (term) => (term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0);

function buildSearch() {
  topicById = Object.fromEntries((DB.topics || []).map((t) => [t.id, t]));
  qIndex = new MiniSearch({
    fields: ["t", "kw", "ans", "o", "sec"], storeFields: [], processTerm: foldTerm,
    searchOptions: { boost: { t: 3, kw: 2.5, ans: 2, o: 1, sec: 0.5 }, prefix: (t) => t.length >= 3, fuzzy: fuzzyOf, processTerm: foldTerm },
  });
  qIndex.addAll(DB.questions.map((q) => ({ id: q.id, t: q.t, kw: (q.kw || []).join(" "), ans: q.o[q.a], o: q.o.join(" "), sec: q.sec })));
  if (DB.topics?.length) {
    tIndex = new MiniSearch({
      fields: ["name", "syn", "desc", "group"], processTerm: foldTerm,
      searchOptions: { boost: { name: 4, syn: 3, desc: 1, group: 1 }, prefix: (t) => t.length >= 3, fuzzy: fuzzyOf, processTerm: foldTerm },
    });
    tIndex.addAll(DB.topics.map((t) => ({ id: t.id, name: t.name, syn: t.syn.join(" "), desc: t.desc, group: t.group })));
  }
}

function runSearch(query) {
  const all = (idx) => {
    if (!idx || !query.trim()) return [];
    const hits = idx.search(query, { combineWith: "AND" });
    return hits.length ? hits : idx.search(query, { combineWith: "OR" });   // all words first, then any
  };
  const topics = all(tIndex).slice(0, 4).map((h) => topicById[h.id]);
  // Questions of a matching topic count too, even when the word is not in their text.
  const seen = new Set();
  const qs = [];
  for (const h of all(qIndex)) { if (!seen.has(h.id)) { seen.add(h.id); qs.push(byId[h.id]); } }
  for (const t of topics.slice(0, 1)) for (const id of t.q) if (!seen.has(id) && byId[id]) { seen.add(id); qs.push(byId[id]); }
  return { topics, qs };
}

function topicProgress(t) {
  let known = 0;
  for (const id of t.q) if (S.cards[id]?.state === State.Review) known++;
  return { known, total: t.q.length, pct: Math.round(100 * known / t.q.length) };
}

// Practice order inside a topic: past mistakes, then unseen and still learning, then known.
function topicOrder(t) {
  const rank = (id) => (S.wrong[id] ? 0 : S.cards[id]?.state === State.Review ? 2 : 1);
  return shuffle([...t.q].filter((id) => byId[id])).sort((a, b) => rank(a) - rank(b));
}

// Where "← Назад" returns to; the search view keeps its query.
const backOf = (v) => (v.name === "search" ? { name: "search" } : v.name === "topic" ? { name: "topic", id: v.id, back: v.back } : { name: v.name });

const secShort = (q) => q.sec.match(/^Розділ\s+(\d+(?:\.\d+)*)/)?.[1] || "";

function questionRow(q, practiceKey) {
  const c = S.cards[q.id];
  const mark = S.wrong[q.id] ? `<i class="st bad" title="Є помилка"></i>`
    : c?.state === State.Review ? `<i class="st ok" title="Вивчено"></i>` : c ? `<i class="st warn" title="Вчите"></i>` : "";
  return `<li><button class="sec" data-practice="${esc(practiceKey)}">
    <span class="sec-no">${esc(secShort(q))}</span>
    <span class="sec-name">${esc(clipText(q.t, 130))}<small>№${esc(q.num)}${q.img.length ? " · з малюнком" : ""}</small></span>${mark}
  </button></li>`;
}

function topicRow(t) {
  const p = topicProgress(t);
  return `<li><button class="sec" data-topic="${t.id}">
    <span class="sec-name">${esc(t.name)}<small>${p.total} ${plural(p.total, "питання", "питання", "питань")}${p.known ? ` · вивчено ${p.pct}%` : ""}</small></span>
    ${p.known ? `<span class="mini-ring" style="--p:${p.pct}"></span>` : ""}
  </button></li>`;
}

function renderSearch() {
  h(`
  ${topBar({ title: "Пошук" })}
  <div class="search-box" role="search">
    <input id="q" type="search" inputmode="search" autocomplete="off" enterkeyhint="search"
      placeholder="обгін, трамвай, знак «Стоп», аварійка…" value="${esc(searchQuery)}" aria-label="Пошук питань і тем">
  </div>
  <div id="results"></div>`);
  renderSearchResults();
  const input = document.getElementById("q");
  if (!searchQuery) input.focus({ preventScroll: true });
}

let searchLogTimer = null;
function renderSearchResults() {
  const box = document.getElementById("results");
  if (!box) return;
  const q = searchQuery.trim();
  if (!q) {
    searchHits = [];
    box.innerHTML = DB.topics?.length ? browseHtml()
      : `<p class="muted small search-hint">Шукайте за словами з питання або відповіді. Можна з помилками й російською.</p>`;
    return;
  }
  const { topics, qs } = runSearch(q);
  searchHits = qs;
  const shown = qs.slice(0, 60);
  box.innerHTML = `
    ${topics.length ? `<h2 class="res-h">Теми</h2><ol class="seclist">${topics.map(topicRow).join("")}</ol>` : ""}
    ${qs.length ? `<h2 class="res-h">Питання <span class="muted">${qs.length}</span></h2>
      <ol class="seclist">${shown.map((x) => questionRow(x, x.id)).join("")}</ol>
      ${qs.length > shown.length ? `<p class="muted small search-hint">Показано ${shown.length} з ${qs.length}. Уточніть запит.</p>` : ""}`
    : topics.length ? "" : `<div class="empty-state"><p class="emoji" aria-hidden="true">🔍</p><p class="muted">Нічого не знайдено. Спробуйте інше слово або коротшу форму: «обго», «розвор».</p></div>`}`;
  // Only how many results came back is logged, never the text typed.
  clearTimeout(searchLogTimer);
  searchLogTimer = setTimeout(() => ev("search", qs.length || topics.length ? "found" : "none", qs.length), 1500);
}

function browseHtml() {
  const groups = [];
  for (const t of DB.topics) {
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push(g = { name: t.group, topics: [] });
    g.topics.push(t);
  }
  return `<p class="muted small search-hint">Або оберіть тему:</p>
    ${groups.map((g) => `
      <details class="group">
        <summary>${esc(g.name)} <span class="muted">${g.topics.length}</span></summary>
        <ol class="seclist">${g.topics.map(topicRow).join("")}</ol>
      </details>`).join("")}`;
}

function renderTopic() {
  const t = topicById[view.id];
  if (!t) return go({ name: "search" });
  const p = topicProgress(t);
  const ids = topicOrder(t);
  h(`
  ${topBar({ back: 'data-act="back"', title: esc(t.group) })}
  <section class="card stack">
    <h2 class="topic-h" tabindex="-1">${esc(t.name)}</h2>
    <p class="muted">${esc(t.desc)}</p>
    <div class="bar">${barSpan(`topic-${t.id}`, p.pct, "b-known")}</div>
    <p class="small muted">Вивчено ${p.known} з ${p.total}</p>
    <button class="primary block big" data-practice="all">Тренувати тему · ${p.total} ${plural(p.total, "питання", "питання", "питань")}</button>
    <p class="note">Спершу ваші помилки, потім нові. Розклад повторень не змінюється, а помилки потраплять у «Помилки».</p>
  </section>
  <ol class="seclist topic-list">${ids.map((id) => questionRow(byId[id], id)).join("")}</ol>`);
}

function renderPractice() {
  const id = view.ids[view.i];
  if (!id || view.done) {
    const n = Object.keys(view.results).length, ok = Object.values(view.results).filter(Boolean).length;
    h(`
    ${topBar({ back: 'data-act="back"', title: esc(view.title) })}
    ${emptyState({ emoji: n && ok === n ? "🎉" : "✅", title: n ? `${ok} з ${n} правильно` : "Готово",
      text: n && ok < n ? "Помилки додано в «Помилки» на головній." : "",
      actions: `<button class="primary block" data-act="practice-again">Ще раз</button>
        <button class="block" data-act="back">Назад</button>` })}`);
    if (n >= 5 && ok === n) setTimeout(confetti, 150);
    return;
  }
  const q = byId[id];
  const st = view.state || { chosen: null, shownAt: activeNow(), perm: makePerm(q) };
  view.state = st;
  const answered = st.chosen !== null;
  const auto = answered && st.chosen === q.a && st.auto;
  h(`
  ${topBar({ back: 'data-act="back"', title: esc(view.title), sub: `${view.i + 1} з ${view.ids.length}` })}
  <div class="bar thin">${barSpan("practice", Math.round(100 * view.i / view.ids.length), "b-known")}</div>
  ${quizCard(q, { chosen: st.chosen, perm: st.perm, anim: st.anim, right: comboHtml(), extra: twinsHtml(q) })}
  ${dock(answered ? `<button class="primary block big ${auto ? "auto" : ""}" style="--auto:${AUTO_MS}ms" data-act="practice-next">${
      view.i + 1 < view.ids.length ? "Далі" : "Завершити"}</button>` : "")}`);
}

function practiceNext() {
  cancelAuto();
  view.state = null;
  if (view.i + 1 >= view.ids.length) view.done = true; else view.i++;
  vt(render, "next");
}

// ---------- events ----------
app.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-go], [data-act]");
  if (!t || t.disabled) return;
  if (t.tagName === "A") e.preventDefault();
  if (t.dataset.go) {
    const v = { name: t.dataset.go };
    if (v.name === "exam" && view.name === "exam" && view.exam
      && !(await ask("Почати новий іспит? Поточний не буде зараховано.", { ok: "Почати новий" }))) return;
    return go(v);
  }
  if (t.dataset.opt !== undefined) return pickOption(Number(t.dataset.opt));
  if (t.dataset.jump !== undefined) return examGoto(Number(t.dataset.jump));
  if (t.dataset.rate !== undefined) return doRate(Number(t.dataset.rate));
  if (t.dataset.preset) {
    const p = PRESETS[t.dataset.preset];
    S.settings = { preset: t.dataset.preset, ...p };
    save(); makeScheduler(); return render();
  }
  if (t.dataset.outcome) {
    S.tele.outcome = t.dataset.outcome;
    S.tele.outcomeAt = Date.now();
    save();
    tele.track("outcomes", {
      uid: S.tele.uid, result: t.dataset.outcome, day_n: dayN(), ...progressCounts(),
      reviews: S.logs.length, mock_exams: S.exams.length, app_ver: APP_VER,
    });
    tele.flush();
    return render();
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
  if (act === "exam-next") {
    const i = nextUnanswered(view.exam);
    return i === null ? finishExam() : examGoto(i);
  }
  if (act === "exam-finish") return finishExam();
  if (act === "exam-quit") {
    const ex = view.exam;
    if (!(await ask("Вийти з іспиту? Результат не буде зараховано.", { ok: "Вийти", cancel: "Продовжити іспит", danger: true }))) return;
    if (view.name !== "exam" || view.exam !== ex) return;   // time ran out while the dialog was open
    const answered = ex.answers.filter((a) => a !== null).length;
    tele.track("exams", {
      uid: S.tele.uid, sid: SID,
      errors: ex.ids.reduce((n, id, i) => n + (ex.answers[i] !== null && ex.answers[i] !== byId[id].a ? 1 : 0), 0),
      total: ex.ids.length, passed: false, timeout: false,
      duration_s: Math.min(7200, Math.round((Date.now() - ex.startedAt) / 1000)),
      wrong_qids: ex.ids.filter((id, i) => ex.answers[i] !== null && ex.answers[i] !== byId[id].a),
      day_n: dayN(), local_hour: new Date().getHours(), ...progressCounts(),
      device: device(), app_ver: APP_VER,
      abandoned: true, answered, quit_at: ex.i + 1, quit_qid: ex.ids[ex.i],
    });
    return go({ name: "home" });
  }
  if (act === "drill-next") return drillNext();
  if (act === "export") return exportProgress();
  if (act === "reset") {
    if (await ask("Видалити весь прогрес, історію іспитів і помилки? Це не можна скасувати.", { ok: "Видалити все", danger: true })) {
      const keep = { tele: S.tele, plan: S.plan, ui: S.ui };
      S = { ...defaultState(), ...keep, grade: grader.newModel(), firstSeen: Date.now() }; save(); makeScheduler(); applyMotion(); go({ name: "home" });
    }
    return;
  }
  if (act === "offline") return saveOffline(t);
  if (t.dataset.topic) return go({ name: "topic", id: t.dataset.topic, back: backOf(view) });
  if (t.dataset.practice !== undefined) {
    // From search results or a topic: practise that list, starting at the tapped question.
    const ids = view.name === "topic" ? topicOrder(topicById[view.id]) : searchHits.map((x) => x.id);
    const start = t.dataset.practice === "all" ? 0 : ids.indexOf(t.dataset.practice);
    const title = view.name === "topic" ? topicById[view.id].name : `Пошук: ${searchQuery}`;
    return go({ name: "practice", ids, i: Math.max(0, start), results: {}, title, back: backOf(view) });
  }
  if (act === "back") return go(view.back || { name: "home" });
  if (act === "tour") return showTour("settings");
  if (act === "practice-next") return practiceNext();
  if (act === "practice-again") return go({ ...view, i: 0, results: {}, state: null, done: false });
  if (t.dataset.pref) {
    const k = t.dataset.pref;
    S.prefs[k] = !S.prefs[k];
    if (k === "auto") S.prefs.autoAsked = true;   // chosen by hand: no need to offer it later
    save();
    applyMotion();
    return render();
  }
  if (act === "bonus") {
    S.day.bonus = (S.day.bonus || 0) + 20;
    save(); ev("bonus", null, S.day.bonus);
    return go({ name: "study" });
  }
  if (act === "remind") {
    const at = document.getElementById("remindAt")?.value || t.dataset.at || "19:00";
    downloadReminder(at);
    return render();
  }
  if (act === "share") {
    return shareApp(t.dataset.where, t.dataset.text || "Безкоштовний тренажер ПДР: усі питання ГСЦ і пробний іспит, як у сервісному центрі 🚗");
  }
  if (act === "install" && installEvt) {
    ev("install_click");
    installEvt.prompt();
    const { outcome } = await installEvt.userChoice.catch(() => ({}));
    if (outcome !== "accepted") S.ui.installLaterAt = Date.now();
    installEvt = null; save(); return render();
  }
  if (act === "install-later") {
    S.ui.installLaterAt = Date.now(); save(); ev("install_later");
    return render();
  }
});

function setExamDate(v) {
  S.plan.examDate = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  save();
  const left = examDaysLeft();
  if (left !== null) ev("exam_date", null, Math.max(-1000, Math.min(1000, left)));
}

// Desktop Chrome opens a date field's calendar only from its icon; open it on any click.
// Touch browsers open it natively on tap, so they are left alone.
app.addEventListener("click", (e) => {
  if (e.target.id === "examDateHome" && matchMedia("(pointer: fine)").matches) {
    try { e.target.showPicker(); } catch (err) { /* already open or unsupported */ }
  }
});

// "toggle" does not bubble: listen in the capture phase.
app.addEventListener("toggle", (e) => {
  if (e.target.matches?.(".twin") && e.target.open) ev("twin_open", e.target.dataset.twin);
}, true);

app.addEventListener("pointerdown", (e) => {
  if (autoTimer && !e.target.closest(".dock")) cancelAuto();
});

app.addEventListener("input", (e) => {
  if (e.target.id === "q") { searchQuery = e.target.value; renderSearchResults(); }
});

app.addEventListener("change", (e) => {
  if (e.target.id === "importFile" && e.target.files[0]) importProgress(e.target.files[0]);
  if (e.target.id === "examDateHome" && e.target.value) { setExamDate(e.target.value); render(); }
  // While a year is typed digit by digit (0002, 0020…) the field already reports a date.
  if (e.target.id === "examDate" && (!e.target.value || e.target.value >= "2020")) { setExamDate(e.target.value); toast(e.target.value ? "Дату іспиту збережено" : "Дату іспиту прибрано"); }
  if (["newPerDay", "retention", "maxIvl"].includes(e.target.id)) saveSettingField(e.target);
});

function drillNext() {
  cancelAuto();
  const id = view.queue.shift();
  if (view.state.chosen === byId[id].a) { delete S.wrong[id]; save(); }
  else view.queue.push(id);
  view.state = null;
  vt(render, "next");
}

function pickOption(i) {
  if (view.name === "exam") {
    const ex = view.exam;
    if (ex.answers[ex.i] !== null) return;
    ex.answers[ex.i] = i;
    const first = markActive(); save();
    trackAnswer(byId[ex.ids[ex.i]], "exam", i, activeNow() - ex.shownAt, null, null,
      { shuffled: isShuffled(ex.perms[ex.i]) });
    try { navigator.vibrate?.(i === byId[ex.ids[ex.i]].a ? 12 : [40, 60, 40]); } catch (e) { /* not allowed */ }
    ex.anim = ex.i;
    announceVerdict(byId[ex.ids[ex.i]], i, ex.perms[ex.i]);
    renderExamKeepTimer();
    ex.anim = null;
    if (first) streakToast();
    return;
  }
  if (["study", "drill", "practice"].includes(view.name) && view.state && view.state.chosen === null) {
    view.state.chosen = i;
    view.state.rt = activeNow() - view.state.shownAt;
    const q = byId[view.name === "drill" ? view.queue[0] : view.name === "practice" ? view.ids[view.i] : view.current.id];
    const right = i === q.a;
    combo = right ? combo + 1 : 0;
    comboRecord = right && combo >= 10 && combo > (S.best.combo || 0);
    if (combo > (S.best.combo || 0)) S.best.combo = combo;
    const first = markActive(); save();
    try { navigator.vibrate?.(right ? 12 : [40, 60, 40]); } catch (e) { /* not allowed */ }
    if (view.name !== "study") {
      trackAnswer(q, view.name === "drill" ? "drill" : "topic", i, view.state.rt, null, null, { shuffled: isShuffled(view.state.perm) });
    }
    if (view.name === "practice") {
      view.results[view.i] = right;
      if (!right) S.wrong[q.id] = Date.now();   // goes to "Помилки"; the FSRS schedule is not touched
      save();
    }
    const st = view.state;
    announceVerdict(q, i, st.perm);
    // Graded on every right answer, also by hand: the hand grades calibrate it.
    if (right && view.name === "study") st.g = autoGrade(q, st.rt);
    st.auto = right && S.prefs.auto;
    st.anim = true;
    render();
    st.anim = false;
    // On a phone the right answer can sit under the bottom bar: bring it into view.
    app.querySelector(".opt.right")?.scrollIntoView({ block: "center", behavior: motionOn() ? "smooth" : "auto" });
    if (first) streakToast();
    if (comboRecord) confetti();
    if (st.auto) armAuto(() => (view.name === "study" ? doRate(st.g.rating, true)
      : view.name === "practice" ? practiceNext() : drillNext()));
  }
}

function renderExamKeepTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  const y = window.scrollY;
  renderExam();
  window.scrollTo(0, y);
}

function doRate(r, auto = false) {
  cancelAuto();
  const id = view.current.id;
  const g = view.state.g;
  // Logged at grading time so the FSRS state is the one before this answer.
  // An undone answer stays in the stats: the person did answer it that way.
  // auto_guess next to a hand grade shows how often the algorithm agrees with people.
  trackAnswer(byId[id], "study", view.state.chosen, view.state.rt, r, S.cards[id] || createEmptyCard(new Date()),
    { shuffled: isShuffled(view.state.perm), auto_rated: auto, auto_guess: g ? g.rating : null, auto_z: g ? g.z : null });
  const gradeBefore = structuredClone(S.grade);
  if (g) {
    grader.learnPace(S.grade, byId[id], view.state.rt, (S.cards[id]?.reps || 0) > 0);
    // Hand grades teach the thresholds; tapping the highlighted guess only agrees with it.
    if (!auto && !(S.prefs.auto && r === g.rating)) grader.learnGrade(S.grade, g.z, r);
  }
  const undo = rate(id, r);
  undo.grade = gradeBefore;   // "Скасувати" also takes back what the grader learnt
  // A card failed in a learning step can be due again at once: show something else first.
  const pick = nextCard(id);
  view = { name: "study", undo, current: pick.id ? pick : undefined };
  vt(render, "next");
  checkMilestone();
  if (!auto && g) setTimeout(offerAuto, 400);
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;   // keys belong to the open dialog
  const n = Number(e.key);
  if (n >= 1 && n <= 9) {
    const btn = app.querySelectorAll(".opts .opt")[n - 1];
    if (btn && !btn.disabled) { e.preventDefault(); return pickOption(Number(btn.dataset.opt)); }
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
    if (!(await ask("Замінити поточний прогрес даними з файлу?", { ok: "Замінити", danger: true }))) return;
    S = { ...defaultState(), ...data.state };
    normalize();
    save(); makeScheduler(); applyMotion(); go({ name: "home" });
  } catch (err) {
    toast("Це не файл прогресу цього застосунку");
  }
}

async function saveOffline(btn) {
  if (!("caches" in window)) { toast("Цей браузер не підтримує офлайн-збереження"); return; }
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

// Fills in what older saves and exported files lack. Used at start and on import.
function normalize() {
  const d = defaultState();
  S.tele = { ...d.tele, ...S.tele };
  // Saves from before auto-grading had auto-advance on by default: it now starts off
  // and is offered once the person has graded a few answers by hand.
  if (S.prefs && !("autoAsked" in S.prefs)) S.prefs.auto = false;
  // Progress from before the tour: no tour for people who already use the app.
  if (S.ui && !("tourDone" in S.ui)) {
    S.ui.tourDone = S.logs.length > 0 || S.exams.length > 0 || Object.keys(S.wrong).length > 0;
  }
  for (const k of ["plan", "ui", "best", "prefs"]) S[k] = { ...d[k], ...S[k] };
  const g = S.grade;
  if (!(g?.pace?.new && g.pace.seen && g.cal?.[2] && g.cal[3] && g.cal[4])) S.grade = grader.newModel();
  S.day = { ...newDay(S.day.key), ...S.day };
  seedDays();
}

// ---------- boot ----------
async function boot() {
  S = load();
  normalize();
  if (!S.firstSeen) S.firstSeen = Date.now();
  if (!S.tele.uid) S.tele.uid = crypto.randomUUID();
  // App icon shortcuts (manifest) open a screen directly: ?go=study|exam|drill
  const start = new URLSearchParams(location.search).get("go");
  readSource();
  if (!S.tele.visited && !S.tele.firstSrc) S.tele.firstSrc = sess.src || null;
  // On by default; can be turned off on privacy.html (footer link "Конфіденційність").
  if (S.tele.on === null) S.tele.on = true;
  save();
  makeScheduler();
  applyMotion();
  tele.init(() => S.tele.on);
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
  buildSearch();
  if (["study", "exam", "drill", "search"].includes(start)) view = { name: start };
  // Links from the topic pages: ?topic=t01 opens that topic.
  const topicParam = new URLSearchParams(location.search).get("topic");
  if (topicParam && topicById[topicParam]) view = { name: "topic", id: topicParam, back: { name: "home" } };
  render();
  startSession();
  if (!S.ui.tourDone && !S.logs.length && view.name === "home") showTour("start");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (!DB) return;
  updateBadge();
  if (document.visibilityState === "visible" && view.name === "home") render();
});

boot();
