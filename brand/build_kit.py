"""Builds the «Здай ПДР» logo kit (SVG masters in this folder) (concept A, road-check) from one exact geometry.

Symbol: a checkmark drawn as a road. Polyline P0 -> P1 -> P2 at 45 degrees, road width 60,
round outer join, mitred inner corner, butt ends. Centre dashes 16 long, 8 wide, 13 apart,
none at the bend. Wordmark: Manrope ExtraBold (SIL OFL), outlined to paths. Get the font first:
  curl -L -o brand/fonts/Manrope.ttf "https://github.com/google/fonts/raw/main/ofl/manrope/Manrope%5Bwght%5D.ttf"
"""
import math
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

ASPHALT = "#1A1D23"   # near-black road
MARKING = "#FFC21A"   # road-marking yellow
PAPER = "#FFFFFF"

P0, P1, P2 = (36.0, 122.0), (98.0, 184.0), (222.0, 60.0)
H = 30.0               # half road width
D = H / math.sqrt(2)   # offset along each axis for 45-degree segments

f = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")


def road_outline():
    top0 = (P0[0] + D, P0[1] - D)
    inner = (P1[0], P1[1] - H * math.sqrt(2))
    top2 = (P2[0] - D, P2[1] - D)
    bot2 = (P2[0] + D, P2[1] + D)
    br = (P1[0] + D, P1[1] + D)
    bl = (P1[0] - D, P1[1] + D)
    bot0 = (P0[0] - D, P0[1] + D)
    pts = lambda *ps: " ".join(f"{f(x)} {f(y)}" for x, y in ps)
    return (f"M{pts(top0)} L{pts(inner)} L{pts(top2)} L{pts(bot2)} L{pts(br)} "
            f"A{f(H)} {f(H)} 0 0 1 {pts(bl)} L{pts(bot0)} Z")


def dashes():
    """Centre-line dashes as small rectangles (one subpath each)."""
    out = []
    for a, b in ((P0, (86.0, 172.0)), ((110.0, 172.0), P2)):
        L = math.dist(a, b)
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, ny = -uy * 4, ux * 4
        t, end = 8.0, L - 8.0   # keep the dashes off the road ends: no bites at the edges
        while t < end:
            t2 = min(t + 16, end)
            s = (a[0] + ux * t, a[1] + uy * t)
            e = (a[0] + ux * t2, a[1] + uy * t2)
            c = [(s[0] + nx, s[1] + ny), (e[0] + nx, e[1] + ny), (e[0] - nx, e[1] - ny), (s[0] - nx, s[1] - ny)]
            out.append("M" + " L".join(f"{f(x)} {f(y)}" for x, y in c) + " Z")
            t += 29
    return " ".join(out)


ROAD, DASH = road_outline(), dashes()


def svg(body, vb="0 0 256 256", title="Здай ПДР"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}">'
            f"<title>{title}</title>{body}</svg>\n")


def symbol(road=ASPHALT, mark=MARKING, holes=False, bg=None, scale=1.0, small=False):
    """holes: dashes cut out (one-colour files); else drawn in `mark` colour on top."""
    parts = []
    if bg:
        parts.append(f'<rect width="256" height="256" fill="{bg}"/>')
    g = "" if scale == 1 else f' transform="translate(128 128) scale({scale}) translate(-128 -128)"'
    if small:
        parts.append(f'<g{g}><path fill="{road}" d="{ROAD}"/></g>')
    elif holes or mark is None:
        parts.append(f'<g{g}><path fill="{road}" fill-rule="evenodd" d="{ROAD} {DASH}"/></g>')
    else:
        parts.append(f'<g{g}><path fill="{road}" d="{ROAD}"/><path fill="{mark}" d="{DASH}"/></g>')
    return "".join(parts)


def write(name, text):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        fh.write(text)


