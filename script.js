/* =========================================================
   GraphGo — script.js  (Tableau-inspired, offline, no deps)
   ========================================================= */

'use strict';

// =========================================================
// 1. STATE
// =========================================================
const state = {
  rawData:      [],
  columns:      [],       // [{name, type:'numeric'|'categorical'}]
  xCol:         '',
  yCol:         '',
  colorCol:     '',       // Third dimension: color encoding
  chartType:    'bar',
  aggregation:  'sum',
  filters:      [],       // [{id, column, operator, value}]
  // Analytics overlays
  showAvgLine:    false,
  showMedianLine: false,
  showTrendLine:  false,
  showLabels:     false,
  sortOrder:      'default',  // 'default' | 'asc' | 'desc'
  // Table
  tablePage:    0,
  pageSize:     25,
  tableSortCol: null,
  tableSortDir: 'asc',
  // Sidebar
  sidebarTab:   'data',
  // Internal: hit-regions for tooltip
  hitRegions:   [],
};

const PALETTE = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
  '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac',
];

// =========================================================
// 2. CSV PARSING
// =========================================================
function parseCSV(text) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);

  const allRows = [];
  let row = [], cell = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else { cell += ch; }
    } else {
      if (ch === '"')      { inQuotes = true; }
      else if (ch === ',') { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n'){ row.push(cell.trim()); allRows.push(row); row = []; cell = ''; }
      else                 { cell += ch; }
    }
  }
  row.push(cell.trim());
  if (row.some(c => c !== '')) allRows.push(row);

  if (allRows.length < 2) return null;
  const headers = allRows[0].map((h, i) => h || `col_${i}`);
  const rows = allRows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
  return { headers, rows };
}

// =========================================================
// 3. TYPE DETECTION
// =========================================================
function detectType(rows, col) {
  const vals = rows.map(r => r[col]).filter(v => v !== '' && v != null);
  if (!vals.length) return 'categorical';
  const numCount = vals.filter(v => !isNaN(v) && String(v).trim() !== '').length;
  return numCount / vals.length >= 0.8 ? 'numeric' : 'categorical';
}

// =========================================================
// 4. DATA PROCESSING
// =========================================================
function applyFilters(data) {
  return data.filter(row =>
    state.filters.every(f => {
      if (!f.column || f.value === '') return true;
      const rv = row[f.column] ?? '';
      const fv = f.value;
      switch (f.operator) {
        case '=':        return String(rv).toLowerCase() === String(fv).toLowerCase();
        case '!=':       return String(rv).toLowerCase() !== String(fv).toLowerCase();
        case '>':        return parseFloat(rv) >  parseFloat(fv);
        case '<':        return parseFloat(rv) <  parseFloat(fv);
        case '>=':       return parseFloat(rv) >= parseFloat(fv);
        case '<=':       return parseFloat(rv) <= parseFloat(fv);
        case 'contains': return String(rv).toLowerCase().includes(String(fv).toLowerCase());
        default:         return true;
      }
    })
  );
}

function sortVals(a, b) {
  const an = parseFloat(a), bn = parseFloat(b);
  return !isNaN(an) && !isNaN(bn) ? an - bn : String(a).localeCompare(String(b));
}

function reduceVals(vals, agg) {
  if (!vals.length) return 0;
  if (agg === 'sum')   return vals.reduce((a, b) => a + b, 0);
  if (agg === 'avg')   return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (agg === 'count') return vals.length;
  if (agg === 'min')   return Math.min(...vals);
  if (agg === 'max')   return Math.max(...vals);
  return vals[vals.length - 1]; // 'none'
}

/** Aggregate without color grouping → [{x, y}] */
function aggregateSimple(data, xCol, yCol, agg) {
  if (agg === 'none') {
    return data.slice(0, 500).map(row => ({ x: row[xCol], y: parseFloat(row[yCol]) || 0 }));
  }
  const groups = new Map();
  data.forEach(row => {
    const k = String(row[xCol] ?? '');
    if (!groups.has(k)) groups.set(k, []);
    const n = parseFloat(row[yCol]);
    if (!isNaN(n)) groups.get(k).push(n);
  });
  let result = [];
  groups.forEach((vals, k) => result.push({ x: k, y: reduceVals(vals, agg) }));
  result.sort((a, b) => sortVals(a.x, b.x));
  return applySortOrder(result);
}

/** Aggregate with color grouping → { xVals, colorVals, matrix } */
function aggregateGrouped(data, xCol, yCol, colorCol, agg) {
  const outer = new Map(); // xVal → Map { colorVal → [yNums] }
  const colorSet = new Set();

  data.forEach(row => {
    const xk = String(row[xCol] ?? '');
    const ck = String(row[colorCol] ?? '');
    colorSet.add(ck);
    if (!outer.has(xk)) outer.set(xk, new Map());
    const inner = outer.get(xk);
    if (!inner.has(ck)) inner.set(ck, []);
    const n = parseFloat(row[yCol]);
    if (!isNaN(n)) inner.get(ck).push(n);
  });

  const xVals     = [...outer.keys()].sort(sortVals);
  const colorVals = [...colorSet].sort(sortVals);

  // Reduce each cell
  const matrix = new Map();
  xVals.forEach(xv => {
    const row = new Map();
    colorVals.forEach(cv => {
      const vals = outer.get(xv)?.get(cv) || [];
      row.set(cv, reduceVals(vals, agg));
    });
    matrix.set(xv, row);
  });

  return { xVals, colorVals, matrix };
}

function applySortOrder(data) {
  if (state.sortOrder === 'asc')  return [...data].sort((a, b) => a.y - b.y);
  if (state.sortOrder === 'desc') return [...data].sort((a, b) => b.y - a.y);
  return data;
}

// =========================================================
// 5. STATS
// =========================================================
function computeStats(data) {
  const ys = data.map(d => d.y).filter(isFinite);
  if (!ys.length) return null;
  const sum = ys.reduce((a, b) => a + b, 0);
  return { count: ys.length, sum, avg: sum / ys.length, min: Math.min(...ys), max: Math.max(...ys) };
}

// =========================================================
// 6. NUMBER / LABEL HELPERS
// =========================================================
function fmt(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Number.isInteger(n) ? String(n) : n.toFixed(dec);
}

