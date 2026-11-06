// Pure forecasting logic. Nothing here touches the network, so it can be replayed over history.
//
// Several simple forecasters read the same chain activity. None of them is good on its own,
// because relayer traffic is noisy. The agent's memory holds how each one has been graded, and
// that track record decides how much each is trusted for the next window.
import { DAY_MS, WINDOW_MS, windowStart } from "./windows.mjs";

export const FORECASTER_NAMES = {
  lastHour: "Last hour",
  usual: "Usual for this time of day",
  average: "Long-run average",
  blend: "Half last hour, half usual",
};
const NAMES = Object.keys(FORECASTER_NAMES);

// Chosen on the first half of a week of real history, then checked on the second half.
const TRUST = { sharpness: 10, halfLifeHours: 3, sameTimeRadiusWindows: 4, otherTimeWeight: 0.3 };

const RECENT_WINDOWS = 4;
const USUAL_DAYS = 7;
const DEFAULT_BAND = { q10: -0.45, q90: 0.45 };
const MIN_BAND_HALF_WIDTH = 0.1;
const MIN_BAND_SAMPLES = 20;

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
export const logError = (actual, expected) => Math.log((actual + 1) / (expected + 1));

// Knows the count per window and which time range has actually been read. A window inside
// the range with no rows really had zero calls; a window outside it is unknown.
export function createActivity(counts, coveredFrom, coveredTo) {
  return {
    coveredFrom,
    coveredTo,
    get(start) {
      if (start < coveredFrom || start + WINDOW_MS > coveredTo) return null;
      return counts.get(start) ?? 0;
    },
  };
}

// Every forecaster's estimate, using only windows finished by `asOf`. Null if data is missing.
export function runForecasters(activity, target, asOf) {
  const seenEnd = windowStart(asOf);
  const recent = [];
  for (let i = 1; i <= RECENT_WINDOWS; i++) recent.push(activity.get(seenEnd - i * WINDOW_MS));
  if (recent.includes(null)) return null;

  const earlier = [];
  for (let day = 1; day <= USUAL_DAYS; day++) {
    for (let offset = -1; offset <= 1; offset++) {
      const value = activity.get(target - day * DAY_MS + offset * WINDOW_MS);
      if (value !== null) earlier.push(value);
    }
  }
  if (!earlier.length) return null;

  let total = 0;
  let count = 0;
  for (let start = activity.coveredFrom; start < seenEnd; start += WINDOW_MS) {
    total += activity.get(start) ?? 0;
    count += 1;
  }

  const lastHour = mean(recent);
  const usual = mean(earlier);
  return { lastHour, usual, average: total / count, blend: (lastHour + usual) / 2 };
}

const equalWeights = () => Object.fromEntries(NAMES.map((name) => [name, 1 / NAMES.length]));

// Turns graded windows recalled from memory into a weight for each forecaster. Recent grades
// count most, and grades from this same time of day count more than others.
export function computeTrust(grades, target, asOf) {
  const known = grades.filter((grade) => grade.window + WINDOW_MS <= asOf && grade.errs);
  if (!known.length) {
    return { weights: equalWeights(), typicalMiss: null, evidence: 0, leader: null };
  }
  const typicalMiss = {};
  for (const name of NAMES) {
    let weightSum = 0;
    let errorSum = 0;
    for (const grade of known) {
      const hoursAgo = (target - grade.window) / 3_600_000;
      const apart = (((grade.window - target) % DAY_MS) + DAY_MS) % DAY_MS;
      const windowsApart = Math.min(apart, DAY_MS - apart) / WINDOW_MS;
      const sameTime = Math.exp(-((windowsApart / TRUST.sameTimeRadiusWindows) ** 2));
      const weight = 0.5 ** (hoursAgo / TRUST.halfLifeHours) * (TRUST.otherTimeWeight + (1 - TRUST.otherTimeWeight) * sameTime);
      weightSum += weight;
      errorSum += weight * (grade.errs[name] ?? 0);
    }
    typicalMiss[name] = weightSum ? errorSum / weightSum : 0;
  }
  const best = Math.min(...NAMES.map((name) => typicalMiss[name]));
  const raw = NAMES.map((name) => Math.exp(-TRUST.sharpness * (typicalMiss[name] - best)));
  const total = raw.reduce((sum, v) => sum + v, 0);
  const weights = Object.fromEntries(NAMES.map((name, i) => [name, raw[i] / total]));
  const leader = NAMES.reduce((top, name) => (weights[name] > weights[top] ? name : top), NAMES[0]);
  return { weights, typicalMiss, evidence: known.length, leader };
}

// How far equal trust has recently been off, using only what was known at each moment.
export function recentResiduals(activity, asOf, days = 2, leadMs = 5 * 60_000) {
  const errors = [];
  const end = windowStart(asOf) - WINDOW_MS;
  for (let target = end - days * DAY_MS; target <= end; target += WINDOW_MS) {
    const actual = activity.get(target);
    if (actual === null) continue;
    const estimates = runForecasters(activity, target, target - leadMs);
    if (estimates) errors.push(logError(actual, mean(Object.values(estimates))));
  }
  return errors;
}

export function calibrateBand(logErrors) {
  if (logErrors.length < MIN_BAND_SAMPLES) return DEFAULT_BAND;
  const sorted = [...logErrors].sort((a, b) => a - b);
  const at = (q) => sorted[Math.floor(q * (sorted.length - 1))];
  return {
    q10: Math.min(at(0.1), -MIN_BAND_HALF_WIDTH),
    q90: Math.max(at(0.9), MIN_BAND_HALF_WIDTH),
  };
}

export function buildForecast({ activity, target, asOf, grades, band }) {
  const estimates = runForecasters(activity, target, asOf);
  if (!estimates) return null;
  const trust = computeTrust(grades, target, asOf);
  const expected = NAMES.reduce((sum, name) => sum + trust.weights[name] * estimates[name], 0);
  return {
    window: target,
    expected: Math.round(expected),
    low: Math.max(0, Math.floor((expected + 1) * Math.exp(band.q10) - 1)),
    high: Math.ceil((expected + 1) * Math.exp(band.q90) - 1),
    noMemory: Math.round(mean(Object.values(estimates))),
    estimates,
    weights: trust.weights,
    typicalMiss: trust.typicalMiss,
    evidence: trust.evidence,
    leader: trust.leader,
  };
}

// An alert means well outside the normal range, not merely a miss.
export function gradeForecast(forecast, actual, band) {
  const stretch = (band.q90 - band.q10) / 2;
  const alertLow = (forecast.low + 1) * Math.exp(-stretch) - 1;
  const alertHigh = (forecast.high + 1) * Math.exp(stretch) - 1;
  return {
    window: forecast.window,
    actual,
    hit: actual >= forecast.low && actual <= forecast.high,
    alert: actual < alertLow ? "quiet" : actual > alertHigh ? "busy" : null,
    errors: {
      forecast: Math.abs(actual - forecast.expected),
      noMemory: Math.abs(actual - forecast.noMemory),
    },
    errs: Object.fromEntries(NAMES.map((name) => [name, Math.abs(logError(actual, forecast.estimates[name]))])),
  };
}