# ---------- symbol files ----------
write("zdaipdr-symbol.svg", svg(symbol()))                                  # colour, light backgrounds
write("zdaipdr-symbol-reversed.svg", svg(symbol(road=PAPER, holes=True)))   # dark backgrounds: dashes show the background
write("zdaipdr-symbol-black.svg", svg(symbol(road="#000", holes=True)))
write("zdaipdr-symbol-white.svg", svg(symbol(road="#FFF", holes=True)))
write("zdaipdr-symbol-small.svg", svg(symbol(small=True)))                  # 16-24 px: no dashes
# App icon on the marking-yellow tile: dark road, white dashes; the mark is scaled to sit inside
# the maskable safe zone (inner 80 %).
write("zdaipdr-app-icon.svg", svg(symbol(road=ASPHALT, mark=PAPER, bg=MARKING, scale=0.70)))
# Browser tab: rounded yellow tile and the road without dashes (they turn to noise at 16-32 px).
write("zdaipdr-favicon.svg", svg(
    f'<rect width="256" height="256" rx="56" fill="{MARKING}"/>' + symbol(road=ASPHALT, scale=0.86, small=True)))

# ---------- wordmark from Manrope ExtraBold ----------
src = TTFont(os.path.join(os.path.dirname(__file__), "fonts", "Manrope.ttf"))
font = instancer.instantiateVariableFont(src, {"wght": 800})
cmap, gs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]
upm = font["head"].unitsPerEm


def wordmark_paths(text, size, x0, baseline, color, tracking=-0.02):
    """Outlined text; returns (svg <path>, width)."""
    scale = size / upm
    x, d = x0, []
    for ch in text:
        if ch == " ":
            x += hmtx[cmap[ord(" ")]][0] * scale * 0.9
            continue
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[gname].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        d.append(pen.getCommands())
        x += hmtx[gname][0] * scale + tracking * size
    return f'<path fill="{color}" d="{" ".join(d)}"/>', x - x0


def cap_height():
    bp = BoundsPen(gs)
    gs[cmap[ord("П")]].draw(bp)
    return bp.bounds[3]


TEXT = "Здай ПДР"
ch = cap_height() / upm


def lockup_h(text_color, road, mark, name):
    # Symbol 256 high; cap height of the wordmark = 40 % of the symbol's road footprint height.
    size = 96 / ch
    wm, w = wordmark_paths(TEXT, size, 0, 0, text_color)
    gap = 28
    sym_w = 230
    total = sym_w + gap + w
    body = (f'<g transform="translate(-14 0)">{symbol(road=road, mark=mark)}</g>'
            f'<g transform="translate({f(sym_w + gap)} {f(128 + 96 / 2)})">{wm}</g>')
    write(name, svg(body, vb=f"-16 30 {f(total + 32)} 196"))


def lockup_v(text_color, road, mark, name):
    size = 64 / ch
    wm, w = wordmark_paths(TEXT, size, 0, 0, text_color)
    width = max(256, w)
    body = (f'<g transform="translate({f((width - 256) / 2)} 0)">{symbol(road=road, mark=mark)}</g>'
            f'<g transform="translate({f((width - w) / 2)} {f(256 + 64)})">{wm}</g>')
    write(name, svg(body, vb=f"0 30 {f(width)} {f(256 + 64 + 24 - 30)}"))


def wordmark_only(color, name):
    size = 96 / ch
    wm, w = wordmark_paths(TEXT, size, 0, 96, color)
    write(name, svg(wm, vb=f"0 -6 {f(w)} {f(96 + 26)}"))


lockup_h(ASPHALT, ASPHALT, MARKING, "zdaipdr-horizontal.svg")
lockup_h(PAPER, PAPER, None, "zdaipdr-horizontal-reversed.svg")
lockup_v(ASPHALT, ASPHALT, MARKING, "zdaipdr-stacked.svg")
lockup_v(PAPER, PAPER, None, "zdaipdr-stacked-reversed.svg")
wordmark_only(ASPHALT, "zdaipdr-wordmark.svg")
print("written:", sorted(os.listdir(OUT)))

# ---------- extra app icons ----------
# "any" icon: rounded tile, bigger mark (launchers that don't mask show the whole square).
write("zdaipdr-icon-any.svg", svg(f'<rect width="256" height="256" rx="56" fill="{MARKING}"/>'
                                  + symbol(road=ASPHALT, mark=PAPER, scale=0.80)))
# iOS rounds the corners itself: full-bleed tile, mark between the two sizes.
write("zdaipdr-apple-touch.svg", svg(symbol(road=ASPHALT, mark=PAPER, bg=MARKING, scale=0.76)))
