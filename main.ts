// gta6-twitch-ccu-forecast-01 — entry: a comparable-curves forecaster (Node 22, standard library only).
//
// Idea: a big launch's release-day Twitch curve, measured as the ratio of each hour's viewers to its
// hour-1 viewers, has a characteristic shape — a dip in the small hours, then a climb as the US wakes
// up and unlocks. The case hands us 38–42 past launches with full hourly curves, so instead of guessing
// that shape we measure it: for every past launch that was already live in its first UTC hour, take the
// ratios r_h = v_h / v_1 of its release day, and forecast this case's hours as
//
//   q_tau(h) = p * exp(medLog_h + z_tau * s_h)
//
// where p is this case's hour-1 print, medLog_h is the median of ln r_h over the comparable launches,
// and s_h is a spread fitted to how much those launches' log-ratios scatter around their median at
// hour h. The scatter is the honest part: launches differ, so the band widens over the day.
//
// Which comparables: only launches that were already live at hour 1 — their hour-1 viewers at least
// 0.5% of their own release-day peak. The rest unlocked later in their UTC day (a global afternoon
// unlock, a regional morning), so their hour 1 is a near-empty pre-launch hour and their ratios
// explode; they describe a different event than this one. Grand Theft Auto VI unlocks at local
// midnight around the world — New Zealand 2026-11-18T11:00Z, central Europe 23:00Z, the UK 00:00Z —
// so by its first UTC hour most of the world is already playing, and the live-at-hour-1 launches are
// its true peers. If too few comparables pass the test we fall back to all of them, and with none at
// all to persistence (the house baseline's shape), so the program always writes a valid forecast.
//
// Within the peers, a launch counts for more the closer its hour-1 size is to this case's: peer i
// weighs exp(−(ln v_1i − ln p)² / (2σ²)) with σ = 0.9, and the median and the scatter are the weighted
// versions. A launch that opened at 200,000 viewers says more about a case that opened at 250,000
// than one that opened at 5,000 does — size is the one thing hour 1 tells us, so the fit listens to
// it. The weight uses only the known hour-1 prints, nothing from later hours.
//
// The constants (MULT, GROWTH, FLOOR, σ, the peer threshold) were tuned by leave-one-out backtest
// over the comparable launches themselves: forecast each launch's hours 2–24 from only its hour-1
// print, with the model fitted on the others, and score with the contest's exact pinball loss on the
// log scale. On the 30 live-at-hour-1 launches that gives a mean loss of 0.3315 against the house
// baseline's 0.4619 scored the same way, and against 0.4152 for this model's own unweighted first
// version; 24 of the 30 launches improve, so the gain is broad rather than one launch's luck. A
// shrinkage of the median ratio toward 1 was tried and rejected by the same backtest (it only hurt).
// No randomness, no clock: two runs on the same case write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOUR_MS = 3600_000;

/** A comparable counts as a peer when its hour-1 viewers reach this share of its own day's peak. */
const LIVE_SHARE_MIN = 0.005;
/** Fewer peers than this and we fit on every usable comparable instead. */
const MIN_PEERS = 5;
/** Global multiplier on the fitted per-hour spread (backtest-tuned). */
const SPREAD_MULT = 0.85;
/** The spread never falls below this, however much the peers agree. */
const SPREAD_FLOOR = 0.22;
/** The spread grows by this fraction from hour 2 to hour 24 (backtest-tuned). */
const SPREAD_GROWTH = 0.025;
/** Width (in log viewers) of the similarity weighting: peers near the case's hour-1 size weigh most. */
const WEIGHT_SIGMA = 0.9;

interface HourlyPoint { from: string; viewers: number }
interface Comparable { day_start: string; hourly?: HourlyPoint[] }
interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up), as the house baseline writes its quantiles. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * The weighted median of [value, weight] pairs: the smallest value whose cumulative weight,
 * taken in value order, reaches half the total weight.
 */
const weightedMedian = (pairs: Array<[number, number]>): number => {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of s) total += w;
  let cum = 0;
  for (const [x, w] of s) {
    cum += w;
    if (cum >= total / 2) return x;
  }
  return s[s.length - 1][0];
};

/**
 * A comparable's release-day curve: its 24 hourly viewer counts starting at its own day_start,
 * null where the source has no point. Returns null when hour 1 has no usable count, because every
 * ratio hangs off that hour.
 */
