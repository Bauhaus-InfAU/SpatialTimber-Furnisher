"""Build out/dashboard.html — a self-contained findings dashboard.

Reads out/analysis.json (produced by analyze.py), embeds the aggregates as JSON,
and writes a single offline-openable HTML file (no CDN, no external assets).
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

with open(os.path.join(OUT, "analysis.json"), encoding="utf-8") as f:
    A = json.load(f)

# --- derived bits ------------------------------------------------------------

# "comfortable from" threshold per category: first area bin whose mean score
# crosses 75 (and is not an outlier dip afterwards).
thresholds = {}
for cat, bins in A["area_bins"].items():
    items = sorted(((int(b), v) for b, v in bins.items()), key=lambda kv: kv[0])
    cross = None
    for i, (b, v) in enumerate(items):
        if v["mean"] >= 75 and all(v2["mean"] >= 70 for _, v2 in items[i:i + 3]):
            cross = b
            break
    thresholds[cat] = cross

data = {
    "histogram": A["histogram"],
    "categories": A["categories"],
    "area_bins": A["area_bins"],
    "thresholds": thresholds,
    "by_nrooms": A["by_nrooms"],
    "by_area": A["by_area"],
    "shape_controlled": A["shape_controlled"],
    "exemplars": A["exemplars"],
    "totals": A["totals"],
}

TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Neufert 4.0 × SpatialTimber Furnisher — findings</title>
<style>
:root {
  --surface-1: #fcfcfb; --page: #f9f9f7;
  --ink-1: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #1baf7a;
  --o1: #86b6ef; --o2: #5598e7; --o3: #2a78d6; --o4: #184f95;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface-1: #1a1a19; --page: #0d0d0d;
    --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #199e70;
    --o1: #9ec5f4; --o2: #6da7ec; --o3: #3987e5; --o4: #1c5cab;
  }
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--page); color: var(--ink-1);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 32px 20px 80px;
}
.wrap { max-width: 1060px; margin: 0 auto; }
header h1 { font-size: 26px; font-weight: 650; letter-spacing: -0.01em; }
header .sub { color: var(--ink-2); margin-top: 8px; max-width: 72ch; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 26px 0 10px; }
.kpi { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.kpi .lbl { color: var(--ink-2); font-size: 13px; }
.kpi .val { font-size: 30px; font-weight: 650; margin-top: 2px; }
.kpi .note { color: var(--ink-3); font-size: 12px; margin-top: 2px; }
section.finding { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 22px 24px 18px; margin-top: 22px; }
.fnum { color: var(--ink-3); font-size: 12px; font-weight: 600; letter-spacing: 0.08em; }
section.finding h2 { font-size: 19px; font-weight: 650; margin: 3px 0 6px; }
section.finding .take { color: var(--ink-2); max-width: 76ch; margin-bottom: 14px; }
.panelrow { display: flex; flex-wrap: wrap; gap: 26px; }
.panel { flex: 1 1 340px; min-width: 300px; }
.panel h3 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
.chart { position: relative; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.tick { fill: var(--ink-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.cat-lbl { fill: var(--ink-2); font-size: 12px; }
.val-lbl { fill: var(--ink-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.anno { fill: var(--ink-3); font-size: 11px; }
.gridline { stroke: var(--grid); stroke-width: 1; }
.axisline { stroke: var(--axis); stroke-width: 1; }
.refline { stroke: var(--axis); stroke-width: 1; }
.facet-title { fill: var(--ink-1); font-size: 12px; font-weight: 600; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin: 4px 0 10px; color: var(--ink-2); font-size: 12.5px; }
.legend .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 6px; }
.caption { color: var(--ink-3); font-size: 12.5px; margin-top: 10px; max-width: 80ch; }
details.tbl { margin-top: 10px; }
details.tbl summary { color: var(--ink-3); font-size: 12.5px; cursor: pointer; }
details.tbl table { border-collapse: collapse; margin-top: 8px; font-size: 12.5px; }
details.tbl th, details.tbl td { border: 1px solid var(--grid); padding: 4px 10px; text-align: right; font-variant-numeric: tabular-nums; }
details.tbl th:first-child, details.tbl td:first-child { text-align: left; }
details.tbl th { color: var(--ink-2); font-weight: 600; }
#tooltip {
  position: fixed; pointer-events: none; z-index: 10; display: none;
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.18); padding: 8px 11px; font-size: 12.5px; max-width: 260px;
}
#tooltip .tv { font-weight: 650; font-size: 14px; }
#tooltip .tl { color: var(--ink-2); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.chip {
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  background: var(--page); border: 1px solid var(--border); border-radius: 7px;
  padding: 5px 9px; cursor: pointer; color: var(--ink-2);
}
.chip:hover { border-color: var(--ink-3); }
.chip .sc { color: var(--ink-1); font-weight: 600; }
footer { color: var(--ink-3); font-size: 12.5px; margin-top: 28px; max-width: 86ch; }
footer h4 { color: var(--ink-2); font-size: 13px; margin-bottom: 6px; }
footer ul { padding-left: 18px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>How furnishable are Swiss apartments?</h1>
  <p class="sub">The <strong>SpatialTimber Furnisher</strong> automatically places furniture in floor
  plans and scores each room 0–100 by how much placement freedom it found. We ran it over the
  <strong>Neufert&nbsp;4.0 dataset</strong> (20,419 residential apartments derived from the Swiss
  Dwellings dataset). An apartment's score is the area-weighted mean of its room scores.
  Five findings below; every apartment id can be opened interactively in the furnisher app's
  dataset browser ("go to id…").</p>
</header>

<div class="kpis" id="kpis"></div>

<section class="finding">
  <div class="fnum">FINDING 1</div>
  <h2>Most apartments furnish well — the tail is thin but real</h2>
  <p class="take">Half of all apartments score above <strong>84</strong>, and 3.4% reach a perfect 100.
  But roughly 1 in 27 falls below 60 — apartments where a substantial share of the floor area
  resists standard furniture placement.</p>
  <div class="panel"><h3>Apartments by score (bins of 5)</h3><div class="chart" id="c-hist"></div></div>
  <details class="tbl" id="t-hist"><summary>Table view</summary></details>
</section>

<section class="finding">
  <div class="fnum">FINDING 2</div>
  <h2>Kitchens are the bottleneck — bedrooms are almost never the problem</h2>
  <p class="take">Sleeping rooms nearly always furnish (children's rooms average <strong>97</strong>, bedrooms
  <strong>93</strong>). Kitchens average just <strong>51</strong> — in <strong>40%</strong> of them the engine finds
  <em>no valid placement at all</em> for the kitchen block. Small WCs are the second weak spot
  (23% unfurnishable: toilet + sink don't fit together).</p>
  <div class="panelrow">
    <div class="panel"><h3>Mean room score by room type</h3><div class="chart" id="c-catscore"></div></div>
    <div class="panel"><h3>Rooms with no valid placement (score 0)</h3><div class="chart" id="c-catzero"></div></div>
  </div>
  <details class="tbl" id="t-cat"><summary>Table view</summary></details>
</section>

<section class="finding">
  <div class="fnum">FINDING 3</div>
  <h2>Every room type has a minimum viable size — and it's sharp</h2>
  <p class="take">Mean score climbs steeply with room area and then saturates. The knee is remarkably
  consistent per room type: bathrooms work from ≈<strong>4&nbsp;m²</strong>, WCs from ≈<strong>3&nbsp;m²</strong>,
  children's rooms from ≈<strong>8&nbsp;m²</strong>, bedrooms from ≈<strong>12&nbsp;m²</strong> — but kitchens only
  become reliable around <strong>12–15&nbsp;m²</strong>, well above the typical Swiss kitchen (median ≈8&nbsp;m²).
  Living rooms saturate lower because they must fit two furniture groups (sofa + dining).</p>
  <div class="chart" id="c-facets"></div>
  <p class="caption">Each panel: mean score per 1&nbsp;m² area bin (bins with ≥30 rooms). The horizontal
  reference line marks score 75; the marker ▲ shows where the curve first crosses it.</p>
  <details class="tbl" id="t-facets"><summary>Table view</summary></details>
</section>

<section class="finding">
  <div class="fnum">FINDING 4</div>
  <h2>Generous apartments score better — extra rooms at the same size don't</h2>
  <p class="take">Score <em>falls</em> with room count (1-room apartments average <strong>87</strong>, 4-room
  apartments <strong>79</strong>) yet <em>rises</em> with floor area beyond ≈120&nbsp;m². Subdividing a given
  area into more rooms produces tighter rooms below their viable size — the room-count penalty is
  really a room-size penalty in disguise.</p>
  <div class="panelrow">
    <div class="panel"><h3>Apartment score by room count (median, IQR)</h3><div class="chart" id="c-nrooms"></div></div>
    <div class="panel"><h3>Apartment score by total area (median, IQR)</h3><div class="chart" id="c-area"></div></div>
  </div>
  <details class="tbl" id="t-apt"><summary>Table view</summary></details>
</section>

<section class="finding">
  <div class="fnum">FINDING 5</div>
  <h2>Complex room shapes cost points — but only where furniture hugs the walls</h2>
  <p class="take">Comparing rooms of the <em>same size</em>: a non-orthogonal kitchen of 10–15&nbsp;m² scores
  <strong>16 points lower</strong> than a rectangular one; a complex-shaped bedroom loses ≈<strong>11
  points</strong>. Living rooms are indifferent to shape — sofa and dining groups are flexible, so only
  size matters there. Slanted walls are expensive exactly where fitted furniture (kitchen runs,
  wardrobes) needs straight wall segments.</p>
  <div class="legend" id="lg-shape"></div>
  <div class="chart" id="c-shape"></div>
  <details class="tbl" id="t-shape"><summary>Table view</summary></details>
</section>

<section class="finding">
  <div class="fnum">EXPLORE</div>
  <h2>Look at the outliers yourself</h2>
  <p class="take">Open the furnisher app, load the dataset bundle in the "Dataset browser", and paste an
  id into <em>go&nbsp;to&nbsp;id…</em> (click a chip to copy). The furnished layout, and all its
  alternatives, render interactively.</p>
  <h3 style="font-size:13px;color:var(--ink-2);margin-top:6px">Hardest to furnish</h3>
  <div class="chips" id="chips-worst"></div>
  <h3 style="font-size:13px;color:var(--ink-2);margin-top:12px">Large and flawless (score 100, ≥100 m²)</h3>
  <div class="chips" id="chips-best"></div>
</section>

<footer>
  <h4>Method &amp; caveats</h4>
  <ul>
    <li>Score measures <em>placement flexibility</em> of the SpatialTimber furnisher engine
      (0&nbsp;=&nbsp;a required piece cannot be placed; 100&nbsp;=&nbsp;every piece had multiple good positions).
      It is not a general habitability index.</li>
    <li>26% of the dataset are geometric duplicates; each unique layout was computed once and the result
      copied to its duplicates. Corridors, balconies and storage are excluded from scoring.</li>
    <li>3.1% of rooms failed geometric preprocessing after retries and are excluded from their
      apartment's score. Generic "ROOM" areas were classified by size (largest → living room, then
      bedroom, then children's rooms). Bathroom vs WC decided by presence of bathtub/shower.</li>
    <li>Shape classes use a 4° angle tolerance: rectangle, L-shape, orthogonal-complex (more corners,
      all ≈90°), non-orthogonal (any slanted wall).</li>
    <li>Data: Neufert 4.0, Bauhaus-Universität Weimar (CC-BY 4.0), zenodo.org/records/14223942.</li>
  </ul>
</footer>
</div>
<div id="tooltip"></div>
<script>
const DATA = __DATA__;
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const fmt = (n) => n.toLocaleString("en-US");

// ---------- tooltip ----------
const tip = $("tooltip");
function showTip(ev, valueHtmlSafe, label) {
  tip.style.display = "block";
  tip.replaceChildren();
  const v = document.createElement("div"); v.className = "tv"; v.textContent = valueHtmlSafe;
  const l = document.createElement("div"); l.className = "tl"; l.textContent = label;
  tip.append(v, l);
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip() { tip.style.display = "none"; }

function svg(w, h) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return s;
}
function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function txt(parent, x, y, cls, str, anchor) {
  const t = el("text", { x, y, class: cls, ...(anchor ? { "text-anchor": anchor } : {}) }, parent);
  t.textContent = str;
  return t;
}
// column with rounded top, square baseline
function colPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function barPath(x, y, w, h, r) { // horizontal, rounded right end
  r = Math.min(r, h / 2, w);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}
function hover(e, value, label) {
  e.style.cursor = "default";
  e.addEventListener("pointermove", (ev) => showTip(ev, value, label));
  e.addEventListener("pointerleave", hideTip);
}

// ---------- KPI row ----------
(function () {
  const t = DATA.totals;
  const kitchen = DATA.categories["Kitchen"];
  const items = [
    { lbl: "Apartments scored", val: fmt(t.apartments), note: fmt(t.unique) + " unique layouts (26% duplicates)" },
    { lbl: "Median apartment score", val: "84", note: "area-weighted, 0–100" },
    { lbl: "Rooms evaluated", val: fmt(t.rooms), note: "6 room types, corridors excluded" },
    { lbl: "Kitchens unfurnishable", val: kitchen.zero_pct + "%", note: "no valid kitchen-block placement" },
  ];
  for (const it of items) {
    const d = document.createElement("div"); d.className = "kpi";
    const l = document.createElement("div"); l.className = "lbl"; l.textContent = it.lbl;
    const v = document.createElement("div"); v.className = "val"; v.textContent = it.val;
    const n = document.createElement("div"); n.className = "note"; n.textContent = it.note;
    d.append(l, v, n); $("kpis").appendChild(d);
  }
})();

// ---------- helpers for tables ----------
function makeTable(host, header, rows) {
  const tb = document.createElement("table");
  const tr = document.createElement("tr");
  for (const h of header) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); }
  tb.appendChild(tr);
  for (const r of rows) {
    const tr2 = document.createElement("tr");
    for (const c of r) { const td = document.createElement("td"); td.textContent = c; tr2.appendChild(td); }
    tb.appendChild(tr2);
  }
  host.appendChild(tb);
}

// ---------- F1: histogram ----------
(function () {
  const bins = Object.entries(DATA.histogram).map(([b, n]) => [+b, n]).sort((a, b) => a[0] - b[0]);
  const W = 980, H = 300, mL = 46, mB = 30, mT = 14, mR = 8;
  const s = svg(W, H);
  const maxN = Math.max(...bins.map((b) => b[1]));
  const yMax = Math.ceil(maxN / 1000) * 1000;
  const pw = W - mL - mR, ph = H - mT - mB;
  const bw = pw / bins.length;
  for (let g = 0; g <= 4; g++) {
    const yv = (yMax / 4) * g, y = mT + ph - (yv / yMax) * ph;
    el("line", { x1: mL, x2: W - mR, y1: y, y2: y, class: g === 0 ? "axisline" : "gridline" }, s);
    txt(s, mL - 8, y + 4, "tick", fmt(yv), "end");
  }
  bins.forEach(([b, n], i) => {
    const h = (n / yMax) * ph;
    const x = mL + i * bw + 1, w = bw - 2; // 2px surface gap
    const p = el("path", { d: colPath(x, mT + ph - h, w, h, 4), fill: "var(--s1)" }, s);
    hover(p, fmt(n) + " apartments", `score ${b}–${b === 100 ? 100 : b + 4}`);
    if (b % 10 === 0) txt(s, mL + i * bw + bw / 2, H - 8, "tick", b, "middle");
  });
  // median annotation
  const medX = mL + ((84 - bins[0][0]) / 5) * bw;
  el("line", { x1: medX, x2: medX, y1: mT, y2: mT + ph, class: "refline", "stroke-dasharray": "" }, s);
  txt(s, medX + 6, mT + 12, "anno", "median 84");
  $("c-hist").appendChild(s);
  makeTable($("t-hist"), ["score bin", "apartments"], bins.map(([b, n]) => [`${b}–${b === 100 ? 100 : b + 4}`, fmt(n)]));
})();

// ---------- F2: category bars ----------
(function () {
  const order = ["Children", "Bedroom", "Living room", "Bathroom", "WC", "Kitchen"];
  const rowH = 34, mL = 92, mR = 46, W = 470;
  function catBars(hostId, get, color, unit) {
    const H = order.length * rowH + 26;
    const s = svg(W, H);
    const pw = W - mL - mR;
    const maxV = 100;
    for (let g = 0; g <= 4; g++) {
      const xv = 25 * g, x = mL + (xv / maxV) * pw;
      el("line", { x1: x, x2: x, y1: 4, y2: H - 22, class: g === 0 ? "axisline" : "gridline" }, s);
      txt(s, x, H - 6, "tick", xv + (unit === "%" ? "%" : ""), "middle");
    }
    order.forEach((cat, i) => {
      const v = get(DATA.categories[cat]);
      const y = 8 + i * rowH, bh = 20;
      const w = Math.max((v / maxV) * pw, 2);
      txt(s, mL - 8, y + bh / 2 + 4, "cat-lbl", cat, "end");
      const p = el("path", { d: barPath(mL, y, w, bh, 4), fill: color }, s);
      hover(p, v + (unit === "%" ? "%" : ""), cat + (unit === "%" ? " — rooms with score 0" : " — mean room score"));
      txt(s, mL + w + 6, y + bh / 2 + 4, "val-lbl", v + (unit === "%" ? "%" : ""));
    });
    $(hostId).appendChild(s);
  }
  catBars("c-catscore", (c) => c.mean, "var(--s1)", "");
  catBars("c-catzero", (c) => c.zero_pct, "var(--s2)", "%");
  makeTable($("t-cat"), ["room type", "rooms", "mean score", "median", "score 0 %", "perfect %"],
    order.map((c) => { const v = DATA.categories[c]; return [c, fmt(v.n), v.mean, v.median, v.zero_pct + "%", v.perfect_pct + "%"]; }));
})();

// ---------- F3: small multiples ----------
(function () {
  const cats = ["Kitchen", "Bathroom", "WC", "Bedroom", "Children", "Living room"];
  const cols = 3, fw = 316, fh = 200, gapX = 16, gapY = 26;
  const W = cols * fw + (cols - 1) * gapX;
  const rows = Math.ceil(cats.length / cols);
  const H = rows * fh + (rows - 1) * gapY;
  const s = svg(W, H);
  const mL = 34, mB = 26, mT = 22, mR = 6;
  const tableRows = [];
  cats.forEach((cat, ci) => {
    const gx = (ci % cols) * (fw + gapX), gy = Math.floor(ci / cols) * (fh + gapY);
    const g = el("g", { transform: `translate(${gx},${gy})` }, s);
    const bins = Object.entries(DATA.area_bins[cat]).map(([b, v]) => [+b, v]).sort((a, b) => a[0] - b[0]).slice(0, 22);
    const xMin = bins[0][0], xMax = bins[bins.length - 1][0];
    const pw = fw - mL - mR, ph = fh - mT - mB;
    const X = (a) => mL + ((a - xMin) / Math.max(xMax - xMin, 1)) * pw;
    const Y = (v) => mT + ph - (v / 100) * ph;
    txt(g, mL, 12, "facet-title", cat);
    for (const yv of [0, 50, 100]) {
      el("line", { x1: mL, x2: fw - mR, y1: Y(yv), y2: Y(yv), class: yv === 0 ? "axisline" : "gridline" }, g);
      txt(g, mL - 6, Y(yv) + 4, "tick", yv, "end");
    }
    el("line", { x1: mL, x2: fw - mR, y1: Y(75), y2: Y(75), class: "refline", opacity: 0.7 }, g);
    const xticks = [xMin, Math.round((xMin + xMax) / 2), xMax];
    for (const xv of xticks) txt(g, X(xv), fh - 8, "tick", xv + " m²", "middle");
    const d = bins.map(([b, v], i) => (i ? "L" : "M") + X(b).toFixed(1) + "," + Y(v.mean).toFixed(1)).join(" ");
    el("path", { d, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, g);
    bins.forEach(([b, v]) => {
      const hit = el("rect", { x: X(b) - 8, y: mT, width: 16, height: ph, fill: "transparent" }, g);
      hover(hit, v.mean + " mean score", `${cat} ${b}–${b + 1} m² · ${v.zero_pct}% unfurnishable · n=${fmt(v.n)}`);
      tableRows.push([cat, b + " m²", v.mean, v.zero_pct + "%", fmt(v.n)]);
    });
    const th = DATA.thresholds[cat];
    if (th !== null && th !== undefined) {
      txt(g, X(th), Y(0) - 4 - 8, "anno", "▲", "middle").setAttribute("y", Y(75) + 16);
      txt(g, X(th) + 8, Y(75) + 16, "anno", "≈" + th + " m²");
    }
  });
  $("c-facets").appendChild(s);
  makeTable($("t-facets"), ["room type", "area bin", "mean score", "score 0 %", "rooms"], tableRows);
})();

// ---------- F4: apartment size ----------
(function () {
  // panel a: columns by nrooms with IQR whiskers
  const W = 470, H = 280, mL = 44, mB = 30, mT = 16, mR = 8;
  const s = svg(W, H);
  const entries = Object.entries(DATA.by_nrooms).map(([k, v]) => [+k, v]).sort((a, b) => a[0] - b[0]);
  const pw = W - mL - mR, ph = H - mT - mB;
  const Y = (v) => mT + ph - (v / 100) * ph;
  for (const yv of [0, 25, 50, 75, 100]) {
    el("line", { x1: mL, x2: W - mR, y1: Y(yv), y2: Y(yv), class: yv === 0 ? "axisline" : "gridline" }, s);
    txt(s, mL - 8, Y(yv) + 4, "tick", yv, "end");
  }
  const slot = pw / entries.length;
  entries.forEach(([nr, v], i) => {
    const cx = mL + slot * i + slot / 2, bw = Math.min(24, slot - 24);
    const p = el("path", { d: colPath(cx - bw / 2, Y(v.median), bw, Y(0) - Y(v.median), 4), fill: "var(--s1)" }, s);
    hover(p, "median " + v.median, `${nr}-room · IQR ${v.q1}–${v.q3} · n=${fmt(v.n)}`);
    el("line", { x1: cx, x2: cx, y1: Y(v.q3), y2: Y(v.q1), stroke: "var(--ink-3)", "stroke-width": 1.5 }, s);
    el("line", { x1: cx - 5, x2: cx + 5, y1: Y(v.q3), y2: Y(v.q3), stroke: "var(--ink-3)", "stroke-width": 1.5 }, s);
    el("line", { x1: cx - 5, x2: cx + 5, y1: Y(v.q1), y2: Y(v.q1), stroke: "var(--ink-3)", "stroke-width": 1.5 }, s);
    txt(s, cx, H - 8, "tick", nr + "r" + (nr === 5 ? "+" : ""), "middle");
    txt(s, cx, Y(v.q3) - 7, "val-lbl", v.median, "middle");
  });
  $("c-nrooms").appendChild(s);

  // panel b: median line + IQR band by area bin
  const s2 = svg(W, H);
  const ab = Object.entries(DATA.by_area).map(([k, v]) => [+k + 10, v]).sort((a, b) => a[0] - b[0]);
  const xMin = ab[0][0], xMax = ab[ab.length - 1][0];
  const X2 = (a) => mL + ((a - xMin) / (xMax - xMin)) * pw;
  for (const yv of [0, 25, 50, 75, 100]) {
    el("line", { x1: mL, x2: W - mR, y1: Y(yv), y2: Y(yv), class: yv === 0 ? "axisline" : "gridline" }, s2);
    txt(s2, mL - 8, Y(yv) + 4, "tick", yv, "end");
  }
  const band = ab.map(([a, v], i) => (i ? "L" : "M") + X2(a).toFixed(1) + "," + Y(v.q3).toFixed(1)).join(" ")
    + " " + [...ab].reverse().map(([a, v]) => "L" + X2(a).toFixed(1) + "," + Y(v.q1).toFixed(1)).join(" ") + " Z";
  el("path", { d: band, fill: "var(--s1)", opacity: 0.1 }, s2);
  const line = ab.map(([a, v], i) => (i ? "L" : "M") + X2(a).toFixed(1) + "," + Y(v.median).toFixed(1)).join(" ");
  el("path", { d: line, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, s2);
  ab.forEach(([a, v]) => {
    const hit = el("rect", { x: X2(a) - 10, y: mT, width: 20, height: ph, fill: "transparent" }, s2);
    hover(hit, "median " + v.median, `${a - 10}–${a + 9} m² · IQR ${v.q1}–${v.q3} · n=${fmt(v.n)}`);
  });
  for (const xv of [40, 80, 120, 160]) txt(s2, X2(xv), H - 8, "tick", xv + " m²", "middle");
  $("c-area").appendChild(s2);

  makeTable($("t-apt"), ["group", "n", "median", "q1", "q3"],
    entries.map(([nr, v]) => [nr + "-room", fmt(v.n), v.median, v.q1, v.q3])
      .concat(ab.map(([a, v]) => [`${a - 10}–${a + 9} m²`, fmt(v.n), v.median, v.q1, v.q3])));
})();

// ---------- F5: shape (ordinal grouped bars) ----------
(function () {
  const groups = [
    { key: "Kitchen|10-15", label: "Kitchen 10–15 m²" },
    { key: "Bedroom|10-15", label: "Bedroom 10–15 m²" },
    { key: "Living room|15-20", label: "Living room 15–20 m²" },
  ];
  const shapes = ["rectangle", "L-shape", "ortho-complex", "non-ortho"];
  const shapeLbl = { rectangle: "rectangle", "L-shape": "L-shape", "ortho-complex": "many corners (90°)", "non-ortho": "slanted walls" };
  const colors = ["var(--o1)", "var(--o2)", "var(--o3)", "var(--o4)"];
  // legend
  shapes.forEach((sh, i) => {
    const it = document.createElement("span");
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = colors[i];
    it.append(sw, document.createTextNode(shapeLbl[sh]));
    $("lg-shape").appendChild(it);
  });
  const W = 980, H = 300, mL = 44, mB = 30, mT = 16, mR = 8;
  const s = svg(W, H);
  const pw = W - mL - mR, ph = H - mT - mB;
  const Y = (v) => mT + ph - (v / 100) * ph;
  for (const yv of [0, 25, 50, 75, 100]) {
    el("line", { x1: mL, x2: W - mR, y1: Y(yv), y2: Y(yv), class: yv === 0 ? "axisline" : "gridline" }, s);
    txt(s, mL - 8, Y(yv) + 4, "tick", yv, "end");
  }
  const gslot = pw / groups.length;
  const rows = [];
  groups.forEach((gr, gi) => {
    const data = DATA.shape_controlled[gr.key];
    const bw = 24, gap = 2;
    const total = shapes.length * bw + (shapes.length - 1) * gap;
    const x0 = mL + gslot * gi + (gslot - total) / 2;
    shapes.forEach((sh, si) => {
      const v = data[sh];
      if (!v) return;
      const x = x0 + si * (bw + gap);
      const p = el("path", { d: colPath(x, Y(v.mean), bw, Y(0) - Y(v.mean), 4), fill: colors[si] }, s);
      hover(p, v.mean + " mean score", `${gr.label} · ${shapeLbl[sh]} · n=${fmt(v.n)}`);
      txt(s, x + bw / 2, Y(v.mean) - 6, "val-lbl", v.mean, "middle");
      rows.push([gr.label, shapeLbl[sh], v.mean, fmt(v.n)]);
    });
    txt(s, mL + gslot * gi + gslot / 2, H - 8, "tick", gr.label, "middle");
  });
  $("c-shape").appendChild(s);
  makeTable($("t-shape"), ["rooms", "shape", "mean score", "n"], rows);
})();

// ---------- exemplars ----------
(function () {
  function chips(hostId, list) {
    for (const a of list) {
      const c = document.createElement("button"); c.className = "chip";
      c.title = "click to copy id";
      const sc = document.createElement("span"); sc.className = "sc"; sc.textContent = a.score;
      c.append(sc, document.createTextNode(` · ${Math.round(a.area || 0)} m² · ${a.id}`));
      c.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(a.id); c.style.borderColor = "var(--s2)"; setTimeout(() => c.style.borderColor = "", 900); } catch {}
      });
      $(hostId).appendChild(c);
    }
  }
  chips("chips-worst", DATA.exemplars.worst);
  chips("chips-best", DATA.exemplars.best_large);
})();
</script>
</body>
</html>
"""

html = TEMPLATE.replace("__DATA__", json.dumps(data, separators=(",", ":")))
out_path = os.path.join(OUT, "dashboard.html")
with open(out_path, "w", encoding="utf-8") as f:
    f.write(html)
print(f"wrote {out_path} ({len(html) // 1024} KB)")
