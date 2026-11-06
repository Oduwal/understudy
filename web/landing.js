// The live tile: the newest forecast, read from Walrus by api/state (or the static snapshot
// when hosted without the function), with its clock running to the window and the grade.
// Also the section entrances. Everything still reads without this script.
const WINDOW_MS = 15 * 60_000;
const GRADE_AFTER_MS = 90_000;
const BLOB_ID = /^[A-Za-z0-9_-]{20,100}$/;

const $ = (id) => document.getElementById(id);
const finite = (v) => (Number.isFinite(v) ? v : null);
const utcTime = (ms) => new Date(ms).toISOString().slice(11, 16);
const utcDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function liveState() {
  const api = await fetch("api/state?source=live", { cache: "no-store" });
  if (api.ok) return api.json();
  const snapshot = await fetch("state/live.json", { cache: "no-store" });
  if (!snapshot.ok) throw new Error(`HTTP ${snapshot.status}`);
  return snapshot.json();
}

function tick(w) {
  const now = Date.now();
  const opens = w.window;
  const closes = w.window + WINDOW_MS;
  let text;
  if (finite(w.actual) !== null) text = `Counted ${w.actual}`;
  else if (now < opens) text = `Opens in ${clock(opens - now)}`;
  else if (now < closes) text = `Window open, ${clock(closes - now)} left`;
  else if (now < closes + GRADE_AFTER_MS) text = "Being graded now";
  else text = "Graded on the dashboard";
  $("live-clock").textContent = text;
}

function show(w, state) {
  $("live-window").textContent = `${utcDay(w.window)}, ${utcTime(w.window)}–${utcTime(w.window + WINDOW_MS)} UTC`;
  $("live-number").textContent = finite(w.expected) ?? "–";
  const low = finite(w.low);
  const high = finite(w.high);
  $("live-range").textContent = low !== null && high !== null ? `Range ${low} to ${high}` : "";
  const writtenAt = finite(w.writtenAt);
  if (writtenAt !== null && writtenAt < w.window) {
    const lead = Math.round((w.window - writtenAt) / 1000);
    $("live-saved").textContent = `Saved to Walrus ${Math.floor(lead / 60)} min ${lead % 60} s before it opens`;
  }
  if (typeof w.memoryId === "string" && BLOB_ID.test(w.memoryId)) {
    const link = $("live-blob");
    link.href = `https://walruscan.com/mainnet/blob/${encodeURIComponent(w.memoryId)}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `Blob ${w.memoryId.slice(0, 10)}… on Walruscan`;
  }
  tick(w);
  setInterval(() => tick(w), 1000);

  const score = state.score ?? {};
  const graded = finite(score.graded);
  const withMemory = finite(score.meanError);
  const none = finite(score.meanErrorNoMemory);
  const lastHour = finite(score.meanErrorLastHour);
  const lastHourWindows = finite(score.lastHourWindows);
  const memoryOnThose = finite(score.meanErrorOnLastHourWindows);
  if (graded && withMemory !== null && none !== null) {
    // Each comparison is made over the same windows, and says how many.
    const single = lastHour !== null && memoryOnThose !== null && lastHourWindows
      ? ` Over the ${lastHourWindows} that stored every estimate: ${memoryOnThose.toFixed(1)} with memory, ${lastHour.toFixed(1)} for last hour alone.`
      : "";
    $("live-score").textContent = `The live record so far, over ${graded} graded windows: ${withMemory.toFixed(1)} with memory, ${none.toFixed(1)} without.${single}`;
  }
}

function reveal() {
  const parts = document.querySelectorAll(".field .card, .field .clause, .field-heading, .figures-heading, .step, .figures-note, .board .tile, .action-tile, .flank, .b, .foot-grid > div");
  parts.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${(i % 4) * 70}ms`;
  });
  const shutter = document.querySelector(".shutter");
  if (!("IntersectionObserver" in window)) {
    parts.forEach((el) => el.classList.add("in"));
    shutter?.classList.add("in");
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      seen.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  parts.forEach((el) => seen.observe(el));
  requestAnimationFrame(() => shutter?.classList.add("in"));
  document.querySelector(".c5 .frame:nth-child(2)")?.classList.add("drift");
}

reveal();
try {
  const state = await liveState();
  const windows = Array.isArray(state.windows) ? state.windows.filter((w) => Number.isFinite(w?.window)) : [];
  const newest = windows.at(-1);
  if (newest) show(newest, state);
} catch {
  $("live-window").textContent = "The live record couldn't be read just now.";
  $("live-clock").textContent = "See the dashboard";
}