function truncate(s, max) {
  s = String(s ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// =========================================================
// 7. CHART RENDERER CLASS
// =========================================================
class ChartRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 0;
    this.H = 0;
    this.ctx = null;
    this.pad = { top: 50, right: 36, bottom: 72, left: 80 };
  }

  /** Resize canvas to match physical container, apply DPR scaling. */
  sync() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    // Extra right padding for legend when color is active
    this.pad.right = state.colorCol ? 170 : 36;
  }

  get plotW() { return this.W - this.pad.left - this.pad.right; }
  get plotH() { return this.H - this.pad.top  - this.pad.bottom; }

  // ---- Shared helpers ----

  clear() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
  }

  /** Compute a "nice" axis scale. Returns { min, max, step }. */
  niceScale(lo, hi, ticks = 5) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw  = (hi - lo) / ticks;
    const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
    const frac = raw / mag;
    let step = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    step *= mag;
    return {
      min:  Math.floor(lo / step) * step,
      max:  Math.ceil(hi  / step) * step,
      step,
    };
  }

  /** Draw Y-axis: gridlines, ticks, axis lines. Returns mapY(value) → y-px. */
  drawYAxis(scale, label) {
    const { ctx, pad, plotW, plotH } = this;
    const { min, max, step } = scale;
    ctx.save();
    ctx.font = '10.5px Inter, system-ui, sans-serif';

    let tick = min;
    while (tick <= max + step * 0.01) {
      const y = pad.top + plotH - ((tick - min) / (max - min)) * plotH;
      ctx.strokeStyle = '#ebebeb';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
      ctx.fillStyle = '#888'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(tick), pad.left - 7, y);
      tick = Math.round((tick + step) * 1e10) / 1e10;
    }

    // Y-axis label (rotated)
    if (label) {
      ctx.save();
      ctx.translate(14, pad.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#555';
      ctx.font = 'bold 11px Inter, system-ui, sans-serif';
      ctx.fillText(truncate(label, 26), 0, 0);
      ctx.restore();
    }

    // Axis lines
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();
    ctx.restore();

    return v => pad.top + plotH - ((v - min) / (max - min)) * plotH;
  }

  drawTitle(text) {
    const { ctx, W, pad } = this;
    ctx.save();
    ctx.font = 'bold 13px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(truncate(text, 60), W / 2, pad.top / 2);
    ctx.restore();
  }

  drawXLabel(text) {
    const { ctx, W, H, pad } = this;
    ctx.save();
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#555'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(truncate(text, 32), pad.left + this.plotW / 2, H - 4);
    ctx.restore();
  }

  /** Round-rect path helper. */
  roundRect(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  /** Draw a legend in the top-right area of the canvas for color encoding. */
  drawLegend(colorVals, title) {
    if (!colorVals || colorVals.length <= 1) return;
    const { ctx, pad } = this;
    const itemH  = 19;
    const lw     = 155;
    const lh     = colorVals.length * itemH + 22;
    const lx     = pad.left + this.plotW + 10;
    const ly     = pad.top;

    ctx.save();
    // Background panel
    ctx.fillStyle   = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.12)';
    ctx.shadowBlur  = 8;
    this.roundRect(lx, ly, lw, lh, 5);
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1;
    this.roundRect(lx, ly, lw, lh, 5);
    ctx.stroke();

    // Title row
    ctx.fillStyle = '#888'; ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText((title || '').toUpperCase().slice(0, 20), lx + 8, ly + 6);

    colorVals.forEach((val, i) => {
      const cy = ly + 18 + i * itemH;
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.fillRect(lx + 8, cy + 3, 11, 11);
      ctx.fillStyle = '#333'; ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(String(val), 16), lx + 24, cy + 8.5);
    });
    ctx.restore();
  }

  /** Draw analytics overlays: avg line, median line, trend line. */
  drawOverlays(data, mapY, mapX) {
    const { ctx, pad, plotW, plotH } = this;
    const ys = data.map(d => d.y).filter(isFinite);
    if (!ys.length) return;

    ctx.save();
    ctx.font = '10px Inter, sans-serif';

    if (state.showAvgLine) {
      const avg = ys.reduce((a,b)=>a+b,0) / ys.length;
      const y   = mapY(avg);
      ctx.strokeStyle = '#e15759'; ctx.lineWidth = 1.5; ctx.setLineDash([5,3]);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#e15759'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`Avg: ${fmt(avg)}`, pad.left + 4, y - 2);
    }

    if (state.showMedianLine) {
      const sorted = [...ys].sort((a,b)=>a-b);
      const n   = sorted.length;
      const med = n % 2 === 0 ? (sorted[n/2-1]+sorted[n/2])/2 : sorted[Math.floor(n/2)];
      const y   = mapY(med);
      ctx.strokeStyle = '#59a14f'; ctx.lineWidth = 1.5; ctx.setLineDash([5,3]);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#59a14f'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(`Med: ${fmt(med)}`, pad.left + plotW - 4, y - 2);
    }

    if (state.showTrendLine && data.length >= 2) {
      // Use index for categorical X, actual value for numeric X
      const xIsNum = data.every(d => !isNaN(d.x));
      const pts    = data.map((d, i) => ({
        xi: xIsNum ? +d.x : i,
        y:  d.y,
      })).filter(p => isFinite(p.y));

      if (pts.length >= 2) {
        const n   = pts.length;
        const sx  = pts.reduce((s,p)=>s+p.xi,0);
        const sy  = pts.reduce((s,p)=>s+p.y,0);
        const sxy = pts.reduce((s,p)=>s+p.xi*p.y,0);
        const sx2 = pts.reduce((s,p)=>s+p.xi*p.xi,0);
        const den = n*sx2 - sx*sx;
        if (den !== 0) {
          const slope = (n*sxy - sx*sy) / den;
          const icept = (sy - slope*sx) / n;
          const x0    = pts[0].xi, x1 = pts[n-1].xi;
          const y0    = slope*x0 + icept, y1 = slope*x1 + icept;
          // map xi → canvas x (evenly spaced if categorical)
          const cx0 = xIsNum && mapX ? mapX(x0) : pad.left;
          const cx1 = xIsNum && mapX ? mapX(x1) : pad.left + plotW;
          ctx.strokeStyle = '#f28e2b'; ctx.lineWidth = 2; ctx.setLineDash([6,3]);
          ctx.beginPath(); ctx.moveTo(cx0, mapY(y0)); ctx.lineTo(cx1, mapY(y1)); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    ctx.restore();
  }

  // ---- Mark label helper ----
  drawLabel(text, cx, cy, color) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '9.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = color || '#333';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(truncate(text, 10), cx, cy - 2);
    ctx.restore();
  }

  // ---- Categorical X label (with optional rotation) ----
  drawCatXLabel(label, cx, rotated) {
    const { ctx, pad, plotH } = this;
    const baseY = pad.top + plotH + 6;
    ctx.save();
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#666';
    if (rotated) {
      ctx.translate(cx, baseY);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText(truncate(label, 12), 0, 0);
    } else {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(truncate(label, 14), cx, baseY);
    }
    ctx.restore();
  }

  // =========================================================
  // BAR CHART (simple & grouped)
  // =========================================================
  drawBar(xCol, yCol) {
    const filtered  = applyFilters(state.rawData);

    if (state.colorCol) {
      this._drawGroupedBar(filtered, xCol, yCol);
    } else {
      this._drawSimpleBar(filtered, xCol, yCol);
    }
  }

  _drawSimpleBar(filtered, xCol, yCol) {
    this.sync(); this.clear();
    state.hitRegions = [];

    const data = aggregateSimple(filtered, xCol, yCol, state.aggregation);
    if (!data.length) { this.drawEmpty(); return; }

    const { ctx, pad, plotW, plotH } = this;
    const n     = data.length;
    const yMax  = Math.max(...data.map(d=>d.y));
    const yMin  = Math.min(0, Math.min(...data.map(d=>d.y)));
    const scale = this.niceScale(yMin, yMax);
    const mapY  = this.drawYAxis(scale, yCol);
    const rot   = n > 9;

    data.forEach((d, i) => {
      const slotW  = plotW / n;
      const barW   = Math.max(3, slotW * 0.6);
      const x      = pad.left + i * slotW + (slotW - barW) / 2;
      const y0     = mapY(Math.max(scale.min, 0));
      const y1     = mapY(d.y);
      const h      = Math.abs(y0 - y1) || 1;
      const top    = Math.min(y0, y1);
      const color  = PALETTE[i % PALETTE.length];

      ctx.fillStyle = color;
      ctx.fillRect(x, top, barW, h);
      // Subtle shade on top edge for depth
      ctx.fillStyle = 'rgba(0,0,0,0.07)';
      ctx.fillRect(x, top, barW, Math.min(3, h));

      state.hitRegions.push({ type:'bar', x, top, w:barW, h, xVal:d.x, yVal:d.y, color });

      if (state.showLabels && h > 14) {
        this.drawLabel(fmt(d.y), x + barW/2, top);
      }
      this.drawCatXLabel(String(d.x), x + barW/2, rot);
    });

    this.drawOverlays(data, mapY, null);
    this.drawTitle(`${state.aggregation.toUpperCase()}(${yCol}) by ${xCol}`);
    this.drawXLabel(xCol);
    renderStats(computeStats(data));
  }

  _drawGroupedBar(filtered, xCol, yCol) {
    this.sync(); this.clear();
    state.hitRegions = [];

    const { xVals, colorVals, matrix } = aggregateGrouped(
      filtered, xCol, yCol, state.colorCol, state.aggregation
    );
    if (!xVals.length) { this.drawEmpty(); return; }

    // Compute global y range across all groups
    let yMax = -Infinity, yMin = Infinity;
    matrix.forEach(row => row.forEach(v => {
      if (v > yMax) yMax = v;
      if (v < yMin) yMin = v;
    }));
    yMin = Math.min(0, yMin);

    const { ctx, pad, plotW, plotH } = this;
    const scale     = this.niceScale(yMin, yMax);
    const mapY      = this.drawYAxis(scale, yCol);
    const rot       = xVals.length > 8;
    const nc        = colorVals.length;
    const slotW     = plotW / xVals.length;
    const groupBarW = Math.max(2, slotW * 0.8 / nc);
    const groupGap  = slotW * 0.2;

    xVals.forEach((xv, xi) => {
      const groupX = pad.left + xi * slotW + groupGap / 2;
      colorVals.forEach((cv, ci) => {
        const y = matrix.get(xv)?.get(cv) ?? 0;
        const color = PALETTE[ci % PALETTE.length];
        const x   = groupX + ci * groupBarW;
        const y0  = mapY(Math.max(scale.min, 0));
        const y1  = mapY(y);
        const h   = Math.abs(y0 - y1) || 1;
        const top = Math.min(y0, y1);

        ctx.fillStyle = color;
        ctx.fillRect(x, top, groupBarW, h);
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(x, top, groupBarW, Math.min(2, h));

        state.hitRegions.push({ type:'bar', x, top, w:groupBarW, h, xVal:xv, yVal:y, color, colorVal:cv });

        if (state.showLabels && h > 14 && nc <= 3) {
          this.drawLabel(fmt(y), x + groupBarW/2, top, '#333');
        }
      });
      this.drawCatXLabel(String(xv), pad.left + xi * slotW + slotW/2, rot);
    });

    // Flat data for overlays (sum per x)
    const flatData = xVals.map(xv => {
      const total = colorVals.reduce((s, cv) => s + (matrix.get(xv)?.get(cv) ?? 0), 0);
      return { x: xv, y: total };
    });
    this.drawOverlays(flatData, mapY, null);
    this.drawLegend(colorVals, state.colorCol);
    this.drawTitle(`${state.aggregation.toUpperCase()}(${yCol}) by ${xCol} & ${state.colorCol}`);
    this.drawXLabel(xCol);
    renderStats(computeStats(flatData));
  }

  // =========================================================
  // LINE CHART (single & multi-series)
  // =========================================================
  drawLine(xCol, yCol) {
    const filtered = applyFilters(state.rawData);
    if (state.colorCol) {
      this._drawMultiLine(filtered, xCol, yCol, false);
    } else {
      this._drawSimpleLine(filtered, xCol, yCol, false);
    }
  }

  // =========================================================
  // AREA CHART
  // =========================================================
  drawArea(xCol, yCol) {
    const filtered = applyFilters(state.rawData);
    if (state.colorCol) {
      this._drawMultiLine(filtered, xCol, yCol, true);
    } else {
      this._drawSimpleLine(filtered, xCol, yCol, true);
    }
  }

  _drawSimpleLine(filtered, xCol, yCol, filled) {
    this.sync(); this.clear();
    state.hitRegions = [];

    const data  = aggregateSimple(filtered, xCol, yCol, state.aggregation);
    if (!data.length) { this.drawEmpty(); return; }

    const { ctx, pad, plotW, plotH } = this;
    const n     = data.length;
    const yMax  = Math.max(...data.map(d=>d.y));
    const yMin  = Math.min(...data.map(d=>d.y));
    const scale = this.niceScale(yMin, yMax);
    const mapY  = this.drawYAxis(scale, yCol);
    const xIsNum = data.every(d => !isNaN(d.x));
    const xScale = xIsNum ? this.niceScale(Math.min(...data.map(d=>+d.x)), Math.max(...data.map(d=>+d.x))) : null;

    const getX = (d, i) => {
      if (xIsNum && xScale) {
        return pad.left + ((+d.x - xScale.min) / (xScale.max - xScale.min)) * plotW;
      }
      return pad.left + (n <= 1 ? plotW/2 : (i / (n-1)) * plotW);
    };

    const color = PALETTE[0];

    // Area fill
    if (filled) {
      ctx.save();
      ctx.beginPath();
      data.forEach((d,i) => {
        const x = getX(d,i), y = mapY(d.y);
        i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      });
      ctx.lineTo(getX(data[n-1],n-1), pad.top+plotH);
      ctx.lineTo(getX(data[0],0),     pad.top+plotH);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(color, 0.15);
      ctx.fill();
      ctx.restore();
    }

    // Line
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    data.forEach((d,i) => { const x=getX(d,i),y=mapY(d.y); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
    ctx.restore();

    // Dots + labels
    const step = Math.max(1, Math.ceil(n/10));
    data.forEach((d,i) => {
      const x = getX(d,i), y = mapY(d.y);
      ctx.beginPath(); ctx.arc(x, y, n>80?2:4, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
      if (n <= 80) { ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke(); }
      state.hitRegions.push({ type:'point', cx:x, cy:y, r:9, xVal:d.x, yVal:d.y, color });
      if (state.showLabels && (i%step===0||i===n-1)) this.drawLabel(fmt(d.y), x, y, '#333');
      if (i%step===0||i===n-1) {
        const rot = n > 9;
        this.drawCatXLabel(String(d.x), x, rot);
      }
    });

    // X numeric ticks when X is numeric
    if (xIsNum && xScale) this._drawXNumericTicks(xScale);

    this.drawOverlays(data, mapY, xIsNum && xScale ? v => pad.left + ((v-xScale.min)/(xScale.max-xScale.min))*plotW : null);
    this.drawTitle(`${state.aggregation.toUpperCase()}(${yCol}) over ${xCol}`);
    this.drawXLabel(xCol);
    renderStats(computeStats(data));
  }

  _drawMultiLine(filtered, xCol, yCol, filled) {
    this.sync(); this.clear();
    state.hitRegions = [];

    const { xVals, colorVals, matrix } = aggregateGrouped(
      filtered, xCol, yCol, state.colorCol, state.aggregation
    );
    if (!xVals.length) { this.drawEmpty(); return; }

    // Global Y range
    let yMax=-Infinity, yMin=Infinity;
    matrix.forEach(row=>row.forEach(v=>{ if(v>yMax)yMax=v; if(v<yMin)yMin=v; }));
    const scale = this.niceScale(yMin, yMax);
    const mapY  = this.drawYAxis(scale, yCol);

    const { ctx, pad, plotW, plotH } = this;
    const n      = xVals.length;
    const getX   = i => pad.left + (n<=1 ? plotW/2 : (i/(n-1))*plotW);
    const step   = Math.max(1, Math.ceil(n/10));
    const flatY  = [];

    colorVals.forEach((cv, ci) => {
      const color = PALETTE[ci % PALETTE.length];
      const pts   = xVals.map((xv,i)=>({ x:xv, y: matrix.get(xv)?.get(cv)??0, cx:getX(i) }));

      // Area fill
      if (filled) {
        ctx.save();
        ctx.beginPath();
        pts.forEach((p,i)=>i===0?ctx.moveTo(p.cx,mapY(p.y)):ctx.lineTo(p.cx,mapY(p.y)));
        ctx.lineTo(pts[n-1].cx, pad.top+plotH);
        ctx.lineTo(pts[0].cx,   pad.top+plotH);
        ctx.closePath();
        ctx.fillStyle = hexToRgba(color, 0.12);
        ctx.fill();
        ctx.restore();
      }

      // Line
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin='round'; ctx.lineCap='round';
      ctx.beginPath();
      pts.forEach((p,i)=>i===0?ctx.moveTo(p.cx,mapY(p.y)):ctx.lineTo(p.cx,mapY(p.y)));
      ctx.stroke();
      ctx.restore();

      // Dots
      pts.forEach((p,i)=>{
        const y = mapY(p.y);
        ctx.beginPath(); ctx.arc(p.cx, y, 4, 0, Math.PI*2);
        ctx.fillStyle=color; ctx.fill();
        ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
        state.hitRegions.push({type:'point',cx:p.cx,cy:y,r:9,xVal:p.x,yVal:p.y,color,colorVal:cv});
        if (state.showLabels) this.drawLabel(fmt(p.y), p.cx, y, '#333');
        if (ci===0 && (i%step===0||i===n-1)) this.drawCatXLabel(String(p.x), p.cx, n>9);
      });
      if (ci===0) pts.forEach(p=>flatY.push(p.y));
    });

    this.drawOverlays(xVals.map((x,i)=>({x,y:flatY[i]})), mapY, null);
    this.drawLegend(colorVals, state.colorCol);
    this.drawTitle(`${state.aggregation.toUpperCase()}(${yCol}) by ${xCol} (${state.colorCol})`);
    this.drawXLabel(xCol);
    renderStats(computeStats(xVals.map((x,i)=>({x,y:flatY[i]??0}))));
  }

  // =========================================================
  // SCATTER PLOT
  // =========================================================
  drawScatter(xCol, yCol) {
    this.sync(); this.clear();
    state.hitRegions = [];

    const filtered = applyFilters(state.rawData);
    const data = filtered.slice(0, 500);
    const { ctx, pad, plotW, plotH } = this;

    const xVals = data.map(r=>+r[xCol]).filter(isFinite);
    const yVals = data.map(r=>+r[yCol]).filter(isFinite);
    if (!xVals.length || !yVals.length) { this.drawError('Scatter requires numeric X and Y axes.'); return; }

    const xScale = this.niceScale(Math.min(...xVals), Math.max(...xVals));
    const yScale = this.niceScale(Math.min(...yVals), Math.max(...yVals));
    const mapY   = this.drawYAxis(yScale, yCol);
    const mapX   = v => pad.left + ((v-xScale.min)/(xScale.max-xScale.min))*plotW;

    this._drawXNumericTicks(xScale);

    // Color mapping
    let colorMap = null;
    let colorVals = null;
    if (state.colorCol) {
      colorVals = [...new Set(data.map(r=>String(r[state.colorCol]??'')))].sort(sortVals);
      colorMap  = new Map(colorVals.map((v,i)=>[v, PALETTE[i%PALETTE.length]]));
    }

    data.forEach(row => {
      const x = +row[xCol], y = +row[yCol];
      if (!isFinite(x)||!isFinite(y)) return;
      const cx = mapX(x), cy = mapY(y);
      const color = colorMap ? colorMap.get(String(row[state.colorCol]??''))||PALETTE[0] : PALETTE[0];

      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI*2);
      ctx.fillStyle = hexToRgba(color, 0.55); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
      state.hitRegions.push({type:'point',cx,cy,r:8,xVal:x,yVal:y,color,colorVal:state.colorCol?String(row[state.colorCol]??''):null});
    });

    if (colorVals) this.drawLegend(colorVals, state.colorCol);
    this.drawOverlays(
      data.map(r=>({x:+r[xCol],y:+r[yCol]})).filter(p=>isFinite(p.x)&&isFinite(p.y)),
      mapY, mapX
    );
    this.drawTitle(`${yCol} vs ${xCol}${state.colorCol?' ('+state.colorCol+')':''}`);
    this.drawXLabel(xCol);
    renderStats(computeStats(yVals.map(y=>({y}))));
  }

  // =========================================================
  // PIE CHART
  // =========================================================
  drawPie(xCol, yCol) {
    this.sync(); this.clear();
    state.hitRegions = [];

    const filtered = applyFilters(state.rawData);
    const data = aggregateSimple(filtered, xCol, yCol, state.aggregation === 'none' ? 'sum' : state.aggregation);
    if (!data.length) { this.drawEmpty(); return; }

    const total = data.reduce((s,d)=>s+Math.abs(d.y), 0);
    if (total === 0) { this.drawEmpty(); return; }

    const { ctx, W, H } = this;
    const cx = W / 2 - (state.colorCol ? 40 : 0);
    const cy = H / 2;
    const r  = Math.min(W, H) * 0.33;

    let angle = -Math.PI / 2;

    data.forEach((d, i) => {
      const frac = Math.abs(d.y) / total;
      const end  = angle + frac * Math.PI * 2;
      const color = PALETTE[i % PALETTE.length];

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, end);
      ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();

      // Percentage label on large slices
      if (frac > 0.05) {
        const mid = (angle + end) / 2;
        const lx  = cx + Math.cos(mid) * r * 0.65;
        const ly  = cy + Math.sin(mid) * r * 0.65;
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${frac > 0.12 ? 12 : 10}px Inter, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((frac*100).toFixed(1)+'%', lx, ly);
      }

      // Outer label for slice name
      const mid = (angle + end) / 2;
      const lx  = cx + Math.cos(mid) * (r + 18);
      const ly  = cy + Math.sin(mid) * (r + 18);
      ctx.fillStyle = '#444'; ctx.font = '10.5px Inter, sans-serif';
      ctx.textAlign = Math.cos(mid) > 0 ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      if (frac > 0.03) ctx.fillText(truncate(String(d.x), 12), lx, ly);

      // Store hit info (angle range for pie hit test)
      state.hitRegions.push({type:'slice',cx,cy,r,start:angle,end,xVal:d.x,yVal:d.y,frac,color});

      angle = end;
    });

    this.drawTitle(`${yCol} by ${xCol}`);
    renderStats(computeStats(data));
  }

  // Numeric X-axis ticks + vertical gridlines
  _drawXNumericTicks(xScale) {
    const { ctx, pad, plotW, plotH } = this;
    ctx.save();
    ctx.font = '10px Inter, system-ui, sans-serif';
    let tick = xScale.min;
    while (tick <= xScale.max + xScale.step*0.01) {
      const x = pad.left + ((tick-xScale.min)/(xScale.max-xScale.min))*plotW;
      ctx.strokeStyle='#ebebeb'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(x,pad.top); ctx.lineTo(x,pad.top+plotH); ctx.stroke();
      ctx.fillStyle='#888'; ctx.textAlign='center'; ctx.textBaseline='top';
      ctx.fillText(fmt(tick), x, pad.top+plotH+7);
      tick = Math.round((tick+xScale.step)*1e10)/1e10;
    }
    ctx.restore();
  }

  drawEmpty() {
    const { ctx, W, H } = this;
    ctx.fillStyle = '#aaa'; ctx.font = '13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No data matches current filters.', W/2, H/2);
  }

  drawError(msg) {
    const { ctx, W, H } = this;
    ctx.fillStyle = '#c53030'; ctx.font = '13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(msg, W/2, H/2);
  }
}

// =========================================================
// 8. TOOLTIP SYSTEM
// =========================================================
const tooltipEl = document.getElementById('chartTooltip');

function showTooltip(html, mx, my) {
  tooltipEl.innerHTML = html;
  tooltipEl.classList.add('visible');
  const cw = tooltipEl.parentElement.clientWidth;
  const ch = tooltipEl.parentElement.clientHeight;
  let left = mx + 14, top = my - 20;
  if (left + 200 > cw) left = mx - 200 - 8;
  if (top  +  70 > ch) top  = my - 70;
  tooltipEl.style.left = Math.max(4, left) + 'px';
  tooltipEl.style.top  = Math.max(4, top)  + 'px';
}
function hideTooltip() { tooltipEl.classList.remove('visible'); }

function findHit(mx, my) {
  for (const r of state.hitRegions) {
    if (r.type === 'bar') {
      if (mx>=r.x && mx<=r.x+r.w && my>=r.top && my<=r.top+r.h) return r;
    } else if (r.type === 'point') {
      if (Math.hypot(mx-r.cx, my-r.cy) <= r.r) return r;
    } else if (r.type === 'slice') {
      if (Math.hypot(mx-r.cx, my-r.cy) <= r.r) {
        // Angle-based check
        let a = Math.atan2(my-r.cy, mx-r.cx);
        // Normalise start/end (they span [-π/2, +3π/2])
        if (a < r.start) a += Math.PI*2;
        if (a >= r.start && a < r.end) return r;
      }
    }
  }
  return null;
}

// =========================================================
// 9. CHART CANVAS + RENDERER
// =========================================================
const canvas   = document.getElementById('chartCanvas');
const renderer = new ChartRenderer(canvas);

function renderChart() {
  const { xCol, yCol, chartType, rawData } = state;
  const placeholder = document.getElementById('chartPlaceholder');

  if (!rawData.length || !xCol || !yCol) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    hideError();
    renderStats(null);
    return;
  }

  // Scatter needs numeric axes
  if (chartType === 'scatter') {
    const xt = state.columns.find(c=>c.name===xCol)?.type;
    const yt = state.columns.find(c=>c.name===yCol)?.type;
    if (xt!=='numeric' || yt!=='numeric') {
      showError('Scatter plot requires numeric X and Y axes.');
      canvas.classList.add('hidden');
      placeholder.classList.add('hidden');
      return;
    }
  }

  hideError();
  placeholder.classList.add('hidden');
  canvas.classList.remove('hidden');

  if      (chartType==='bar')     renderer.drawBar(xCol, yCol);
  else if (chartType==='line')    renderer.drawLine(xCol, yCol);
  else if (chartType==='area')    renderer.drawArea(xCol, yCol);
  else if (chartType==='scatter') renderer.drawScatter(xCol, yCol);
  else if (chartType==='pie')     renderer.drawPie(xCol, yCol);

  updateTableInfo(applyFilters(rawData).length);
  if (!document.getElementById('tableWrapper').classList.contains('hidden')) {
    renderTable(applyFilters(rawData));
  }
}

