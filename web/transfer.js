// Progress transfer to another device by QR code or link, with no account.
//
// Sending: the state is gzipped and encrypted with a fresh AES-GCM key in the browser.
// The ciphertext goes to Supabase (transfer_put, see supabase/schema.sql) under a
// random code for at most a day; the link is  <site>#xfer=<code>.<key>. The key lives
// only in the #fragment, which browsers never send to a server, so the server holds
// nothing it can read. Receiving: transfer_get returns the ciphertext once and deletes it.
// Without the server (offline, or the schema not applied yet) the whole state goes in
// the link itself:  <site>#xferdata=<gzip, base64url>  — long, so no QR code then.
// Loaded on demand (import()) from app.js.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

const b64url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));
const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"));

export const supported = () => typeof CompressionStream === "function" && !!crypto?.subtle;

async function rpc(name, args) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("no server");
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  if (!r.ok) { const e = new Error(`rpc ${name}: ${r.status}`); e.status = r.status; throw e; }
  const text = await r.text();   // a void function answers 204 or an empty 200
  return text ? JSON.parse(text) : null;
}

// Returns { link, short }: short is true for a server link (fits a QR code).
export async function makeLink(state, base) {
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(state)));   // throws only if gzip is broken
  try {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const blob = b64url(new Uint8Array([...iv, ...ct]));
    const raw = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
    for (let tries = 0; tries < 3; tries++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => B32[b & 31]).join("");
      try {
        await rpc("transfer_put", { code, blob });
        return { link: `${base}#xfer=${code}.${raw}`, short: true };
      } catch (e) {
        if (e.status !== 409) throw e;   // 409: the code is taken, draw another
      }
    }
    throw new Error("no free code");
  } catch (e) {
    return { link: `${base}#xferdata=${b64url(plain)}`, short: false };
  }
}

// From location.hash: the state, null when the link was already used or expired.
// Throws on a damaged link.
export async function readLink(hash) {
  const m = hash.match(/^#xfer=([a-z2-7]{12})\.([A-Za-z0-9_-]+)$/);
  if (m) {
    const blob = await rpc("transfer_get", { code: m[1] });
    if (!blob) return null;
    const bytes = unb64url(blob);
    const key = await crypto.subtle.importKey("raw", unb64url(m[2]), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
    return JSON.parse(new TextDecoder().decode(await gunzip(plain)));
  }
  const d = hash.match(/^#xferdata=([A-Za-z0-9_-]+)$/);
  if (d) return JSON.parse(new TextDecoder().decode(await gunzip(unb64url(d[1]))));
  throw new Error("not a transfer link");
}

// QR code as an inline SVG (one path, crisp at any size), dark modules on white.
export async function qrSvg(text) {
  const { default: qrcode } = await import("./vendor/qrcode-generator-1.4.4.mjs");
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad},${r + pad}h1v1h-1z`;
  const size = n + 2 * pad;
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR-код посилання для перенесення" shape-rendering="crispEdges">
    <rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
