// Auto-grading: after a right answer, guess what the person would press — Важко,
// Добре or Легко — so auto-advance can grade for them.
//
// Evidence is summed into one score z (above 0: knows it well, below 0: shaky):
//  - speed: answer time against the time this question needs to be read (its length
//    and pictures), scaled by this person's own usual pace; fast -> up, slow -> down;
//  - this question's history: times forgotten, the last grade, a recent mistake;
//  - guessing: a first right answer on a 2-option question is half luck;
//  - neighbours: look-alike questions with another answer (similar.py) recently got
//    wrong mean a risk of mixing them up; near questions by meaning (embeddings)
//    already known suggest the point itself is known.
// z <= hard -> Важко, z >= easy -> Легко, otherwise Добре. While grading by hand the
// person's own grades move the two thresholds (calibrate), so the guesses come to
// match how this person grades.
// Pure functions: the caller passes in the state, nothing here reads storage.

export const HARD = 2, GOOD = 3, EASY = 4;   // ts-fsrs Rating values
const DEFAULT_T = { hard: -0.45, easy: 0.55 };
const RT_MIN = 300, RT_MAX = 120e3;
const DAY = 864e5;

export const newModel = () => ({
  pace: { new: { n: 0, mu: 0 }, seen: { n: 0, mu: 0 } },   // mean ln(answer time / reading time)
  cal: { [HARD]: { n: 0, sum: 0 }, [GOOD]: { n: 0, sum: 0 }, [EASY]: { n: 0, sum: 0 } },
  manual: 0,   // right answers graded by hand
});

// Time to read the question and the options and look at the pictures, in ms.
export function readingMs(q) {
  const opts = q.o.reduce((n, o) => n + o.length, 0);
  return 1500 + 40 * q.t.length + 25 * opts + 2000 * q.img.length;
}

// Learn this person's pace from a right answer (new and seen questions apart:
// a question seen before is read faster).
export function learnPace(model, q, rtMs, seen) {
  if (!Number.isFinite(rtMs) || rtMs < RT_MIN || rtMs > RT_MAX) return;
  const p = model.pace[seen ? "seen" : "new"];
  const x = Math.log(rtMs / readingMs(q));
  p.n++;
  p.mu += Math.max(0.05, 1 / p.n) * (x - p.mu);
}

// A grade the person gave by hand: remembered next to the score the algorithm had.
export function learnGrade(model, z, rating) {
  const c = model.cal[rating];
  if (!c || !Number.isFinite(z)) return;
  c.n++; c.sum += z;
  model.manual++;
}

// Thresholds from the person's own grades once there are a few of each kind.
export function thresholds(model) {
  const m = (r) => (model.cal[r].n >= 3 ? model.cal[r].sum / model.cal[r].n : null);
  const h = m(HARD), g = m(GOOD), e = m(EASY);
  const t = { ...DEFAULT_T };
  if (h !== null && g !== null && h < g) t.hard = Math.min(0, Math.max(-1.2, (h + g) / 2));
  if (e !== null && g !== null && e > g) t.easy = Math.min(1.5, Math.max(0.2, (g + e) / 2));
  return t;
}

const times = (n) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "рази" : "разів");

// q: the question; rtMs: visible time to answer; ctx:
//   card       FSRS card before this answer (undefined for a new question)
//   lastRating last grade of this question (1..4) or null
//   wrongAt    unix ms of the last mistake on it, or null
//   know(id)   1 known, 0.5 learning, 0 recent mistake, null unseen
//   now        unix ms
// Returns { rating, z, reason }: the grade, the score and a short "why" in Ukrainian.
export function grade(q, rtMs, { model, card, lastRating = null, wrongAt = null, know = () => null, now = Date.now() }) {
  const seen = !!card && card.reps > 0;
  const parts = [];   // [weight, reason]
  let speed = 0;

  const pace = model.pace[seen ? "seen" : "new"];
  // Own pace counts after a few answers, within 3.3x either way of the reading time.
  const mu = pace.n >= 5 ? Math.min(1.2, Math.max(-1.2, pace.mu)) : 0;
  if (Number.isFinite(rtMs) && rtMs > 0) {
    const ratio = Math.min(5, Math.max(0.2, rtMs / (readingMs(q) * Math.exp(mu))));
    const w = speed = -Math.log(ratio);
    parts.push([w, w > 0 ? "відповіли швидше, ніж зазвичай" : "думали довше, ніж зазвичай"]);
  }

  const lapses = Math.min(3, card?.lapses || 0);
  if (lapses) parts.push([-0.3 * lapses, `це питання ви вже забували ${card.lapses} ${times(card.lapses)}`]);
  if (lastRating === 1) parts.push([-0.5, "минулого разу тут помилилися"]);
  else if (wrongAt && now - wrongAt < 3 * DAY) parts.push([-0.3, "нещодавно тут помилялися"]);
  else if (lastRating === HARD) parts.push([-0.35, "минулого разу було важко"]);
  else if (lastRating === EASY) parts.push([0.25, "минулого разу було легко"]);

  // Guessing only discounts speed: a quick first right answer may be luck, an ordinary
  // or slow one is not made worse by it.
  if (!seen && speed > 0) parts.push([-Math.min(speed, 1 / q.o.length), `нове питання з ${q.o.length} варіантів — могли вгадати`]);

  const mixed = (q.sim || []).filter((id) => know(id) === 0).length;
  if (mixed) parts.push([-0.3 * Math.min(2, mixed), "схоже питання з іншою відповіддю нещодавно плутали"]);
  const near = (q.nb || []).map(know).filter((k) => k !== null);
  if (near.length >= 2) {
    const mean = near.reduce((a, b) => a + b, 0) / near.length;
    const w = 0.5 * (mean - 0.5);
    if (w) parts.push([w, w > 0 ? "схожі за змістом питання ви вже знаєте" : "зі схожими за змістом питаннями поки складно"]);
  }

  const z = parts.reduce((a, [w]) => a + w, 0);
  const t = thresholds(model);
  let rating = z <= t.hard ? HARD : z >= t.easy ? EASY : GOOD;
  // A quick first tap on a yes/no question is as likely a guess as knowledge.
  const guessCap = rating === EASY && !seen && q.o.length <= 2;
  if (guessCap) rating = GOOD;
  // The reason: the biggest push towards the grade; for Добре, what pulled each way.
  const biggest = (sign) => parts.filter(([w]) => w * sign >= 0.15).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0]?.[1];
  const up = biggest(1), down = biggest(-1);
  let reason;
  if (rating === HARD) reason = down || "думали довше, ніж зазвичай";
  else if (rating === EASY) reason = up || "відповіли швидше, ніж зазвичай";
  else if (guessCap) reason = "швидко, але це нове питання з 2 варіантів — могли вгадати";
  else reason = up && down ? `${up}, але ${down}` : "звичайний темп";
  return { rating, z: Math.round(z * 1000) / 1000, reason };
}