// =========================================================
// 10. STATS ROW
// =========================================================
const statsRow = document.getElementById('statsRow');

function renderStats(stats) {
  if (!stats) { statsRow.classList.add('hidden'); return; }
  statsRow.classList.remove('hidden');
  const cards = [
    {l:'Rows',    v: stats.count.toLocaleString()},
    {l:'Sum',     v: fmt(stats.sum)},
    {l:'Average', v: fmt(stats.avg)},
    {l:'Min',     v: fmt(stats.min)},
    {l:'Max',     v: fmt(stats.max)},
  ];
  statsRow.innerHTML = cards.map(c=>`
    <div class="stat-card">
      <div class="stat-label">${c.l}</div>
      <div class="stat-value">${c.v}</div>
    </div>
  `).join('');
}

// =========================================================
// 11. DATA TABLE (sortable, paginated)
// =========================================================
const tableInfo = document.getElementById('tableInfo');

function updateTableInfo(count) {
  tableInfo.textContent = count!=null ? `${count.toLocaleString()} row${count!==1?'s':''} (filtered)` : '';
}

function renderTable(data) {
  const cols  = state.columns.map(c=>c.name);
  const {tableSortCol, tableSortDir, tablePage, pageSize} = state;

  // Apply column sort
  let sorted = [...data];
  if (tableSortCol) {
    const isNum = state.columns.find(c=>c.name===tableSortCol)?.type === 'numeric';
    sorted.sort((a,b)=>{
      const av = a[tableSortCol]??'', bv = b[tableSortCol]??'';
      const cmp = isNum ? +av - +bv : String(av).localeCompare(String(bv));
      return tableSortDir==='asc' ? cmp : -cmp;
    });
  }

  const total = Math.ceil(sorted.length / pageSize);
  const page  = sorted.slice(tablePage*pageSize, (tablePage+1)*pageSize);

  // Header
  document.getElementById('tableHead').innerHTML = '<tr>' + cols.map(c=>{
    const isSorted = tableSortCol===c;
    return `<th data-col="${escHtml(c)}" class="${isSorted?(tableSortDir==='asc'?'sorted-asc':'sorted-desc'):''}" title="${escHtml(c)}">${escHtml(truncate(c,22))}</th>`;
  }).join('') + '</tr>';

  document.getElementById('tableHead').querySelectorAll('th').forEach(th=>{
    th.addEventListener('click', ()=>{
      const col = th.dataset.col;
      if (state.tableSortCol===col) {
        state.tableSortDir = state.tableSortDir==='asc'?'desc':'asc';
      } else {
        state.tableSortCol = col;
        state.tableSortDir = 'asc';
      }
      renderTable(data);
    });
  });

  // Body
  document.getElementById('tableBody').innerHTML = page.map(row=>
    '<tr>'+cols.map(c=>`<td title="${escHtml(String(row[c]??''))}">${escHtml(truncate(String(row[c]??''),36))}</td>`).join('')+'</tr>'
  ).join('');

  // Pagination
  document.getElementById('pagination').innerHTML = `
    <button class="page-btn" id="pp" ${tablePage===0?'disabled':''}>‹ Prev</button>
    <span>Page ${tablePage+1} of ${Math.max(1,total)}</span>
    <button class="page-btn" id="np" ${tablePage>=total-1?'disabled':''}>Next ›</button>
  `;
  document.getElementById('pp')?.addEventListener('click',()=>{ state.tablePage=Math.max(0,tablePage-1); renderTable(data); });
  document.getElementById('np')?.addEventListener('click',()=>{ state.tablePage=Math.min(total-1,tablePage+1); renderTable(data); });
}

