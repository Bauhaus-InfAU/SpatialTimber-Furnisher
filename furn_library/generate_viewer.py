"""
FURNITURE LIBRARY VIEWER GENERATOR
====================================
Reads furniture_library.json and embeds it into a self-contained viewer.html.
Run this script any time you rebuild the library.

Usage:
    python generate_viewer.py

Output:
    viewer.html  (same folder as this script)
"""

import json
import glob
import os
from collections import defaultdict

# ── paths ────────────────────────────────────────────────────────────────────
HERE        = os.path.dirname(os.path.abspath(__file__))
LIBRARY_FILE = os.path.join(HERE, "furniture_library.json")
OUTPUT      = os.path.join(HERE, "viewer.html")

# ── read furniture_library.json ───────────────────────────────────────────────
if not os.path.exists(LIBRARY_FILE):
    raise FileNotFoundError(
        f"furniture_library.json not found at {LIBRARY_FILE}\n"
        f"Run build_library.py first to generate it."
    )

with open(LIBRARY_FILE, encoding="utf-8") as f:
    full_library = json.load(f)

# ── organise into viewer structure ────────────────────────────────────────────
# library[aptType][room] = [ { furnitureName, importance, score, variants } ]
library = defaultdict(lambda: defaultdict(list))
rooms_per_apt = defaultdict(set)

for entry in full_library.get("furniture", []):
    apt   = str(entry.get("apartmentType", "?"))
    room  = entry.get("category", "Unknown")
    fname = entry.get("furnitureName", entry.get("id", "?"))

    for piece in entry.get("pieces", []):
        library[apt][room].append({
            "furnitureName": fname,
            "importance":    piece.get("importance", 0),
            "score":         piece.get("score", 0),
            "variants":      piece.get("variants", [])
        })
        rooms_per_apt[apt].add(room)

# sort rooms alphabetically per apt type
rooms_per_apt = { apt: sorted(rooms) for apt, rooms in sorted(rooms_per_apt.items()) }

# serialise to JSON for embedding
library_json    = json.dumps(library,       separators=(",", ":"), ensure_ascii=False)
rooms_json      = json.dumps(rooms_per_apt, separators=(",", ":"), ensure_ascii=False)
apt_types       = sorted(library.keys(), key=int)

lib_meta = full_library.get("count", {})
lib_generated = full_library.get("generated", "")

