# Changelog

## 0.2.0

After an independent review (Codex gpt-6-astra, see REVIEWS.md) found ways the 0.1.0 gate could
pass without evidence. **Verdicts change:** some comparisons that passed in 0.1.0 now fail or report
insufficient evidence.

- **Three verdicts.** `verdict` is `pass` (no evidence of a regression, not proof of quality),
  `fail`, or `insufficient`. Empty or unscored experiments, unfinished runs (status other than
  `completed`), scorer outages, items the candidate didn't run, and too few paired items are
  `insufficient`, never `pass`. `passed` is `verdict === 'pass'`. The CLI exits 3 for insufficient.
- **Options are validated.** NaN, negative or out-of-range options throw a `TypeError` (CLI exit 2)
  instead of disabling a check; `--threshold quality=..` is rejected.
- **`expectedScorers`** (`--expect`): scorers that must have scores in both experiments.
- **Reliability is gross, by failure rate.** Fixed items no longer offset newly failing ones, and
  more repetitions are not penalised. New `reliability: 'statistical'` requires the increase to be
  significant (exact McNemar / sign-flip on failure rates), for providers with background
  flakiness; `'strict'` (default) fails on any increase beyond `maxNewTargetFailures`.
- **Coverage is measured per successful attempt, relative to the baseline, and makes the verdict
  `insufficient`** (scorer outage), not `fail`. Items skipped in both runs don't count.
- **No evidence never passes:** if no scorer has valid scores on shared items (unscored baseline,
  all-null or all-NaN scores), or the means overflow, the verdict is `insufficient`.
- **Hardening from a second review of 0.2.0 drafts:** scorer ids such as `constructor` no longer
  pick up inherited properties; cluster ids can't collide with unclustered items; `resamples` is
  capped at 10,000,000; `seed` must be an integer; cluster ids must be strings; a warning names
  failed runs on items only the candidate ran.
- **`clusters`**: item → cluster id; the quality test runs on per-cluster means for correlated items.
- **Minimum detectable effect** accounts for Holm (worst case) and the tolerance, and is NaN when it
  can't be estimated. The "too few items" message is correct (5 items can reach p = 1/32).
- **Item detail:** `items` lists new failures, lost scores and the largest drops; the text report
  prints them.
- Loader reads experiment `status` and `datasetVersion`; differing dataset versions warn.
- CLI loads TypeScript configs directly (0.1.0 needed a tsx wrapper).
- Measured in bench/gate-sim.ts (whole gate) and bench/regate.ts (all saved real runs re-gated).

## 0.1.0

First release.
