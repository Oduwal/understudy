// Renders the dashboard from /api/state. Every figure comes from that response.
const WINDOW_MS = 15 * 60_000;
const REFRESH_MS = 30_000;
const SOURCE_NAMES = { live: "Live", "dry-run": "Dry run", replay: "Replay" };
const RANGES = [{ id: 96, label: "24 h" }, { id: 288, label: "3 d" }, { id: 672, label: "7 d" }];

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dash = '<span class="dash" aria-label="none">&mdash;</span>';
const utcTime = (ms) => new Date(ms).toISOString().slice(11, 16);
const utcDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const describe = (ms) => `${utcDay(ms)}, ${utcTime(ms)}-${utcTime(ms + WINDOW_MS)} UTC`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
const decimal = (n) => (n === null || n === undefined ? null : n.toFixed(1));
const percent = (n) => (n === null || n === undefined ? null : `${(n * 100).toFixed(0)}%`);
const BLOB_ID = /^[A-Za-z0-9_-]{20,100}$/;
const blobLink = (id) => `https://walruscan.com/mainnet/blob/${encodeURIComponent(id)}`;

// Everything from the state file is coerced to the shape the screen expects before any of it
// reaches HTML: numbers to finite numbers, labels to known values, blob IDs to their alphabet.
const finite = (v) => (Number.isFinite(v) ? v : null);
const known = (v, allowed) => (allowed.includes(v) ? v : null);
const numbers = (record) => Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [k, finite(v) ?? 0]));
function sanitizeWindow(w) {
  return {
    window: w.window,
    expected: finite(w.expected) ?? 0,
    low: finite(w.low) ?? 0,
    high: finite(w.high) ?? 0,
    noMemory: finite(w.noMemory) ?? 0,
    actual: finite(w.actual),
    hit: w.hit === true,
    alert: known(w.alert, ["busy", "quiet"]),
    late: w.late === true,
    evidence: finite(w.evidence) ?? 0,
    estimates: numbers(w.estimates),
    weights: numbers(w.weights),
    memoryId: typeof w.memoryId === "string" && BLOB_ID.test(w.memoryId) ? w.memoryId : null,
    writtenAt: finite(w.writtenAt),
  };
}
function sanitize(state) {
  const sources = (state.sources ?? []).filter((key) => key in SOURCE_NAMES);
  const windows = (state.windows ?? []).filter((w) => Number.isFinite(w?.window)).map(sanitizeWindow);
  const alerts = (state.alerts ?? [])
    .filter((a) => Number.isFinite(a?.window) && known(a.kind, ["busy", "quiet"]))
    .map((a) => ({ window: a.window, kind: a.kind, actual: finite(a.actual) ?? 0, low: finite(a.low) ?? 0, high: finite(a.high) ?? 0 }));
  const lessons = (state.lessons ?? [])
    .filter((l) => Number.isFinite(l?.window))
    .map((l) => ({ window: l.window, sentence: String(l.sentence ?? ""), memoryId: typeof l.memoryId === "string" && BLOB_ID.test(l.memoryId) ? l.memoryId : null }));
  return {
    ...state,
    sources,
    source: known(state.source, sources),
    generatedAt: finite(state.generatedAt) ?? Date.now(),
    windows,
    alerts,
    lessons,
    score: Object.fromEntries(Object.entries(state.score ?? {}).map(([k, v]) => [k, finite(v)])),
  };
}

// ?source=live opens straight on a given record, so a link can point at it.
const linked = new URLSearchParams(location.search).get("source");
const ui = { source: linked in SOURCE_NAMES ? linked : null, range: 96, selected: null, state: null, error: null, lastGood: null };