# ── HTML template ─────────────────────────────────────────────────────────────
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Furniture Library Viewer</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}

  :root {{
    --bg:        #161616;
    --surface:   #1f1f1f;
    --surface2:  #2a2a2a;
    --border:    #333;
    --text:      #e0e0e0;
    --muted:     #666;
    --accent:    #5b8fff;
    --orange:    #ff6644;
    --green:     #6abf69;
    --purple:    #9d7fd4;
  }}

  body {{
    background: var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }}

  /* ── top bar ── */
  #topbar {{
    flex-shrink: 0;
    padding: 14px 20px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }}

  #topbar h1 {{
    font-size: 11px;
    font-weight: 500;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 12px;
  }}

  .selector-row {{
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }}

  .selector-label {{
    font-size: 10px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    width: 36px;
    flex-shrink: 0;
  }}

  .btn-group {{ display: flex; gap: 5px; flex-wrap: wrap; }}

  .pill {{
    padding: 4px 13px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    transition: all .15s;
  }}
  .pill:hover  {{ border-color: #555; color: var(--text); }}
  .pill.active {{ background: var(--accent); border-color: var(--accent); color: #fff; }}

  #stats {{
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
  }}

  /* ── furniture grid ── */
  #grid-wrapper {{
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }}

  #grid {{
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-start;
  }}

  /* ── furniture card ── */
  .furn-card {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    width: 220px;
    flex-shrink: 0;
  }}

  .card-header {{
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
  }}

  .card-title {{
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 6px;
  }}

  .badges {{ display: flex; gap: 5px; flex-wrap: wrap; }}

  .badge {{
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 20px;
    font-weight: 500;
  }}
  .badge-imp   {{ background:#2a2a3a; color:#8888cc; border:1px solid #3a3a55; }}
  .badge-score {{ background:#1e2e1e; color:#77aa77; border:1px solid #2e442e; }}
  .badge-var   {{ background:#2a1e2a; color:#cc88cc; border:1px solid #44244a; }}

  /* ── variants strip ── */
  .variants-strip {{
    display: flex;
    flex-direction: column;
    gap: 0;
  }}

  .variant-block {{
    padding: 10px 10px 6px;
    border-bottom: 1px solid #252525;
  }}
  .variant-block:last-child {{ border-bottom: none; }}

  .variant-label {{
    font-size: 10px;
    color: var(--muted);
    letter-spacing: .08em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }}

  canvas {{
    display: block;
    background: #141414;
    border-radius: 4px;
    width: 196px;
    height: 180px;
  }}

  .legend {{
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 5px;
  }}
  .legend-item {{
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    color: var(--muted);
  }}
  .legend-dot {{
    width: 10px; height: 3px;
    border-radius: 2px;
    flex-shrink: 0;
  }}

  /* ── empty state ── */
  #empty {{
    color: var(--muted);
    font-size: 13px;
    padding: 40px 0;
    width: 100%;
    text-align: center;
    display: none;
  }}
</style>
</head>
<body>

<div id="topbar">
  <h1>Furniture Library — Viewer &nbsp;<span style="font-weight:400;color:#444">v{full_library.get("version","?")} · built {lib_generated}</span></h1>

  <div class="selector-row">
    <span class="selector-label">Apt</span>
    <div class="btn-group" id="apt-btns"></div>
  </div>

  <div class="selector-row">
    <span class="selector-label">Room</span>
    <div class="btn-group" id="room-btns"></div>
  </div>

  <div id="stats"></div>
</div>

<div id="grid-wrapper">
  <div id="grid"></div>
  <div id="empty">No furniture found for this combination.</div>
</div>

<script>
// ── embedded data ────────────────────────────────────────────────────────────
const LIBRARY   = {library_json};
const ROOMS     = {rooms_json};
const APT_TYPES = {json.dumps(apt_types)};

// ── state ────────────────────────────────────────────────────────────────────
let selApt  = APT_TYPES[0];
let selRoom = null;

// ── geometry helpers ─────────────────────────────────────────────────────────
const CURVE_COLORS = ["#7ec8e3","#f0c060","#80cc80","#e388cc","#e07060",
                      "#60d0d0","#c8a060","#8080e8"];

function allPoints(variants) {{
  const pts = [];
  for (const v of variants) {{
    for (const c of (v.geometry || [])) for (const p of c.points) pts.push(p);
    if (v.linePlacement?.points) for (const p of v.linePlacement.points) pts.push(p);
    if (v.bboxBig)    for (const p of boxCorners(v.bboxBig))    pts.push(p);
    if (v.bboxSmall)  for (const p of boxCorners(v.bboxSmall))  pts.push(p);
  }}
  return pts;
}}

function boundsOf(pts) {{
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const [x,y] of pts) {{
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
  }}
  return {{minX, minY, maxX, maxY}};
}}

function boxCorners(box) {{
  if (!box) return [];
  // prefer the exact exported corners (avoids CW/CCW winding ambiguity)
  if (box.points && box.points.length >= 4) return box.points.slice(0, 4);
  // fallback: reconstruct from origin + width + height + rotation
  const {{origin:[ox,oy], width:w, height:h, rotation:deg}} = box;
  const rad = (deg||0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [
    [ox,                  oy                 ],
    [ox + w*cos,          oy + w*sin         ],
    [ox + w*cos - h*sin,  oy + w*sin + h*cos ],
    [ox         - h*sin,  oy         + h*cos ]
  ];
}}

function makeToCanvas(bounds, W, H, PAD) {{
  const rX = bounds.maxX - bounds.minX || 1;
  const rY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((W-PAD*2)/rX, (H-PAD*2)/rY);
  const offX = PAD + ((W-PAD*2) - rX*scale)/2;
  const offY = PAD + ((H-PAD*2) - rY*scale)/2;
  return {{
    fn: ([x,y]) => [ offX+(x-bounds.minX)*scale,  H-offY-(y-bounds.minY)*scale ],
    scale
  }};
}}

function drawVariant(canvas, variant, bounds) {{
  const W=canvas.width, H=canvas.height, PAD=16;
  const {{fn:tc, scale}} = makeToCanvas(bounds, W, H, PAD);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,W,H);

  // geometry curves
  (variant.geometry||[]).forEach((curve, ci) => {{
    if (!curve.points?.length) return;
    ctx.beginPath();
    const [sx,sy] = tc(curve.points[0]);
    ctx.moveTo(sx,sy);
    for (let i=1;i<curve.points.length;i++) {{
      const [px,py]=tc(curve.points[i]); ctx.lineTo(px,py);
    }}
    if (curve.closed) ctx.closePath();
    ctx.strokeStyle = CURVE_COLORS[ci % CURVE_COLORS.length];
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }});

  // bboxes (dashed)
  function drawBox(box, color, dash) {{
    if (!box) return;
    const corners = boxCorners(box);
    ctx.beginPath();
    const [sx,sy]=tc(corners[0]); ctx.moveTo(sx,sy);
    for(let i=1;i<4;i++){{ const[px,py]=tc(corners[i]); ctx.lineTo(px,py); }}
    ctx.closePath();
    ctx.strokeStyle=color; ctx.lineWidth=1;
    ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
  }}
  drawBox(variant.bboxBig,   "rgba(255,255,255,0.35)", [5,3]);
  drawBox(variant.bboxSmall, "rgba(255,255,255,0.18)", [3,4]);

  // line placement
  const lp = variant.linePlacement;
  if (lp?.points?.length >= 2) {{
    ctx.beginPath();
    const [sx,sy]=tc(lp.points[0]); ctx.moveTo(sx,sy);
    for(let i=1;i<lp.points.length;i++){{ const[px,py]=tc(lp.points[i]); ctx.lineTo(px,py); }}
    ctx.strokeStyle="#ff6644"; ctx.lineWidth=2.5; ctx.stroke();
    lp.points.forEach(p=>{{
      const[px,py]=tc(p);
      ctx.beginPath(); ctx.arc(px,py,3,0,Math.PI*2);
      ctx.fillStyle="#ff6644"; ctx.fill();
    }});
  }}
}}

// ── render ───────────────────────────────────────────────────────────────────
function renderCard(item) {{
  const variants = item.variants;

  // shared bounds across all variants (so all draw at same scale)
  const bounds = boundsOf(allPoints(variants));

  const card = document.createElement("div");
  card.className = "furn-card";

  // header
  const hdr = document.createElement("div");
  hdr.className = "card-header";
  hdr.innerHTML = `
    <div class="card-title">${{item.furnitureName}}</div>
    <div class="badges">
      <span class="badge badge-imp">importance ${{item.importance}}</span>
      <span class="badge badge-score">score ${{item.score}}</span>
      <span class="badge badge-var">${{variants.length}} variant${{variants.length!==1?"s":""}}</span>
    </div>`;
  card.appendChild(hdr);

  // variants
  const strip = document.createElement("div");
  strip.className = "variants-strip";

  variants.forEach((v, vi) => {{
    const block = document.createElement("div");
    block.className = "variant-block";

    if (variants.length > 1) {{
      const lbl = document.createElement("div");
      lbl.className = "variant-label";
      lbl.textContent = `variant ${{vi + 1}} of ${{variants.length}}`;
      block.appendChild(lbl);
    }}

    const canvas = document.createElement("canvas");
    canvas.width = 196; canvas.height = 180;
    block.appendChild(canvas);
    requestAnimationFrame(() => drawVariant(canvas, v, bounds));

    // mini legend
    const legend = document.createElement("div");
    legend.className = "legend";
    (v.geometry||[]).forEach((_,ci) => {{
      legend.innerHTML += `<div class="legend-item">
        <div class="legend-dot" style="background:${{CURVE_COLORS[ci%CURVE_COLORS.length]}}"></div>
        crv${{ci+1}}${{_?.closed?" ●":" ○"}}</div>`;
    }});
    if (v.linePlacement) legend.innerHTML +=
      `<div class="legend-item"><div class="legend-dot" style="background:#ff6644"></div>placement</div>`;
    if (v.bboxBig) legend.innerHTML +=
      `<div class="legend-item"><div class="legend-dot" style="background:rgba(255,255,255,.35)"></div>bbox</div>`;
    block.appendChild(legend);
    strip.appendChild(block);
  }});

  card.appendChild(strip);
  return card;
}}

function renderGrid() {{
  const grid  = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const stats = document.getElementById("stats");
  grid.innerHTML = "";

  const items = (LIBRARY[selApt]?.[selRoom]) || [];

  if (!items.length) {{
    empty.style.display = "block";
    stats.textContent = "";
    return;
  }}
  empty.style.display = "none";

  let totalVariants = 0;
  items.forEach(item => {{
    totalVariants += item.variants.length;
    grid.appendChild(renderCard(item));
  }});

  stats.textContent =
    `${{items.length}} furniture type${{items.length!==1?"s":""}}  ·  ${{totalVariants}} variant${{totalVariants!==1?"s":""}} total`;
}}

// ── selectors ────────────────────────────────────────────────────────────────
function selectApt(apt) {{
  selApt = apt;
  document.querySelectorAll("#apt-btns .pill").forEach(b =>
    b.classList.toggle("active", b.dataset.apt === apt));

  // rebuild room buttons
  const roomBtns = document.getElementById("room-btns");
  roomBtns.innerHTML = "";
  const rooms = ROOMS[apt] || [];
  selRoom = rooms[0] || null;

  rooms.forEach(room => {{
    const btn = document.createElement("button");
    btn.className = "pill" + (room === selRoom ? " active" : "");
    btn.textContent = room;
    btn.dataset.room = room;
    btn.onclick = () => selectRoom(room);
    roomBtns.appendChild(btn);
  }});

  renderGrid();
}}

function selectRoom(room) {{
  selRoom = room;
  document.querySelectorAll("#room-btns .pill").forEach(b =>
    b.classList.toggle("active", b.dataset.room === room));
  renderGrid();
}}

// ── init ─────────────────────────────────────────────────────────────────────
const aptBtns = document.getElementById("apt-btns");
APT_TYPES.forEach(apt => {{
  const btn = document.createElement("button");
  btn.className = "pill";
  btn.textContent = apt + "R";
  btn.dataset.apt = apt;
  btn.onclick = () => selectApt(apt);
  aptBtns.appendChild(btn);
}});

selectApt(APT_TYPES[0]);
</script>
</body>
</html>"""

# ── write output ──────────────────────────────────────────────────────────────
with open(OUTPUT, "w", encoding="utf-8") as f:
    f.write(html)

print(f"✓  viewer.html generated")
print(f"   source: furniture_library.json  (built {lib_generated})")
print(f"   {lib_meta.get('files', '?')} source files  ·  "
      f"{lib_meta.get('pieces', '?')} pieces  ·  "
      f"{lib_meta.get('variants', '?')} variants")
print(f"   → {OUTPUT}")