function releaseDayCurve(comp: Comparable): number[] | null {
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const vals: number[] = new Array(24).fill(null);
  for (const pt of comp.hourly ?? []) {
    const t = Date.parse(pt.from);
    if (!Number.isFinite(t)) continue;
    const idx = Math.round((t - start) / HOUR_MS);
    if (idx < 0 || idx > 23 || Math.abs(t - start - idx * HOUR_MS) > 60_000) continue;
    if (typeof pt.viewers === 'number' && Number.isFinite(pt.viewers)) vals[idx] = pt.viewers;
  }
  if (vals[0] == null || vals[0] <= 0) return null;
  return vals;
}

/** Was this launch already live in its first hour? (Hour 1 vs its own release-day peak.) */
const wasLiveAtHour1 = (curve: number[]): boolean => {
  let peak = 0;
  for (const v of curve) if (v != null && v > peak) peak = v;
  return peak > 0 && curve[0] / peak >= LIVE_SHARE_MIN;
};

interface Fit { medLog: number[]; disp: number[] }

/**
 * Fit the median log-ratio curve and the per-hour scatter of the log-ratios around it, with each
 * comparable weighted by how close its hour-1 size is to this case's (logP = ln of the case print).
 */
function fitCurves(curves: number[][], logP: number): Fit {
  const weights = curves.map((c) => {
    const d = (Math.log(c[0]) - logP) / WEIGHT_SIGMA;
    return Math.exp(-0.5 * d * d);
  });
  const medLog: number[] = new Array(25).fill(null);
  const disp: number[] = new Array(25).fill(null);
  for (let h = 2; h <= 24; h++) {
    const entries: Array<[number, number]> = [];
    for (let i = 0; i < curves.length; i++) {
      const v = curves[i][h - 1];
      if (v != null && v > 0) entries.push([Math.log(v / curves[i][0]), weights[i]]);
    }
    if (entries.length === 0) continue;
    const m = weightedMedian(entries);
    medLog[h] = m;
    let sw = 0;
    let ss = 0;
    for (const [x, w] of entries) {
      ss += w * (x - m) * (x - m);
      sw += w;
    }
    disp[h] = Math.sqrt(ss / sw);
  }
  // An hour no peer covers takes the nearest fitted hour's values, so every hour can be forecast.
  for (let h = 2; h <= 24; h++) {
    if (medLog[h] != null) continue;
    let best: number | null = null;
    for (let g = 2; g <= 24; g++) {
      if (medLog[g] != null && (best == null || Math.abs(g - h) < Math.abs(best - h))) best = g;
    }
    medLog[h] = best == null ? 0 : medLog[best];
    disp[h] = best == null ? 0.3 : disp[best];
  }
  // No smoothing of the scatter across hours: the weighted fit already rests each hour on the
  // launches nearest the case, and the backtest prefers the raw per-hour scatter (it scored the
  // smoothed variant of this model worse, reversing the unweighted model's small preference).
  return { medLog: medLog as number[], disp: disp as number[] };
}

/** The forecast rows for one case: five quantiles for each hour the case asks for. */
function forecastHours(p: number, fit: Fit | null, hours: number[]): Array<{ hour: number; q: number[] }> {
  return hours.map((h) => {
    let centre: number;
    let spread: number;
    if (fit == null) {
      // No usable comparable at all: persistence, the house baseline's widening band.
      centre = Math.log(p);
      spread = 0.15 * Math.sqrt(h - 1);
    } else {
      centre = Math.log(p) + fit.medLog[h];
      spread = SPREAD_MULT * Math.max(SPREAD_FLOOR, fit.disp[h]) * (1 + (SPREAD_GROWTH * (h - 2)) / 22);
    }
    const q = Z.map((z) => Math.min(1e9, Math.max(0.01, round2(Math.exp(centre + z * spread)))));
    // Rounding at tiny scales must never break the non-decreasing order the format demands.
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { hour: h, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${file} has no hour-1 print`);
  const p = Math.max(1, first.viewers);

  const curves: number[][] = [];
  for (const comp of c.comparables ?? []) {
    const curve = releaseDayCurve(comp);
    if (curve != null) curves.push(curve);
  }
  const peers = curves.filter(wasLiveAtHour1);
  const fit = curves.length === 0 ? null : fitCurves(peers.length >= MIN_PEERS ? peers : curves, Math.log(p));

  const hours = c.forecast.map((f) => f.hour);
  const rows = forecastHours(p, fit, hours);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: rows })}\n`);
}