// The local server answers api/state. The hosted copy is static, so it falls back to the
// snapshot files written by scripts/export-site.mjs.
async function fetchState() {
  if (!ui.static) {
    const query = ui.source ? `?source=${encodeURIComponent(ui.source)}` : "";
    const response = await fetch(`api/state${query}`, { cache: "no-store" });
    if (response.ok) return response.json();
    if (response.status !== 404) throw new Error(`HTTP ${response.status}`);
    ui.static = true;
  }
  const response = await fetch(`state/${encodeURIComponent(ui.source ?? "default")}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function load() {
  try {
    ui.state = sanitize(await fetchState());
    ui.source = ui.state.source;
    ui.error = null;
    ui.lastGood = Date.now();
  } catch (error) {
    ui.error = error.message;
  }
  render();
}

const pending = (state) => [...state.windows].reverse().find((w) => w.actual === null) ?? null;
const graded = (state) => state.windows.filter((w) => w.actual !== null);
const selectedWindow = (state) =>
  state.windows.find((w) => w.window === ui.selected) ?? pending(state) ?? state.windows.at(-1) ?? null;

// The one sentence the screen leads with, built from the same figures shown below it.
function finding(state) {
  const { score } = state;
  const alert = state.alerts[0];
  if (!score.graded) return "No window has been graded yet.";
  const verdict =
    score.meanError < score.meanErrorNoMemory
      ? `Memory is helping: mean error ${decimal(score.meanError)} memories against ${decimal(score.meanErrorNoMemory)} without it`
      : score.meanError > score.meanErrorNoMemory
        ? `Memory isn't helping yet: mean error ${decimal(score.meanError)} memories against ${decimal(score.meanErrorNoMemory)} without it`
        : `Memory hasn't changed the error yet: ${decimal(score.meanError)} memories either way`;
  const tail = alert ? ` Latest alert: unusually ${alert.kind}, ${describe(alert.window)}.` : "";
  return `${verdict}, over ${score.graded} graded windows.${tail}`;
}

function renderSources(state) {
  $("sources").innerHTML = state.sources
    .map((key) => `<button class="tab" type="button" data-source="${key}" aria-pressed="${key === state.source}">${SOURCE_NAMES[key]}</button>`)
    .join("");
}

function renderHeader(state) {
  renderSources(state);
  const note = $("note");
  note.hidden = !state.note;
  note.textContent = state.note ?? "";
  note.classList.toggle("is-live", state.source === "live");
  $("finding").textContent = state.source ? finding(state) : "The agent hasn't recorded anything yet.";
  const last = graded(state).at(-1);
  const through = last ? `Graded through ${utcDay(last.window)}, ${utcTime(last.window + WINDOW_MS)} UTC` : "";
  const snapshot = ui.static
    ? `Snapshot taken ${utcDay(state.generatedAt)}, ${utcTime(state.generatedAt)} UTC`
    : state.readFromWalrus
      ? `Read from Walrus at ${utcTime(state.generatedAt)} UTC`
      : "";
  $("stamp").textContent = [through, snapshot].filter(Boolean).join(". ");
}

const FORECASTERS = {
  lastHour: "Last hour",
  usual: "Usual for this time of day",
  average: "Long-run average",
  blend: "Half last hour, half usual",
};

// Each forecaster's share of the final number. A share is the difference between rounded
// running totals, so the shares always add up to the forecast displayed under them.
function trustSteps(w) {
  const names = Object.keys(FORECASTERS).sort((a, b) => w.weights[b] - w.weights[a]);
  let running = 0;
  let shown = 0;
  return names.map((name) => {
    running += w.weights[name] * w.estimates[name];
    const share = Math.round(running) - shown;
    shown += share;
    return { name, share, estimate: Math.round(w.estimates[name]), trust: w.weights[name] };
  });
}

function renderLadder(w) {
  // Forecasts saved before 6 Nov 19:00 UTC stored trust but not each forecaster's estimate,
  // so for those the breakdown shows trust alone rather than inventing the shares.
  const hasEstimates = Object.keys(FORECASTERS).every((name) => Number.isFinite(w.estimates[name]) && Number.isFinite(w.weights[name]));
  const rows = hasEstimates
    ? trustSteps(w)
        .map(({ name, share, estimate, trust }) => `<li>
      <span class="step-name">${FORECASTERS[name]}<span class="step-id">says ${estimate}, trusted ${(trust * 100).toFixed(0)}%</span></span>
      <span class="step-value">${share}</span>
    </li>`)
        .join("")
    : Object.keys(FORECASTERS)
        .sort((a, b) => (w.weights[b] ?? 0) - (w.weights[a] ?? 0))
        .map((name) => `<li><span class="step-name">${FORECASTERS[name]}</span><span class="step-value">${((w.weights[name] ?? 0) * 100).toFixed(0)}%</span></li>`)
        .join("");
  const windows = `${w.evidence} graded ${w.evidence === 1 ? "window" : "windows"}`;
  const evidence = !w.evidence
    ? "No grades yet, so every forecaster is trusted equally."
    : ui.source === "live"
      ? `Trust comes from ${windows} recalled from Walrus Memory.`
      : ui.source === "dry-run"
        ? `Trust comes from ${windows} recalled from the local dry-run store.`
        : `Trust comes from ${windows} earlier in this replay.`;
  return `<p class="ladder-head"><span>Forecaster</span><span>${hasEstimates ? "Adds to forecast" : "Trusted"}</span></p>
  <ol class="ladder">
    ${rows}
    <li><span class="step-name total">Forecast</span><span class="step-value total">${w.expected}</span></li>
    <li><span class="step-name muted">With no memory, equal trust</span><span class="step-value muted">${w.noMemory}</span></li>
  </ol>
  <p class="why-range">${evidence}</p>`;
}

function outcomeLine(w) {
  if (w.actual === null) {
    // A static snapshot measures from when it was taken, not from when it is read.
    if (ui.static) return "Not yet graded when this snapshot was taken";
    const now = Date.now();
    if (now < w.window) return `Opens in ${Math.max(1, Math.round((w.window - now) / 60_000))} min`;
    return "Waiting for the chain to grade it";
  }
  const diff = w.actual - w.expected;
  const against = diff === 0 ? "exactly the forecast" : `${signed(diff)} against the forecast`;
  return `Actual ${w.actual}, ${against}, ${w.hit ? "inside" : "outside"} the range`;
}

function whyPanel(state) {
  const w = selectedWindow(state);
  if (!w) return `<section class="panel"><div class="panel-head"><h2>Why this number</h2></div><p class="empty">The first forecast appears about five minutes before the next window opens.</p></section>`;
  const late = w.late ? ' <span class="pill pill-warning">Written late, not scored</span>' : "";
  return `<section class="panel" aria-labelledby="why">
    <div class="panel-head"><h2 id="why">Why this number</h2></div>
    <p class="why-window">${esc(describe(w.window))}${late}</p>
    <div class="lead-row"><p class="lead">${w.expected}</p><p class="lead-unit">memories expected</p></div>
    <p class="why-range"><span class="figure">${w.low} to ${w.high}</span> expected range. ${esc(outcomeLine(w))}.</p>
    ${proofLine(w)}
    ${renderLadder(w)}
  </section>`;
}

// The forecast's own Walrus blob, and how long before the window it was certified. The blob's
// on-chain certification time is the independent proof that the number came first.
function proofLine(w) {
  // Only the live record is on Walrus; dry-run and replay IDs are local labels.
  if (ui.source !== "live" || !w.memoryId) return "";
  const lead = w.writtenAt === null ? null : Math.round((w.window - w.writtenAt) / 1000);
  const when = lead === null ? "Saved to Walrus Mainnet" : lead > 0
    ? `Saved to Walrus Mainnet ${Math.floor(lead / 60)} min ${lead % 60} s before the window opened`
    : "Saved to Walrus Mainnet after the window opened";
  return `<p class="proof">${when}. <a href="${blobLink(w.memoryId)}" target="_blank" rel="noopener">Blob <span class="figure">${esc(w.memoryId.slice(0, 10))}&hellip;</span></a></p>`;
}

function scoresBlock(score) {
  const items = [
    ["Error with memory", decimal(score.meanError), "mean memories per window"],
    ["Error with no memory", decimal(score.meanErrorNoMemory), "every forecaster trusted equally"],
    ["Last hour alone", decimal(score.meanErrorLastHour), "the simplest rule to beat"],
    ["Inside the range", percent(score.hitRate), `of ${score.graded} graded windows`],
  ];
  return `<dl class="scores">${items
    .map(([label, value, sub]) => `<div class="score"><dt>${label}</dt><dd>${value ?? dash}</dd><p>${sub}</p></div>`)
    .join("")}</dl>`;
}

function chartPanel(state) {
  const controls = RANGES.map(
    (r) => `<button class="tab" type="button" data-range="${r.id}" aria-pressed="${ui.range === r.id}">${r.label}</button>`,
  ).join("");
  return `<section class="panel" aria-labelledby="chart-title">
    <div class="panel-head">
      <h2 id="chart-title">Memories saved per 15 minutes</h2>
      <div class="chart-controls" role="group" aria-label="Time range">${controls}</div>
    </div>
    <div class="legend">
      <span><i class="swatch swatch-actual"></i>Counted on chain</span>
      <span><i class="swatch swatch-band"></i>Forecast range</span>
      <span><i class="swatch swatch-nomemory"></i>No-memory forecast</span>
      <span><i class="swatch swatch-alert"></i>Alert</span>
    </div>
    <div class="chart" id="chart" role="img" aria-label="Forecast range and counted memories per 15-minute window"></div>
    ${scoresBlock(state.score)}
  </section>`;
}

function lessonsTable(lessons, limit) {
  if (!lessons.length) return `<p class="empty">No lessons yet. One is saved when memory clearly changes which forecaster is trusted most.</p>`;
  return `<table><thead><tr><th>Lesson</th><th class="num">Window</th></tr></thead><tbody>${lessons
    .slice(0, limit)
    .map((l) => `<tr data-window="${l.window}" tabindex="0"><td class="sentence">${esc(l.sentence)}</td><td class="num muted">${utcDay(l.window)}<br>${utcTime(l.window)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function alertsPanel(state) {
  const rows = state.alerts.slice(0, 3);
  const body = rows.length
    ? rows
        .map((a) => `<div class="alert-row"><span><span class="pill pill-negative">Unusually ${esc(a.kind)}</span><br><span class="muted">${esc(describe(a.window))}</span></span><span class="figure">${a.actual}<span class="muted"> vs ${a.low}-${a.high}</span></span></div>`)
        .join("")
    : `<p class="empty">No alerts. Nothing has landed far outside the expected range.</p>`;
  return `<section class="panel" aria-labelledby="alerts-title">
    <div class="panel-head"><h2 id="alerts-title">Alerts</h2><span class="meta num">${state.alerts.length}</span></div>
    ${body}
  </section>`;
}

function recordTable(windows, limit) {
  const rows = [...windows].reverse().slice(0, limit);
  if (!rows.length) return `<p class="empty">No windows yet.</p>`;
  return `<table><thead><tr><th>Window (UTC)</th><th class="num">Forecast</th><th class="num">No memory</th><th class="num">Actual</th><th class="num">Error</th><th>Outcome</th></tr></thead><tbody>${rows
    .map((w) => {
      const error = w.actual === null ? dash : signed(w.actual - w.expected);
      const outcome =
        w.actual === null ? '<span class="pill">Waiting</span>'
        : w.late ? '<span class="pill pill-warning">Late</span>'
        : w.alert ? `<span class="pill pill-negative">Unusually ${esc(w.alert)}</span>`
        : w.hit ? '<span class="pill">Inside</span>'
        : '<span class="pill">Outside</span>';
      return `<tr data-window="${w.window}" tabindex="0" aria-selected="${w.window === selectedWindow(ui.state)?.window}">
        <td>${utcDay(w.window)}, ${utcTime(w.window)}</td>
        <td class="num" data-label="Forecast">${w.expected}</td>
        <td class="num phone-hide muted">${w.noMemory}</td>
        <td class="num" data-label="Actual">${w.actual ?? dash}</td>
        <td class="num phone-hide">${error}</td>
        <td class="phone-wide">${outcome}</td>
      </tr>`;
    })
    .join("")}</tbody></table>`;
}

function overview(state) {
  return `<div class="overview">
    <div class="stack">
      ${chartPanel(state)}
      <section class="panel" aria-labelledby="recent-title">
        <div class="panel-head"><h2 id="recent-title">Latest windows</h2><a class="link" href="#record">View all ${state.windows.length}</a></div>
        ${recordTable(state.windows, 4)}
      </section>
    </div>
    <div class="stack">
      ${whyPanel(state)}
      ${alertsPanel(state)}
      <section class="panel" aria-labelledby="lessons-title">
        <div class="panel-head"><h2 id="lessons-title">Recent lessons</h2><a class="link" href="#lessons">View all ${state.lessons.length}</a></div>
        ${lessonsTable(state.lessons, 3)}
      </section>
    </div>
  </div>`;
}

const roundStep = (max) => {
  const rough = Math.max(max, 1) / 4;
  const base = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 2.5, 5, 10].map((m) => m * base).find((s) => s >= rough);
};

function drawChart(state) {
  const host = $("chart");
  if (!host) return;
  // The range is a span of time, not a count of windows, so gaps in the record stay visible.
  const latest = state.windows.at(-1)?.window ?? 0;
  const rows = state.windows.filter((w) => w.window > latest - ui.range * WINDOW_MS);
  const width = host.clientWidth;
  const height = host.clientHeight;
  const m = { top: 10, right: 6, bottom: 22, left: 34 };
  if (!rows.length) {
    host.innerHTML = `<p class="empty">Nothing to draw yet.</p>`;
    return;
  }
  const from = rows[0].window;
  const to = rows.at(-1).window + WINDOW_MS;
  const top = Math.max(...rows.flatMap((r) => [r.high, r.noMemory, r.actual ?? 0]), 1);
  const step = roundStep(top);
  const yMax = Math.ceil((top + 1) / step) * step;
  const x = (t) => m.left + ((t - from) / (to - from)) * (width - m.left - m.right);
  const y = (v) => height - m.bottom - (v / yMax) * (height - m.top - m.bottom);
  const mid = (r) => r.window + WINDOW_MS / 2;
  let grid = "";
  for (let v = 0; v <= yMax; v += step) {
    grid += `<line x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
    grid += `<text x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${v}</text>`;
  }
  const hours = ui.range <= 96 ? 4 : ui.range <= 288 ? 12 : 24;
  const stepMs = hours * 3_600_000;
  const minGap = width < 500 ? 70 : 50;
  let lastLabel = -Infinity;
  for (let t = Math.ceil(from / stepMs) * stepMs; t < to; t += stepMs) {
    const px = x(t);
    if (px - lastLabel < minGap || px > width - m.right - 20) continue;
    lastLabel = px;
    const label = hours >= 24 || t % 86_400_000 === 0 ? utcDay(t) : utcTime(t);
    grid += `<text x="${px}" y="${height - 6}" text-anchor="${px < m.left + 20 ? "start" : "middle"}" class="tick">${esc(label)}</text>`;
  }
  // Lines and the range break wherever windows are missing, so nothing is drawn across a gap
  // in the record (when the agent wasn't running) as if it had been forecast.
  const runs = (list) => {
    const out = [];
    for (const r of list) {
      const run = out.at(-1);
      if (run && r.window - run.at(-1).window === WINDOW_MS) run.push(r);
      else out.push([r]);
    }
    return out;
  };
  const point = (r, v) => `${x(mid(r))},${y(v)}`;
  const counted = rows.filter((r) => r.actual !== null);
  const bands = runs(rows)
    .map((run) => {
      const edge = run.length === 1 ? [{ ...run[0], window: run[0].window - WINDOW_MS / 4 }, { ...run[0], window: run[0].window + WINDOW_MS / 4 }] : run;
      const points = [...edge.map((r) => point(r, r.high)), ...[...edge].reverse().map((r) => point(r, r.low))].join(" ");
      return `<polygon points="${points}" fill="var(--accent)" fill-opacity=".28"/>`;
    })
    .join("");
  const polylines = (list, value, attrs) =>
    runs(list).map((run) => `<polyline points="${run.map((r) => point(r, value(r))).join(" ")}" fill="none" ${attrs}/>`).join("");
  const noMemoryLines = polylines(rows, (r) => r.noMemory, `stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"`);
  const actualLines = polylines(counted, (r) => r.actual, `stroke="var(--chart-actual)" stroke-width="${ui.range > 288 ? 1 : 1.5}"`);
  const alerts = counted.filter((r) => r.alert).map((r) => `<circle cx="${x(mid(r))}" cy="${y(r.actual)}" r="3.500" fill="var(--negative)"/>`).join("");
  const sel = selectedWindow(state);
  const selected = sel && sel.window >= from && sel.window < to
    ? `<line x1="${x(mid(sel))}" x2="${x(mid(sel))}" y1="${m.top}" y2="${height - m.bottom}" stroke="var(--accent)"/>`
    : "";
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <style>.tick{font:400 11px var(--figures);fill:var(--muted)}</style>
    ${grid}
    ${bands}${noMemoryLines}${actualLines}
    ${alerts}${selected}
    <line id="cursor" y1="${m.top}" y2="${height - m.bottom}" stroke="var(--control)" visibility="hidden"/>
  </svg>`;

  const nearest = (clientX) => {
    const box = host.getBoundingClientRect();
    const t = from + ((clientX - box.left - m.left) / (width - m.left - m.right)) * (to - from);
    return rows.reduce((best, r) => (Math.abs(mid(r) - t) < Math.abs(mid(best) - t) ? r : best), rows[0]);
  };
  host.onpointermove = (event) => {
    const r = nearest(event.clientX);
    const cursor = host.querySelector("#cursor");
    cursor.setAttribute("x1", x(mid(r)));
    cursor.setAttribute("x2", x(mid(r)));
    cursor.setAttribute("visibility", "visible");
    const tip = $("tip");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(describe(r.window))}</b><br>Forecast <span class="figure">${r.expected}</span> (<span class="figure">${r.low}-${r.high}</span>)<br>No memory <span class="figure">${r.noMemory}</span><br>Counted <span class="figure">${r.actual ?? "not yet"}</span>`;
    tip.style.left = `${Math.min(window.innerWidth - 250, event.clientX + 14)}px`;
    tip.style.top = `${event.clientY + 14}px`;
  };
  host.onpointerleave = () => {
    $("tip").hidden = true;
    host.querySelector("#cursor")?.setAttribute("visibility", "hidden");
  };
  host.onclick = (event) => {
    ui.selected = nearest(event.clientX).window;
    render();
  };
}

function route() {
  return ["lessons", "record"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
}

function render() {
  const state = ui.state;
  const view = route();
  document.querySelectorAll(".rail-item").forEach((item) => {
    if (item.dataset.view === view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const titles = { overview: "Relayer forecast", lessons: "Lessons", record: "Record" };
  $("title").textContent = titles[view];

  if (!state) {
    if (ui.error) {
      $("view").innerHTML = `<p class="error">Couldn't load the agent's record.<button type="button" id="retry">Retry</button></p>`;
      $("finding").textContent = "";
    } else {
      // The first read after a quiet spell recalls from Walrus, which takes a few seconds.
      $("view").innerHTML = `<p class="loading">Recalling the agent's record from Walrus Mainnet. This takes a few seconds the first time.</p>`;
    }
    return;
  }
  renderHeader(state);
  if (ui.error) {
    $("stamp").textContent = `Couldn't refresh. Last good read ${new Date(ui.lastGood).toISOString().slice(11, 19)} UTC.`;
  }
  if (!state.source) {
    $("view").innerHTML = `<p class="empty full-view">No record yet. Run the agent or the backtest and this screen fills in.</p>`;
    return;
  }
  if (view === "lessons") {
    $("view").innerHTML = `<section class="panel full-view">${lessonsTable(state.lessons, Infinity)}</section>`;
  } else if (view === "record") {
    $("view").innerHTML = `<section class="panel full-view">${recordTable(state.windows, Infinity)}</section>`;
  } else {
    $("view").innerHTML = overview(state);
    drawChart(state);
  }
}

function selectRow(row) {
  ui.selected = Number(row.dataset.window);
  if (location.hash.slice(1) !== "overview" && route() !== "overview") location.hash = "overview";
  else render();
}

document.addEventListener("click", (event) => {
  const source = event.target.closest("[data-source]");
  if (source) {
    ui.source = source.dataset.source;
    ui.selected = null;
    load();
    return;
  }
  const range = event.target.closest("[data-range]");
  if (range) {
    ui.range = Number(range.dataset.range);
    render();
    return;
  }
  if (event.target.id === "retry") {
    load();
    return;
  }
  const row = event.target.closest("tr[data-window]");
  if (row) selectRow(row);
});
document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("tr[data-window]");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectRow(row);
  }
});
window.addEventListener("hashchange", render);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => ui.state && route() === "overview" && drawChart(ui.state), 120);
});

load();
setInterval(load, REFRESH_MS);
