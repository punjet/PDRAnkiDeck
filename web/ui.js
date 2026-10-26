// Small UI building blocks shared by all screens: text helpers, icons, the screen
// header, the bottom action bar, empty states, toasts, confetti and a confirm dialog.
// Nothing here reads the study state; app.js passes in what each piece shows.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const clipText = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const svg = (size, body, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  gear: svg(22, `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`),
  search: svg(18, `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`, 2.2),
  back: svg(22, `<path d="M15 18l-6-6 6-6"/>`, 2.4),
  close: svg(22, `<path d="M18 6 6 18M6 6l12 12"/>`, 2.4),
};

// Screen header: back (or close) on the left, title in the middle, an optional slot on
// the right. Every screen uses it, so the back button is always in the same place.
// back: the data-* attribute of the button, e.g. 'data-go="home"' or 'data-act="back"'.
export function topBar({ back = 'data-go="home"', close = false, title = "", sub = "", right = "" } = {}) {
  return `
  <header class="top">
    <button class="nav-btn" ${back} aria-label="${close ? "Вийти" : "Назад"}">${close ? ICON.close : ICON.back}<span>${close ? "Вийти" : "Назад"}</span></button>
    <div class="top-title">${title ? `<h1 tabindex="-1">${title}</h1>` : ""}${sub ? `<p>${sub}</p>` : ""}</div>
    <div class="top-right">${right}</div>
  </header>`;
}

// Bottom action bar over the content (main action within thumb reach).
export const dock = (inner) => (inner ? `<div class="dock"><div class="dock-inner">${inner}</div></div>` : "");

// Centered message with an emoji, a title, an optional text and buttons.
export function emptyState({ emoji, title, text = "", body = "", actions = "" }) {
  return `
  <section class="card empty-state stack">
    <div class="emoji" aria-hidden="true">${emoji}</div>
    <h2 tabindex="-1">${title}</h2>
    ${text ? `<p class="muted">${text}</p>` : ""}
    ${body}
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </section>`;
}

// Screen readers hear verdicts and toasts from one polite live region, not the whole screen.
let live;
export function announce(text) {
  if (!live) {
    live = document.createElement("div");
    live.className = "sr-only";
    live.setAttribute("aria-live", "polite");
    document.body.appendChild(live);
  }
  live.textContent = "";
  setTimeout(() => { live.textContent = text; }, 50);
}

export function toast(text) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.appendChild(el);
  // Long lines stay longer: about 60 ms a character, 2.6 s at least.
  const ms = Math.max(2600, text.length * 60);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 500);
}

export function confetti() {
  const c = document.createElement("canvas");
  c.className = "confetti";
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const colors = ["#1d4ed8", "#157a3c", "#f0a53a", "#c0262d", "#5b8cff", "#4cc47d"];
  const parts = Array.from({ length: 110 }, () => ({
    x: innerWidth / 2, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, col: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const k = (t - t0) / 1800;
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.globalAlpha = Math.max(0, 1 - k * k);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.col;
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
    }
    if (k < 1) requestAnimationFrame(frame); else c.remove();
  })(t0);
}

// In-page confirm: native confirm() is a grey system box on phones and blocks the timer.
// Resolves true for the confirm button, false for cancel, Esc or a tap outside.
// A dangerous action starts with focus on cancel, so a stray Enter does no harm.
// note: an optional plain-text explanation under the question.
export function ask(text, { ok = "Так", cancel = "Скасувати", danger = false, note = "" } = {}) {
  if (typeof HTMLDialogElement !== "function") return Promise.resolve(confirm(text));
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "sheet";
    // Padding sits on the inner box, so a tap on the dialog element itself is a tap outside.
    d.innerHTML = `<div class="sheet-body">
      <p>${esc(text)}</p>
      ${note ? `<p class="sheet-note">${esc(note)}</p>` : ""}
      <div class="actions">
        <button class="${danger ? "danger" : "primary"}" value="ok">${esc(ok)}</button>
        <button value="">${esc(cancel)}</button>
      </div></div>`;
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close("");
      const b = e.target.closest("button");
      if (b) d.close(b.value);
    });
    d.addEventListener("close", () => { resolve(d.returnValue === "ok"); d.remove(); });
    document.body.appendChild(d);
    d.showModal();
    d.querySelector(danger ? 'button[value=""]' : "button").focus();
  });
}

