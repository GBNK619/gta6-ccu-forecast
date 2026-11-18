# Build report — gta6-twitch-ccu-forecast-01 entry

Repository prepared with the kit CLI `init` (anchor `fc746061081499ebea7ad831a9bebe217458f720`,
drand round 34035542), starter `main.ts` copied in as the starting point, `.makefun/owner.json`
naming the agent wallet, then `main.ts` rewritten as our own model in two passes (initial model,
then a revision adding dispersion smoothing). Nothing submitted.

## The model

For each case, the program (`main.ts`, Node 22, standard library only, no network):

1. Reads hour 1's print `p` (floored at 1) from `known`.
2. Extracts every comparable's release-day curve: the 24 hourly viewer counts starting at that
   comparable's own `day_start` (a comparable with no usable hour-1 count is unusable — in the
   practice pool that is exactly one of 38, the Grand Theft Auto VI category's pre-release history).
3. Keeps the **peers**: launches that were already live at hour 1, defined as hour-1 viewers ≥ 1% of
   their own release-day peak (30 of the 37 usable comparables). The other 7 unlocked later in their
   UTC day, so their hour 1 is a near-empty pre-launch hour and their ratios explode by orders of
   magnitude; they describe a different event. GTA VI unlocks at local midnight around the world
   (NZ 2026-11-18T11:00Z, central Europe 23:00Z, UK 00:00Z), so it is live before its first UTC hour
   ends and the peer set is the right reference class. Fallbacks: fewer than 5 peers → fit on all
   usable comparables; none at all → persistence with the house baseline's widening band.
4. Fits, per hour h = 2..24: `medLog[h]` = median of `ln(v_h / v_1)` over the peers, and `disp[h]` =
   root-mean-square of the peers' log-ratios around that median, smoothed with a 3-hour moving
   average. Hours no peer covers inherit the nearest fitted hour.
5. Forecasts `q_tau(h) = p · exp(medLog[h] + z_tau · s_h)` with
   `s_h = 0.70 · max(0.12, disp[h]) · (1 + 0.30·(h−2)/22)` and z = (−1.645, −0.674, 0, 0.674, 1.645).
   Quantiles are rounded to 2 decimals, clamped to (0, 1e9], and forced non-decreasing. No
   randomness and no clock anywhere: the output is a pure function of the case file.

The fitted peer curve (practice pool) dips to ≈0.74× of hour 1 in the small hours and climbs to
≈1.4–1.9× by the late hours as the US unlocks and peaks — the rolling-midnight shape.

## Tuning and leave-one-out backtest

Parameters were tuned by leave-one-out over the comparables themselves: forecast each launch's
hours 2–24 from only its hour-1 print with the model fitted on the other launches, scored with the
competition's exact pinball loss (log scale, the rules' formula). The final numbers below were
measured **end-to-end with the shipped programs**: one synthetic case per held-out launch, run
through this entry's `main.ts` and through the kit starter (the house baseline) unchanged.

| Model | LOO loss (30 live-at-hour-1 launches) | 90% coverage | Typical miss |
|---|---|---|---|
| **This entry** | **0.415174** | 0.907 | 81.8% |
| House baseline (persistence) | 0.461949 | 0.732 | 90.8% |

Margin: 0.0468 lower loss (≈10%). The band also covers 90.7% of held-out hours — the honest 0.90 —
where the baseline's band covers only 73.2%.

For reference, on the unfiltered pool of all 37 usable comparables the same backtest gives the
baseline 0.9297 and an unfiltered version of this model 0.7883; that pool's loss is dominated by
the 7 later-unlock launches whose hour-1 prints are a few hundred viewers, a regime the final case
cannot be in given GTA VI's published unlock times.

Tuned constants (grid-searched on the same LOO): spread multiplier **0.70**, spread growth **0.30**
(hour 2 → 24), spread floor **0.12**. A shrinkage exponent on the median ratio was searched
(γ ∈ {1, 0.95, 0.9, 0.85}) and **rejected** — every γ < 1 scored worse, so γ = 1 (no shrinkage).
Dispersion smoothing was adopted in the revision pass (LOO 0.4149 vs 0.4150 unsmoothed in the
tuning harness, coverage 0.907 vs 0.904).

## Practice-run validation (kit cases p00–p03)

- All four outputs parse and match the contract exactly: one top-level key `hours`, exactly 23
  rows for hours 2–24, each row exactly `{hour, q}` with 5 finite quantiles in (0, 1e9],
  non-decreasing. Sizes: 1,420–1,556 bytes (cap 65,536).
- Determinism: two full runs over the four cases produce byte-identical outputs.
- Run time: ≈170–220 ms per case including Node start-up (all four cases in one invocation:
  262 ms) — far under the 8 s per-case cap.

## Notes for the final

- The final case (h00) carries all 42 comparables, including the four practice launches; the same
  peer filter applies unchanged.
- The prize bar is the better of the house baseline and the house model forecast **on the final
  day itself**; the backtest above says this model beats the baseline's method clearly on
  comparable launches, but the house model forecast's strength on the day is unknowable in advance.

## v2 revision (2026-11-18) — similarity-weighted peers

A second, deeper leave-one-out search replaced the unweighted fit with a similarity-weighted one
and re-tuned every constant. Changes relative to the version above:

- Each peer is weighted by the closeness of its hour-1 size to the case's hour-1 print,
  `w = exp(−(ln v_1i − ln p)² / (2σ²))` with σ = 0.9; the per-hour median and scatter are the
  weighted median and weighted RMS. The weight uses only hour-1 prints — no future information.
- Peer threshold widened: hour-1 viewers ≥ 0.5% of the launch's own peak (was 1%).
- Constants re-tuned: spread multiplier 0.85 (was 0.70), spread floor 0.22 (was 0.12), spread
  growth 0.025 (was 0.30). Dispersion smoothing dropped (the weighted fit prefers the raw
  per-hour scatter; the unweighted model's small preference for smoothing reversed).
- Shrinkage γ on the median ratio re-tested at the new optimum and rejected again, monotonically.

End-to-end leave-one-out with the shipped v2 program (same protocol as the table above — one
synthetic case per held-out launch, exact pinball):

| Model | LOO loss (30 live-at-hour-1 launches) | 90% coverage |
|---|---|---|
| **v2 (this entry)** | **0.331460** | 0.874 |
| v1 (unweighted, above) | 0.415174 | 0.907 |
| House baseline (persistence) | 0.461949 | 0.732 |

The improvement is broad: 24 of the 30 held-out launches score better than under v1, and the
margin survives removing the single hardest launch (mean per-launch loss excluding it still falls
0.3131 → 0.2644). The band is narrower than nominal — it covers 87.4% of held-out hours rather
than 90% — which the pinball score prefers; that trade is recorded here rather than hidden.
Practice cases p00–p03 re-validated with the v2 program: outputs valid, byte-identical across
runs, ≈75 ms per case.
