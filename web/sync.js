// Sign-in with Google and progress sync between devices, through Supabase Auth and one
// row per account in public.progress (see supabase/schema.sql). No client library: the
// sign-in is a redirect to Supabase, which sends the person to Google and back here with
// the session in the URL #fragment; data goes through plain REST calls.
// Loaded on demand (import()) from app.js, only for people who sign in.
import { SUPABASE_URL, SUPABASE_KEY, GOOGLE_CLIENT_ID } from "./config.js";

const AUTH_KEY = "pdr-auth";   // { access, refresh, exp (unix s), email, id }

const readAuth = () => {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch (e) { return null; }
};
const writeAuth = (a) => {
  try { a ? localStorage.setItem(AUTH_KEY, JSON.stringify(a)) : localStorage.removeItem(AUTH_KEY); } catch (e) { /* private mode */ }
};

export const available = () => !!(SUPABASE_URL && SUPABASE_KEY && typeof CompressionStream === "function");
export const signedIn = () => !!readAuth()?.refresh;
export const account = () => { const a = readAuth(); return a ? { email: a.email, id: a.id } : null; };

// ---------- sign-in ----------
export function login() {
  const back = location.origin + location.pathname;
  location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}`;
}

// ---------- sign-in on the page itself: Google's own button (Google Identity Services) ----------
// The person picks the account in Google's popup without leaving the site; Google returns an ID
// token for our client, Supabase checks it and opens a session. The Google consent text names
// our domain (zdaipdr.com.ua), not the database's, and the script is loaded only for this button.
let gsiLoading = null;
function loadGsi() {
  gsiLoading ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? ok() : fail(new Error("gsi")));
    s.onerror = () => { gsiLoading = null; fail(new Error("gsi blocked")); };
    document.head.appendChild(s);
  });
  return gsiLoading;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Renders the button into `el`; onSignedIn(account) after a successful sign-in, onError(e) else.
export async function mountGoogleButton(el, { dark = false, onSignedIn, onError } = {}) {
  await loadGsi();
  // Nonce: Google puts the hash in the token, Supabase gets the raw value and compares.
  const raw = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hashed = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: hashed,
    ux_mode: "popup",
    use_fedcm_for_button: true,
    callback: async (resp) => {
      try { onSignedIn?.(await loginWithIdToken(resp.credential, raw)); }
      catch (e) { onError?.(e); }
    },
  });
  el.innerHTML = "";
  google.accounts.id.renderButton(el, {
    type: "standard", theme: dark ? "filled_black" : "outline", size: "large", shape: "pill",
    text: "signin_with", logo_alignment: "left", locale: "uk", width: Math.min(400, el.clientWidth || 320),
  });
}

export async function loginWithIdToken(idToken, nonce) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
    method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", id_token: idToken, nonce }) });
  if (!r.ok) throw new Error(`id_token ${r.status}`);
  const d = await r.json();
  const a = { access: d.access_token, refresh: d.refresh_token,
              exp: Math.floor(Date.now() / 1000) + Number(d.expires_in || 3600),
              email: d.user?.email, id: d.user?.id };
  writeAuth(a);
  return { email: a.email, id: a.id };
}

// After the redirect back (the older flow, kept for links already open): #access_token=…&refresh_token=…&expires_in=… (or #error=…).
// Returns "in", "error" or null when the URL has nothing for us.
export async function handleRedirect() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("access_token") && !h.has("error")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  if (!h.has("access_token")) return "error";
  const a = { access: h.get("access_token"), refresh: h.get("refresh_token"),
              exp: Math.floor(Date.now() / 1000) + Number(h.get("expires_in") || 3600) };
  try {
    const u = await authFetch("/auth/v1/user", {}, a);
    a.email = u.email; a.id = u.id;
  } catch (e) { return "error"; }
  writeAuth(a);
  return "in";
}

async function refresh(a) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: a.refresh }) });
  if (r.status === 400 || r.status === 401) { writeAuth(null); throw Object.assign(new Error("signed out"), { signedOut: true }); }
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const d = await r.json();
  const next = { ...a, access: d.access_token, refresh: d.refresh_token,
                 exp: Math.floor(Date.now() / 1000) + Number(d.expires_in || 3600) };
  writeAuth(next);
  return next;
}

// fetch with the session; refreshes it when it is about to expire or the server says 401.
async function authFetch(path, init = {}, given = null) {
  let a = given || readAuth();
  if (!a) throw Object.assign(new Error("signed out"), { signedOut: true });
  if (!given && a.exp - 60 < Date.now() / 1000) a = await refresh(a);
  const go = (tok) => fetch(SUPABASE_URL + path, { ...init, headers: {
    apikey: SUPABASE_KEY, Authorization: `Bearer ${tok}`, ...(init.headers || {}) } });
  let r = await go(a.access);
  if (r.status === 401 && !given) { a = await refresh(a); r = await go(a.access); }
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status}`), { status: r.status });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export async function logout() {
  try { await authFetch("/auth/v1/logout", { method: "POST" }); } catch (e) { /* signed out anyway */ }
  writeAuth(null);
}

// ---------- data: gzipped JSON in base64, one row per account ----------
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
async function pack(obj) {
  const z = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("gzip"));
  let s = "";
  for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode(...z.subarray(i, i + 0x8000));
  return btoa(s);
}
async function unpack(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream("gzip"))));
}

// The progress saved for this account, or null if there is none yet.
export async function pull() {
  const rows = await authFetch("/rest/v1/progress?select=data,updated_at");
  if (!rows?.length) return null;
  return { state: await unpack(rows[0].data), at: rows[0].updated_at };
}

export async function push(state) {
  const a = readAuth();
  const data = await pack(state);
  await authFetch("/rest/v1/progress?on_conflict=user_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: a.id, data, updated_at: new Date().toISOString() }),
  });
  return data.length;
}

// Deletes the account and its synced progress (the progress on this device stays).
export async function deleteAccount() {
  try {
    await authFetch("/rest/v1/rpc/delete_me", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (e) {
    // Without the function on the server, at least remove the synced progress.
    await authFetch(`/rest/v1/progress?user_id=eq.${readAuth()?.id}`, { method: "DELETE" });
  }
  writeAuth(null);
}