// =========================================================
// 12. SIDEBAR — FIELD LISTS
// =========================================================
function renderSidebar() {
  const { rawData, columns } = state;
  const dimsEl = document.getElementById('dimensionsList');
  const measEl = document.getElementById('measuresList');

  if (!rawData.length) {
    dimsEl.innerHTML = '<div class="empty-sidebar-msg">No data loaded</div>';
    measEl.innerHTML = '';
    return;
  }

  const q = document.getElementById('fieldSearch').value.toLowerCase();

  const dims = columns.filter(c=>c.type==='categorical' && c.name.toLowerCase().includes(q));
  const meas = columns.filter(c=>c.type==='numeric'     && c.name.toLowerCase().includes(q));

  const makeItem = c => `
    <div class="field-item" data-col="${escHtml(c.name)}" data-type="${c.type}" title="Click to add — ${c.name}">
      <span class="col-badge ${c.type}">${c.type==='numeric'?'#':'A'}</span>
      <span class="col-name">${escHtml(c.name)}</span>
      <button class="field-add-btn" title="Add ${c.name}">+</button>
    </div>
  `;

  dimsEl.innerHTML = dims.length ? dims.map(makeItem).join('') : '<div class="empty-sidebar-msg">No dimensions</div>';
  measEl.innerHTML = meas.length ? meas.map(makeItem).join('') : '<div class="empty-sidebar-msg">No measures</div>';

  // Attach click handlers
  document.querySelectorAll('.field-item').forEach(el=>{
    el.addEventListener('click', e=>{
      if (e.target.classList.contains('field-add-btn')) return;
      showFieldCtxMenu(el.dataset.col, el);
    });
    el.querySelector('.field-add-btn')?.addEventListener('click', e=>{
      e.stopPropagation();
      // Auto-assign: dim→cols, measure→rows
      const col    = el.dataset.col;
      const isNum  = el.dataset.type === 'numeric';
      if (!state.xCol && !isNum) { assignField('cols', col); }
      else if (!state.yCol && isNum) { assignField('rows', col); }
      else { assignField(isNum?'rows':'cols', col); }
    });
    el.addEventListener('dblclick', ()=>{
      const col   = el.dataset.col;
      const isNum = el.dataset.type === 'numeric';
      assignField(isNum?'rows':'cols', col);
    });
  });
}

