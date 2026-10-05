# Changelog

## 0.3.1

From using the package as a Mastra user, on a fresh project from `npx create-mastra` (FINDINGS.md,
"Field test"):

- **`--storage <libsql url>`**: the CLI reads experiments straight from Mastra's LibSQL storage
  (`file:./mastra.db`, or a Turso URL with `TURSO_AUTH_TOKEN`) without loading the app. With
  `--mastra src/mastra/index.ts`, the default template's DuckDB observability store failed with a
  file-lock error while an experiment was running; storage-only mode ran in 0.5 s.
- The report's scorer column fits long scorer names (Mastra's `code-tool-call-accuracy-scorer`).
- **Items that change consistently across runs are named.** With ≥ 2 runs per side, items that
  score lower in every candidate run than in every baseline run get a warning and a
  `consistent-drop` entry in `items`. An item-level test can't make a change on 2–3 of 20 items
  significant; in the field test this listing found that a "regression" Mastra flagged three times
  was the scorer rejecting correct answers written with an en dash and a curly apostrophe.

- **Each new failure shows the target's error** (`items[].error`, and an `error:` line in the
  report), so a suspended workflow, a timeout and a crash read differently. In Studio, a
  human-review step that suspends 2 items now reports Mastra's own "Workflow suspended — provide
  resume data …" next to each.
- **Warning for a scorer at its floor everywhere.** A higher-is-better scorer that scores its
  minimum on every item in both experiments cannot show a change. Mastra's prebuilt answer-relevancy
  judge did this on a workflow target: it received empty input and output and scored 0 on 20
  correct answers, without an error.

## 0.3.0

- **Run time and token checks.** `latency: { maxIncrease }` and `tokens: { maxIncrease }` (CLI
  `--max-latency-increase`, `--max-token-increase`) fail the gate when per-item run time or token use
  grows beyond the allowance, significantly (one-sided sign-flip on per-item log ratios, geometric
  mean reported). Without them the report still shows both, and warns on a significant rise over
  20%. Read from Mastra's `startedAt`/`completedAt` and agent `usage.totalTokens`.
- **Several runs per side.** `gate()` and `compareRows()` take one experiment or several runs of
  the same dataset (CLI: repeat `--baseline` / `--candidate`). Items are averaged across runs. In
  bench/gate-sim.ts, 1 / 3 / 5 runs of 20 pass/fail items caught a 0.1 drop 9% / 25% / 34% of the
  time, with false alarms 2.7–3.3%.
- **`test: 'betting'`** (CLI `--test betting`): a test by betting (Waudby-Smith & Ramdas) with no
  symmetry assumption, for scores within `scoreBounds` (default [0, 1]); items are taken in a seeded
  random order. It removes the skewed-scores weakness (false alarms 0–3.3% vs 12%); on the real
  Codex runs it gives the same verdicts as sign-flip. It costs power: a 0.1 drop over 20 continuous
  items is caught 3.4% of the time vs 63.0%, and it gains little from extra runs. The default stays
  `'sign-flip'`.
- The report shows the test used, the number of runs, and run time / tokens.
- Fixes from a review of the 0.3.0 drafts (REVIEWS.md): betting takes items in a seeded random
  order; tokens read `totalUsage` (all steps) before `usage` (last step); requested run-time /
  token checks without valid measurements are insufficient; scores without an attempt number are
  attributed within their own run, and ambiguous ones where attempts failed are insufficient (was a
  warning); betting needs overlapping run pairs and equal run counts; attempt numbers can't collide
  across runs.


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