// Full-screen picture with pinch / wheel zoom, drag to pan and double tap to zoom in
// or out. Closes with ✕, Esc, the back gesture's Esc or a tap on the dark area.
export function openImage(src, alt = "") {
  if (typeof HTMLDialogElement !== "function") { window.open(src, "_blank"); return; }
  const d = document.createElement("dialog");
  d.className = "viewer";
  d.setAttribute("aria-label", "Малюнок");
  d.innerHTML = `
    <img src="${esc(src)}" alt="${esc(alt)}" draggable="false">
    <button class="viewer-close" aria-label="Закрити">${ICON.close}</button>
    <p class="viewer-hint" aria-hidden="true">Розведіть пальці, щоб збільшити</p>`;
  const img = d.querySelector("img");
  let scale = 1, x = 0, y = 0;
  const pts = new Map();
  let pinch = null, pan = null, lastTap = 0, moved = false;
  const MAX = 5;
  const apply = (smooth = false) => {
    img.style.transition = smooth ? "transform .2s ease" : "none";
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    d.classList.toggle("zoomed", scale > 1.01);
  };
  // Keep the picture from being dragged off screen.
  // Layout size (offsetWidth) ignores the transform, so this is right mid-gesture too.
  const clamp = () => {
    const w = img.offsetWidth, h = img.offsetHeight;
    const mx = Math.max(0, (w * scale - innerWidth) / 2), my = Math.max(0, (h * scale - innerHeight) / 2);
    x = Math.min(mx, Math.max(-mx, x)); y = Math.min(my, Math.max(-my, y));
  };
  // Zoom to `s` keeping the screen point (cx, cy) under the finger.
  const zoomAt = (s, cx, cy) => {
    s = Math.min(MAX, Math.max(1, s));
    const ox = cx - innerWidth / 2, oy = cy - innerHeight / 2;
    x = ox - (ox - x) * (s / scale); y = oy - (oy - y) * (s / scale);
    scale = s;
    if (scale === 1) { x = 0; y = 0; }
    clamp();
  };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };

  d.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".viewer-close")) return;
    d.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 2) { pinch = { d: dist(), s: scale }; pan = null; }
    else if (pts.size === 1) pan = { x: e.clientX - x, y: e.clientY - y };
  });
  d.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) moved = true;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) { const m = mid(); zoomAt(pinch.s * dist() / pinch.d, m.x, m.y); apply(); }
    else if (pan && scale > 1) { x = e.clientX - pan.x; y = e.clientY - pan.y; clamp(); apply(); }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const [p] = pts.values(); pan = { x: p.x - x, y: p.y - y }; }
    if (pts.size || moved || e.type === "pointercancel") return;
    const now = Date.now();
    if (now - lastTap < 300) {   // double tap
      lastTap = 0;
      zoomAt(scale > 1.01 ? 1 : 2.5, e.clientX, e.clientY); apply(true);
    } else {
      lastTap = now;
      // A single tap outside the picture closes it (after the double-tap window).
      // (pointer capture makes e.target the dialog, so hit-test the picture's box instead)
      const r = img.getBoundingClientRect();
      const onImg = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!onImg && scale <= 1.01) setTimeout(() => { if (lastTap === now) d.close(); }, 300);
    }
  };
  d.addEventListener("pointerup", up);
  d.addEventListener("pointercancel", up);
  d.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY); apply();
  }, { passive: false });
  d.querySelector(".viewer-close").addEventListener("click", () => d.close());
  d.addEventListener("close", () => d.remove());
  document.body.appendChild(d);
  d.showModal();
  d.querySelector(".viewer-close").focus();
}