// =========================================================
// 13. SHELVES (Columns + Rows pills)
// =========================================================
function renderShelves() {
  const aggLabel = state.aggregation.toUpperCase();

  // Columns shelf (X)
  const colsPills = document.getElementById('colsPills');
  colsPills.innerHTML = state.xCol
    ? `<span class="shelf-pill x-pill">${escHtml(state.xCol)}<span class="pill-remove" data-shelf="cols">×</span></span>`
    : `<span class="shelf-empty-pill">Drop or select a field</span>`;

  // Rows shelf (Y)
  const rowsPills = document.getElementById('rowsPills');
  rowsPills.innerHTML = state.yCol
    ? `<span class="shelf-pill y-pill">${aggLabel}(${escHtml(state.yCol)})<span class="pill-remove" data-shelf="rows">×</span></span>`
    : `<span class="shelf-empty-pill">Drop or select a field</span>`;

  // Remove pill handlers
  document.querySelectorAll('.pill-remove').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      if (btn.dataset.shelf==='cols') { state.xCol=''; }
      else { state.yCol=''; }
      renderShelves();
      renderChart();
    });
  });

  // Color pill in Marks card
  const colorShelf = document.getElementById('colorShelf');
  const colorEmpty = document.getElementById('colorEmpty');
  if (state.colorCol) {
    colorEmpty.classList.add('hidden');
    // Remove existing pill
    colorShelf.querySelectorAll('.marks-pill').forEach(p=>p.remove());
    const pill = document.createElement('span');
    pill.className = 'marks-pill';
    pill.innerHTML = `<span class="pill-text">${escHtml(state.colorCol)}</span><span class="pill-remove">×</span>`;
    pill.querySelector('.pill-remove').addEventListener('click', ()=>{
      state.colorCol='';
      renderShelves();
      renderChart();
    });
    colorShelf.appendChild(pill);
  } else {
    colorEmpty.classList.remove('hidden');
    colorShelf.querySelectorAll('.marks-pill').forEach(p=>p.remove());
  }
}

