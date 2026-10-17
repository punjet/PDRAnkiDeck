// Anonymous learning telemetry -> Supabase, through the append-only ingest() function
// (see supabase/schema.sql).
// Rows wait in a localStorage queue and go out in batches, so studying offline
// loses nothing. Disabled entirely while config.js has no Supabase URL.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const QUEUE_KEY = "pdr-b-tele-queue";
const MAX_QUEUE = 5000;
const BATCH = 100;          // rows per request (~50 KB)
const KEEPALIVE_BUDGET = 60000;  // browsers cap in-flight keepalive bodies at 64 KB
const FLUSH_MS = 30e3;

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
let enabled = () => false;
let queue = readQueue();
let flushing = false;

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; }
}
function writeQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) { /* storage full or blocked */ }
}

export function init(isEnabled) {
  enabled = isEnabled;
  if (!configured) return;
  setInterval(() => flush(), FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  // pagehide also fires on navigation and on iOS Safari, where visibilitychange is unreliable.
  window.addEventListener("pagehide", () => flush(true));
  window.addEventListener("online", () => flush());
  flush();
}

export function track(table, row) {
  if (!configured || !enabled()) return;
  queue.push([table, { eid: crypto.randomUUID(), ...row }]);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  writeQueue();
  if (queue.length >= BATCH) flush();
}

export function clearQueue() {
  queue = [];
  writeQueue();
}

function batches() {
  // Consecutive rows of one table, at most BATCH each (ingest() takes one table per call).
  const out = [];
  for (const item of queue) {
    const last = out[out.length - 1];
    if (last && last.table === item[0] && last.rows.length < BATCH) last.rows.push(item[1]);
    else out.push({ table: item[0], rows: [item[1]] });
  }
  return out;
}

function send({ table, rows }, keepalive, body = JSON.stringify({ t: table, rows })) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_KEY };
  // Legacy anon keys are JWTs and also go in Authorization; new publishable keys do not.
  if (SUPABASE_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest`, { method: "POST", headers, body, keepalive });
}

// Should these rows leave the queue? Yes when stored, and when the database
// rejects the data itself (retrying won't help). No on 404/401/429/5xx and on
// "unknown table": the app was updated before the schema, the rows wait for it.
async function settled(r) {
  if (r.ok) return true;
  if (r.status === 400) {
    try { return !/unknown table/.test((await r.json()).message || ""); } catch (e) { return true; }
  }
  return [409, 413, 422].includes(r.status);
}

function drop(rows) {
  const sent = new Set(rows.map((r) => r.eid));
  queue = queue.filter((item) => !sent.has(item[1].eid));
  writeQueue();
}

export async function flush(leaving = false) {
  if (!configured || !queue.length || !enabled() || !navigator.onLine) return;
  if (leaving) {
    // The page may be frozen right after this: fire every batch at once. Rows
    // stay queued until a reply confirms them; a re-send is ignored by eid.
    // Only what fits the keepalive budget goes now; the rest waits for next launch.
    let budget = KEEPALIVE_BUDGET;
    for (const b of batches()) {
      const body = JSON.stringify({ t: b.table, rows: b.rows });
      if (body.length > budget) break;
      budget -= body.length;
      send(b, true, body).then(async (r) => { if (await settled(r)) drop(b.rows); }).catch(() => {});
    }
    return;
  }
  if (flushing) return;
  flushing = true;
  // All batches at once: a page closed mid-way then loses as little as possible.
  await Promise.all(batches().map((b) => send(b, false).then(async (r) => {
    if (await settled(r)) drop(b.rows);
  }).catch(() => { /* offline or blocked by an extension: retry later */ })));
  flushing = false;
}