function assignField(shelf, col) {
  if (shelf==='cols')  state.xCol     = col;
  if (shelf==='rows')  state.yCol     = col;
  if (shelf==='color') state.colorCol = col;
  state.tablePage = 0;
  renderShelves();
  renderChart();
}

// =========================================================
// 14. FIELD CONTEXT MENU
// =========================================================
const fieldCtxMenu = document.getElementById('fieldCtxMenu');
let ctxMenuCol = '';

function showFieldCtxMenu(col, anchorEl) {
  ctxMenuCol = col;
  fieldCtxMenu.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  fieldCtxMenu.style.left = Math.min(rect.right + 6, window.innerWidth - 190) + 'px';
  fieldCtxMenu.style.top  = rect.top + 'px';
}

fieldCtxMenu.querySelectorAll('.ctx-item').forEach(item=>{
  item.addEventListener('click', ()=>{
    const a = item.dataset.action;
    if (a==='cols')   { assignField('cols',  ctxMenuCol); }
    if (a==='rows')   { assignField('rows',  ctxMenuCol); }
    if (a==='color')  { assignField('color', ctxMenuCol); }
    if (a==='filter') { addFilterForCol(ctxMenuCol); }
    fieldCtxMenu.classList.add('hidden');
  });
});

document.addEventListener('click', e=>{
  if (!fieldCtxMenu.contains(e.target) && !e.target.closest('.field-item')) {
    fieldCtxMenu.classList.add('hidden');
  }
});

// =========================================================
// 15. SHELF FIELD PICKER (the "+" button dropdown)
// =========================================================
const shelfPicker   = document.getElementById('shelfPicker');
const shelfPickerList = document.getElementById('shelfPickerList');
let pickerTarget    = '';

function showShelfPicker(target, buttonEl) {
  pickerTarget = target;
  const rect = buttonEl.getBoundingClientRect();
  shelfPicker.style.top  = (rect.bottom + 4) + 'px';
  shelfPicker.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
  shelfPicker.classList.remove('hidden');
  document.getElementById('shelfPickerSearch').value = '';
  document.getElementById('shelfPickerSearch').focus();
  renderPickerList('');
}

function renderPickerList(q) {
  const cols = state.columns.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()));
  shelfPickerList.innerHTML = cols.map(c=>`
    <div class="picker-item" data-col="${escHtml(c.name)}">
      <span class="col-badge ${c.type}">${c.type==='numeric'?'#':'A'}</span>
      ${escHtml(c.name)}
    </div>
  `).join('') || '<div style="padding:10px;color:#888;font-size:11px;">No fields found</div>';

  shelfPickerList.querySelectorAll('.picker-item').forEach(item=>{
    item.addEventListener('click',()=>{
      assignField(pickerTarget, item.dataset.col);
      shelfPicker.classList.add('hidden');
    });
  });
}

document.getElementById('shelfPickerSearch').addEventListener('input', e=>renderPickerList(e.target.value));
document.addEventListener('click', e=>{
  if (!shelfPicker.contains(e.target) && !e.target.closest('.shelf-add-btn')) {
    shelfPicker.classList.add('hidden');
  }
});

// Marks card color shelf click → picker
document.getElementById('colorShelf').addEventListener('click', e=>{
  if (e.target.closest('.marks-pill')) return;
  showShelfPicker('color', e.currentTarget);
});

// =========================================================
// 16. FILTER SYSTEM
// =========================================================
let filterIdSeq = 0;

function addFilter() { addFilterForCol(''); }

function addFilterForCol(col) {
  state.filters.push({ id: filterIdSeq++, column: col, operator: '=', value: '' });
  renderFilters();
}

function removeFilter(id) {
  state.filters = state.filters.filter(f=>f.id!==id);
  renderFilters();
  renderChart();
}

function renderFilters() {
  const el = document.getElementById('filtersList');
  el.innerHTML = '';
  state.filters.forEach(f=>{
    const div = document.createElement('div');
    div.className = 'filter-item';
    div.innerHTML = `
      <div class="filter-row">
        <select class="filter-col-select" data-id="${f.id}" data-field="column">
          <option value="">Column…</option>
          ${state.columns.map(c=>`<option value="${escHtml(c.name)}" ${c.name===f.column?'selected':''}>${escHtml(c.name)}</option>`).join('')}
        </select>
        <button class="filter-remove" data-id="${f.id}">×</button>
      </div>
      <div class="filter-row">
        <select class="filter-op-select" data-id="${f.id}" data-field="operator">
          ${['=','!=','>','<','>=','<=','contains'].map(op=>`<option ${op===f.operator?'selected':''}>${op}</option>`).join('')}
        </select>
        <input class="filter-val-input" type="text" placeholder="Value…" data-id="${f.id}" data-field="value" value="${escHtml(f.value)}" />
      </div>
    `;

    div.querySelector('.filter-remove').addEventListener('click', e=>removeFilter(+e.target.dataset.id));

    div.querySelectorAll('[data-field]').forEach(inp=>{
      const update = ()=>{
        const flt = state.filters.find(x=>x.id===+inp.dataset.id);
        if (flt) { flt[inp.dataset.field]=inp.value; state.tablePage=0; renderChart(); }
      };
      inp.addEventListener('change', update);
      if (inp.tagName==='INPUT') inp.addEventListener('input', update);
    });

    el.appendChild(div);
  });
}

// =========================================================
// 17. SHOW ME PANEL
// =========================================================
const showMePanel = document.getElementById('showMePanel');

const CHART_TYPES = [
  { id:'bar',     label:'Bar',
    svg:'<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="10" width="5" height="12" rx="1"/><rect x="9" y="4" width="5" height="18" rx="1"/><rect x="16" y="7" width="5" height="15" rx="1"/></svg>' },
  { id:'line',    label:'Line',
    svg:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="2,18 8,10 14,14 22,4"/></svg>' },
  { id:'area',    label:'Area',
    svg:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="2,18 8,10 14,14 22,4"/><polygon points="2,18 8,10 14,14 22,4 22,20 2,20" fill="currentColor" opacity=".25" stroke="none"/></svg>' },
  { id:'scatter', label:'Scatter',
    svg:'<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="18" r="2.5"/><circle cx="13" cy="9" r="2.5"/><circle cx="20" cy="5" r="2.5"/><circle cx="9" cy="15" r="2.5"/><circle cx="18" cy="14" r="2.5"/></svg>' },
  { id:'pie',     label:'Pie',
    svg:'<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 1 10 10H12z" opacity=".8"/><path d="M12 2v10h10a10 10 0 1 1-10-10z" opacity=".4"/></svg>' },
];

function renderShowMe() {
  const xt = state.columns.find(c=>c.name===state.xCol)?.type;
  const yt = state.columns.find(c=>c.name===state.yCol)?.type;
  let rec = [];
  let hint = 'Select X and Y fields for recommendations';

  if (state.xCol && state.yCol) {
    if (xt==='categorical' && yt==='numeric') {
      rec = ['bar','line','area','pie'];
      hint = `Cat × Num: Bar, Line, Area, and Pie are recommended`;
    } else if (xt==='numeric' && yt==='numeric') {
      rec = ['scatter'];
      hint = `Num × Num: Scatter is recommended`;
    } else {
      rec = ['bar','line'];
      hint = 'Bar and Line charts are suitable';
    }
  }

  document.getElementById('showMeGrid').innerHTML = CHART_TYPES.map(t=>`
    <div class="show-me-item ${state.chartType===t.id?'active':''} ${rec.includes(t.id)?'recommended':''}"
         data-type="${t.id}" title="${t.label}">
      ${t.svg}
      <span>${t.label}</span>
      ${rec.includes(t.id)?'<span class="rec-dot"></span>':''}
    </div>
  `).join('');

  document.getElementById('showMeHint').textContent = hint;

  document.querySelectorAll('.show-me-item').forEach(item=>{
    item.addEventListener('click',()=>{
      state.chartType = item.dataset.type;
      document.getElementById('markTypeSelect').value = state.chartType;
      showMePanel.classList.add('hidden');
      renderChart();
    });
  });
}

// =========================================================
// 18. LOAD DATA
// =========================================================
function loadData(headers, rows) {
  state.rawData     = rows;
  state.columns     = headers.map(name=>({ name, type: detectType(rows, name) }));
  state.xCol        = '';
  state.yCol        = '';
  state.colorCol    = '';
  state.filters     = [];
  state.tablePage   = 0;
  state.tableSortCol= null;

  // Auto-assign first categorical → X, first numeric → Y
  const cat = state.columns.find(c=>c.type==='categorical');
  const num = state.columns.find(c=>c.type==='numeric');
  if (cat) state.xCol = cat.name;
  if (num) state.yCol = num.name;

  renderSidebar();
  renderShelves();
  renderFilters();
  renderChart();
}

// =========================================================
// 19. SAMPLE DATA
// =========================================================
const SAMPLE_CSV = `Month,Category,Region,Sales,Units,Profit,Target
Jan,Electronics,North,45200,120,12800,40000
Jan,Clothing,South,18700,340,5200,20000
Jan,Food,East,29100,890,8400,28000
Feb,Electronics,North,52000,140,14500,48000
Feb,Clothing,South,21300,380,6100,22000
Feb,Food,East,31000,920,9000,30000
Mar,Electronics,North,48500,130,13100,50000
Mar,Clothing,South,19800,355,5600,21000
Mar,Food,East,30200,910,8800,29000
Apr,Electronics,North,61000,165,18000,55000
Apr,Clothing,South,24500,420,7200,24000
Apr,Food,East,33500,960,9700,32000
May,Electronics,North,58200,155,16500,56000
May,Clothing,South,22800,395,6600,23000
May,Food,East,35100,990,10200,34000
Jun,Electronics,North,67000,180,20000,62000
Jun,Clothing,South,26200,450,7800,26000
Jun,Food,East,37800,1020,11000,36000
Jul,Electronics,North,71500,195,22000,68000
Jul,Clothing,South,28000,480,8400,28000
Jul,Food,East,39200,1060,11500,38000
Aug,Electronics,North,68000,185,20500,70000
Aug,Clothing,South,27100,465,8000,27000
Aug,Food,East,38000,1040,11200,37000
Sep,Electronics,North,64000,172,19200,65000
Sep,Clothing,South,25300,440,7500,25000
Sep,Food,East,36500,1000,10700,35000
Oct,Electronics,North,70000,188,21500,68000
Oct,Clothing,South,27800,475,8200,27000
Oct,Food,East,38800,1050,11300,38000
Nov,Electronics,North,75000,200,23500,72000
Nov,Clothing,South,30000,510,9000,30000
Nov,Food,East,42000,1100,12500,40000
Dec,Electronics,North,82000,220,26000,80000
Dec,Clothing,South,33500,570,10200,33000
Dec,Food,East,46000,1200,14000,44000`;

function loadSampleData() {
  const p = parseCSV(SAMPLE_CSV);
  if (!p) return;
  loadData(p.headers, p.rows);
  showToast('Sample data loaded — 36 rows, 7 columns. Try: Category → Color');
}

// =========================================================
// 20. ERROR / TOAST
// =========================================================
const errorBanner = document.getElementById('errorBanner');
function showError(msg) { errorBanner.textContent=msg; errorBanner.classList.remove('hidden'); }
function hideError()    { errorBanner.classList.add('hidden'); }

const toastEl = document.getElementById('toast');
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toastEl.classList.remove('show'), 3000);
}

// =========================================================
// 21. CONFIG SAVE / LOAD
// =========================================================
const STORAGE_KEY = 'graphgo-config-v2';

function saveConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      xCol: state.xCol, yCol: state.yCol, colorCol: state.colorCol,
      chartType: state.chartType, aggregation: state.aggregation,
      sortOrder: state.sortOrder, showAvgLine: state.showAvgLine,
      showMedianLine: state.showMedianLine, showTrendLine: state.showTrendLine,
      showLabels: state.showLabels, filters: state.filters,
    }));
    showToast('Configuration saved to browser storage.');
  } catch { showToast('localStorage unavailable.'); }
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { showToast('No saved configuration found.'); return; }
    const cfg = JSON.parse(raw);

    const apply = (key, val) => {
      if (val==null) return;
      state[key] = val;
    };
    apply('chartType',    cfg.chartType);
    apply('aggregation',  cfg.aggregation);
    apply('sortOrder',    cfg.sortOrder);
    apply('showAvgLine',  cfg.showAvgLine);
    apply('showMedianLine', cfg.showMedianLine);
    apply('showTrendLine',  cfg.showTrendLine);
    apply('showLabels',   cfg.showLabels);
    if (cfg.filters) state.filters = cfg.filters;
    // Axis cols only if they exist in current data
    if (cfg.xCol && state.columns.find(c=>c.name===cfg.xCol))    state.xCol = cfg.xCol;
    if (cfg.yCol && state.columns.find(c=>c.name===cfg.yCol))    state.yCol = cfg.yCol;
    if (cfg.colorCol && state.columns.find(c=>c.name===cfg.colorCol)) state.colorCol = cfg.colorCol;

    // Sync UI controls
    document.getElementById('markTypeSelect').value   = state.chartType;
    document.getElementById('aggregationSelect').value = state.aggregation;
    document.getElementById('sortSelect').value        = state.sortOrder;
    document.getElementById('avgLineCheck').checked    = state.showAvgLine;
    document.getElementById('medianLineCheck').checked = state.showMedianLine;
    document.getElementById('trendLineCheck').checked  = state.showTrendLine;
    document.getElementById('showLabelsCheck').checked = state.showLabels;

    renderShelves();
    renderFilters();
    renderChart();
    showToast('Configuration restored.');
  } catch { showToast('Failed to parse saved configuration.'); }
}

// =========================================================
// 22. EXPORT PNG
// =========================================================
function exportPNG() {
  if (canvas.classList.contains('hidden')) { showToast('No chart to export.'); return; }
  const link = document.createElement('a');
  link.download = 'graphgo-chart.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast('Chart saved as PNG.');
}

// =========================================================
// 23. EVENT LISTENERS
// =========================================================

// File upload
document.getElementById('fileInput').addEventListener('change', e=>{
  const file = e.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv')) { showError('Please upload a .csv file.'); return; }
  const reader = new FileReader();
  reader.onload = ev=>{
    const p = parseCSV(ev.target.result);
    if (!p) { showError('Could not parse CSV. Ensure it has a header row and at least one data row.'); return; }
    loadData(p.headers, p.rows);
    showToast(`Loaded "${file.name}" — ${p.rows.length.toLocaleString()} rows, ${p.headers.length} cols`);
  };
  reader.onerror = ()=>showError('Failed to read file.');
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('loadSampleBtn').addEventListener('click', loadSampleData);

// Shelf + buttons
document.getElementById('colsAddBtn').addEventListener('click', e=>{ if (state.columns.length) showShelfPicker('cols', e.currentTarget); });
document.getElementById('rowsAddBtn').addEventListener('click', e=>{ if (state.columns.length) showShelfPicker('rows', e.currentTarget); });

// Mark type selector (Marks card)
document.getElementById('markTypeSelect').addEventListener('change', e=>{
  state.chartType = e.target.value;
  renderChart();
});

// Sort
document.getElementById('sortSelect').addEventListener('change', e=>{
  state.sortOrder = e.target.value;
  renderChart();
});

// Aggregation
document.getElementById('aggregationSelect').addEventListener('change', e=>{
  state.aggregation = e.target.value;
  renderShelves(); // update pill label
  renderChart();
});

// Analytics checkboxes
document.getElementById('avgLineCheck').addEventListener('change',    e=>{ state.showAvgLine    = e.target.checked; renderChart(); });
document.getElementById('medianLineCheck').addEventListener('change', e=>{ state.showMedianLine = e.target.checked; renderChart(); });
document.getElementById('trendLineCheck').addEventListener('change',  e=>{ state.showTrendLine  = e.target.checked; renderChart(); });
document.getElementById('showLabelsCheck').addEventListener('change', e=>{ state.showLabels     = e.target.checked; renderChart(); });

// Add filter
document.getElementById('addFilterBtn').addEventListener('click', addFilter);

// Save / Load / Export
document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
document.getElementById('loadConfigBtn').addEventListener('click', loadConfig);
document.getElementById('exportPngBtn').addEventListener('click',  exportPNG);

// Sidebar tab switcher
document.querySelectorAll('.sidebar-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.sidebar-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
    state.sidebarTab = tab.dataset.tab;
  });
});

// Field search
document.getElementById('fieldSearch').addEventListener('input', renderSidebar);

// Show Me button
document.getElementById('showMeBtn').addEventListener('click', e=>{
  renderShowMe();
  showMePanel.classList.toggle('hidden');
  e.stopPropagation();
});
document.getElementById('showMeClose').addEventListener('click', ()=>showMePanel.classList.add('hidden'));
document.addEventListener('click', e=>{
  if (!showMePanel.contains(e.target) && e.target.id!=='showMeBtn') {
    showMePanel.classList.add('hidden');
  }
});

// Tooltip: mousemove + leave
canvas.addEventListener('mousemove', e=>{
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const hit = findHit(mx, my);
  if (hit) {
    canvas.style.cursor = 'pointer';
    let html = `<div class="tooltip-label">${escHtml(String(hit.xVal))}</div>`;
    if (hit.colorVal) html += `<div>${escHtml(state.colorCol)}: <strong>${escHtml(String(hit.colorVal))}</strong></div>`;
    html += `<div>${escHtml(state.yCol||'Y')}: <strong>${fmt(hit.yVal)}</strong></div>`;
    if (hit.frac != null) html += `<div>Share: <strong>${(hit.frac*100).toFixed(1)}%</strong></div>`;
    showTooltip(html, mx, my);
  } else {
    canvas.style.cursor = 'crosshair';
    hideTooltip();
  }
});
canvas.addEventListener('mouseleave', hideTooltip);

// Table toggle
document.getElementById('toggleTableBtn').addEventListener('click', ()=>{
  const tw = document.getElementById('tableWrapper');
  const hidden = tw.classList.contains('hidden');
  tw.classList.toggle('hidden');
  document.getElementById('toggleTableBtn').textContent = hidden ? 'Hide Data Table' : 'Show Data Table';
  if (hidden && state.rawData.length) renderTable(applyFilters(state.rawData));
});

// Resize → re-render
new ResizeObserver(()=>{
  if (state.rawData.length && state.xCol && state.yCol) renderChart();
}).observe(document.getElementById('chartContainer'));

// =========================================================
// 24. INIT
// =========================================================
(function init() {
  // Restore chart type from previous session (non-destructive)
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg.chartType) state.chartType = cfg.chartType;
      document.getElementById('markTypeSelect').value = state.chartType;
    }
  } catch {}

  renderSidebar();
  renderShelves();
  updateTableInfo(null);
})();
