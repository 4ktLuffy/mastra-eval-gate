# What a paired, error-aware gate found in Mastra's experiment comparison

Measured against `mastra-ai/mastra` main at `73aaaca04e` (2026-10-05), with the published
`@mastra/core` 1.74.0 and `@mastra/evals` 1.10.5. All runs use real Mastra datasets, experiments
and storage with scripted mock models: no network, no API keys, no LLM judge. Every number comes
from a script in this repository, named next to it, and each script has a negative control (the
same run with nothing wrong), which behaves correctly.

Each finding is labelled by intent after reading the surrounding code, comments, tests, docs and
history: **unintended** (the code does something its own docs or types say it shouldn't, or no one
would choose), **simplification** (a reasonable default that misleads in a case it wasn't written
for), or **not a fault**.

`compareExperiments` (`packages/core/src/datasets/experiment/analytics/compare.ts`) is what a
Mastra user calls to ask "did my change make the agent worse?", and its `hasRegression` is
documented as the CI quick check. The file has not changed since it was added in `927c2af979`
(2026-02-12). It has no test file of its own; `caller-driven-experiments.test.ts:435` calls it and
asserts only a delta of about 0.1.

## What behaved correctly (read this first)

The fault-injection pilot that preceded this work (scripts in the session pilot, summarised in
PLAN.md) found Mastra's core runtime sound where it matters: model timeouts and the
timeout-driven fallback, thrown-error fallback, step retries matching their config,
suspend/resume across processes, invalid tool arguments and tool exceptions all behaved as
documented. The findings below are in how results are compared, not in how agents run.

## 1. An agent that crashes on its hardest items scores higher (unintended)

`evidence/phase0/g5.mjs`, `test/mastra.test.ts` ("an agent that crashes…").

Ten items; the baseline agent answers all of them (7 easy items score 0.9, 3 hard items 0.3).
The candidate is identical but throws a 503 on the 3 hard items.

| | Mastra `compareExperiments` | this gate |
|---|---|---|
| quality | 0.72 → **0.90, delta +0.18** | 0.900 → 0.900 on the 7 items both scored |
| errors | `errorRate: 0`, no warning | **3 new failures**, gate fails |
| `hasRegression` | **false** | — |

Why: the runner records the failure on the result row (`error` set; experiment summary
`failedCount: 3`), but `compareExperiments` reads only score rows (`compare.ts:104`). A scorer that
errors on a failed run persists no score (`experiment/scorer.ts:238-239`, "Persist only scores from
successful scorer runs"), so the failed items leave the mean. `ScorerStats.errorRate` is documented
as "Items with null score / total items" (`analytics/types.ts:16`), but the runner never writes a
null-score row, so it is 0 for every experiment the runner produces.

### 1a. With Mastra's own prebuilt scorers, crashes raise scores

`evidence/phase0/g5_prebuilt.mjs`, `test/mastra.test.ts`.

Scoring failed runs is intentional: the runner skips scoring only on a preflight failure
(`experiment/index.ts:614-616`). But a failed run reaches the scorers with empty input and empty
output, and five prebuilt code scorers split two ways:

| Scorer | Score for a crashed run |
|---|---|
| keyword-coverage, textual-difference, tone | **1.0** (empty matches empty) |
| completeness, content-similarity | scorer throws, so no score: the item leaves the mean |

`compareExperiments` then reports keyword coverage **improving from 0 to 0.3** because of the
crashes. In the same run its `hasRegression` is true, but only because content-similarity moved
by −0.012 on the 7 items it still scored, not because anything noticed the crashes. Labels: each scorer's empty-equals-empty default is a **simplification**; the comparison
not counting failures is **unintended**. Details: `evidence/phase0/INTENT.md`.

## 2. Different item sets are compared as if they were the same (simplification)

`evidence/phase0/g1.mjs`, `test/mastra.test.ts` ("G1").

The candidate is 0.05 better than the baseline on every item, but runs only the 3 hard items.
`compareExperiments` compares the baseline's mean over 10 items (0.72) with the candidate's over 3
(0.35): **delta −0.37, `hasRegression: true`**. Its only warning is about dataset versions
("1 vs null"), not that the item sets differ. The overlap is computed (`compare.ts:121-127`) but
used only for a "no overlapping items" warning.

## 3. A scorer missing from one run counts as a mean of 0 (simplification)

`evidence/phase0/g3.mjs`, `test/mastra.test.ts` ("G3").

Drop a `harm` scorer (lower is better, tolerance 0.05) from the candidate: its mean becomes 0
(`computeMean([])` returns 0, `aggregate.ts:17-19`) and the comparison reads it as a **0.4 improvement**.
Drop it from the baseline instead and the same scorer is a **false regression**. A higher-is-better
scorer dropped from the candidate is a false regression of its full mean.

## 4. Repeated trials: only the last attempt counts (unintended)

`evidence/phase0/g4.mjs`, `test/mastra.test.ts` ("G4").

Mastra supports repeated trials (`runExperimentItem({ attempt })`, "Zero-based repetition index for
repeated trials", `datasets/dataset.ts:863`) and stores one score row per attempt. Its own
`finalizeExperiment` rolls attempts up per item (`dataset.ts:1071-1080`). `groupScoresByScorerAndItem`
(`compare.ts:221-235`) keeps one row per (scorer, item) and overwrites the rest. A flaky agent
scoring 0.9 / 0.1 / 0.2 over three attempts (true mean 0.4) is compared as **0.2**, a false
regression against a stable 0.4 agent.

## 5. Zero tolerance flags half of all no-change comparisons (by design, but worth a number)

`bench/power.ts`, full table `results/power.md` (2000 simulated comparisons per cell).

The default threshold is documented as "no tolerance for regression" (`compare.ts:20-24`). With
any noise at all, two runs of the same system then disagree in sign half the time: the rule
flagged **38.6–51.7%** of no-change comparisons across score types and dataset sizes, and still up
to 40.3% at tolerance 0.05 (pass/fail scores, 10 items). This is a documented default, so it is
**not a fault**; it is listed because it is what users get unless they set thresholds.

## On a real model (Codex)

`bench/real.ts`, every row and output saved in `results/real/` (`R1.json` … `R5.json`,
`summary.json`). A Mastra agent on Codex (`gpt-5.6-luna`, reasoning effort none) answers 30
multi-step arithmetic word problems (`bench/real-dataset.ts`, exact answers known). Two scorers: an
exact-answer code scorer, and an LLM judge that is also Codex (one call per item). 300 Codex calls,
739,563 tokens, median call 14 s.

R1–R4 are the same configuration run four times, so every comparison between them is "no change".
R5 is the same configuration with `itemTimeout: 20_000`; in R1–R3, 21 of 90 items took longer than
20 s (median 15.0 s, max 47.4 s), so the timeout sits at about the 77th percentile.

| Comparison | Mastra `hasRegression` | gate failed |
|---|---|---|
| No change, no failures (R1–R3, 6 ordered pairs) | **3 of 6** | 0 of 6 |
| No change, but R4 had 2 Codex calls that never returned (6 pairs with R4) | 3 of 6 | 3 of 6 (the 3 with R4 as candidate, for the 2 failures) |
| 7 of 30 items time out (R5 vs each of R1–R4) | **2 of 4** | 4 of 4 |

- **Real noise.** With nothing changed, exact-answer accuracy moved by up to 3 items in 30 between
  runs (R1 0.467, R2 0.400, R3 0.500). Mastra's zero-tolerance rule flagged half of the clean
  no-change comparisons; the gate flagged none.
- **Real timeouts hidden.** Against R2 and R4, Mastra reported no regression for R5 and showed
  exact-answer accuracy *improving* (+0.122 and +0.129), because the 7 timed-out items left that
  scorer's mean (R5 scored 23 items, mean 0.522). The gate failed all four comparisons on the 7 new
  failures.
- **The two scorers disagree about failures.** The Codex judge graded the empty replies of
  timed-out items as wrong (score 0, stored), while the exact-answer scorer threw and stored
  nothing. So within one experiment one scorer counted the failures and the other hid them; which
  way Mastra's verdict goes depends on that, not on the agent.
- **R4's failures came from this harness.** Two Codex calls had not returned after 300 s and the
  adapter's own 5-minute cap (`bench/codex-model.ts`) killed them. They are real hangs, but the
  cut-off is ours, not Mastra's.
- **What this run does not show:** a real quality regression. Nothing in R1–R5 changed the
  agent's quality, so there is no detection result on real data here, only false alarms and
  hidden failures.

## Judge-side finding: empty verdict lists score silently (simplification)

`evidence/phase0/g6.mjs`.

When the judge returns well-formed JSON with an empty verdict list while the preprocess step
extracted claims or opinions, the prebuilt LLM scorers return a number with no error and no
`notScorable`: toxicity **1** (worst, and ignores `scale`), faithfulness and answer-relevancy
**0** (worst), bias and hallucination **0** (best). #25039 (merged 2026-09-24) changed the
faithfulness/hallucination denominators but not this case. Not fixed here; mapping it to
`notScorable` would hide judge failures from the mean, so the right fix is a scorer error.

## Side findings

- **Weather template reports success when the model fails.** `templates/weather-agent`
  `weather-workflow.ts:156` iterates `response.textStream`, which ends silently on a model error;
  the workflow returns `status: success` with an empty plan for an in-band rate limit, a thrown
  503, and an empty response. The same file is copied into `examples/oracledb`. A one-line fix
  (`await response.text`, or check `response.error`). Not a pattern elsewhere in the templates.
- **Bias scorer compares verdicts without `trim()`** (`scorers/llm/bias/index.ts:52`), unlike the
  other LLM scorers. Latent: no verdict string in Mastra's 7 recorded judge files
  (`packages/evals/__recordings__`) differs from "yes"/"no"/"unsure" by case, space or punctuation.
- **Filed already, reproduced here:** in-band stream errors never advance the model fallback chain
  (#21280, fallback called 0 times vs once for a thrown error), and parallel tool results are held
  until the slowest tool finishes (#21902, a fast result delayed ~2.7 s).
- **LibSQL file store with concurrent experiment items** raised `SQLITE_BUSY` once in this repo's
  CLI test. Not yet reproduced in isolation.

## The fix

`upstream/compare-experiments.patch` (base `73aaaca04e`). New fields are additive, but two existing
ones change meaning, on purpose:

- **`delta` changes meaning**: it is now the mean change over items scored in both experiments
  whose target run did not fail in either (new `pairedCount`). `statsA`/`statsB` still describe
  each whole experiment, so `statsB.avgScore − statsA.avgScore` can differ from `delta`; the type
  docs say so. A warning names differing item sets.
- **`hasRegression` is also true when a scorer has no scores in B** (previously true or false
  depending on the scorer's direction). The scorer gets `missingIn: 'A' | 'B'`, `delta: 0`, never
  `regressed`. A scorer whose rows are all null counts as missing.
- Repeated attempts are averaged per item. An item whose attempts mix null and a score counts as
  scored.
- `failedItems: { a, b }` (items whose every attempt failed, the rule `finalizeExperiment` uses), a
  warning for items that newly failed in B, and an opt-in `maxFailedItemIncrease` on newly failed
  items.
- Deltas smaller than 1e-9 relative to the scores' magnitude are treated as 0, so averaging noise
  can't trip the zero default (mean(0.9, 0.1, 0.2) − 0.4 ≈ −1e-16; at a 1.2e7 scale the noise is
  1.9e-9, which an absolute guard would flag).

Its test (`analytics/__tests__/compare.test.ts` in the patch) passes 10/10 on the patched files and
fails 10/10 on the original; the float-noise test also fails if the guard is made absolute. The
patched files add no type errors over the original in a sparse checkout of `packages/core/src`
(`upstream/tsconfig.check.json`). It has not been run inside the full Mastra monorepo.
An independent review (Claude Sonnet) found 8 problems in the first version of the patch,
including a type error in `buildEmptyResult`; all are fixed and each has a test.

## The gate, and what it does not do

`src/` adds what a CI gate needs on top of the fix (and goes further than the patch: a candidate
that skipped baseline items, disjoint item sets, and non-finite scores fail coverage; a score is
matched to its own attempt, so a crashed attempt's score is dropped even when a retry succeeded): a one-sided paired sign-flip test per scorer
(Holm-adjusted across scorers), a bootstrap interval for the change, an exact McNemar test for new
failures, scores of failed runs excluded from quality (counted under reliability instead), and the
smallest regression the dataset can detect.

Measured in `bench/power.ts`, including two negative results:

- False alarms when nothing changed (tolerance 0): **0.9–5.2%** for the gate vs 38.6–51.7% for the
  default rule. When the true drop equals a non-zero tolerance, the gate's exact test peaks at 5.7%.
- **No power gain from pairing in this simulation.** An unpaired rule given an oracle cut-off
  (taken from the simulated null, which users can't know) detects real drops slightly more often,
  e.g. pass/fail scores, 20 items, drop 0.2: 32.1% vs the gate's 25.8%. The gate's value is
  controlled false alarms without knowing the noise, plus correct handling of failures, coverage
  and missing scorers, not extra power.
- **The exact test is conservative on discrete scores** (0.9–3.5% false alarms with no change). An opt-in mid-p
  version recovers power (25.8% → 36.0% above) but reached 6.65% false alarms when the true drop
  equals the tolerance, so it is not the default.
- Small pass/fail datasets cannot see small drops with any calibrated rule: with 20 items, at most
  ~36% detection of a 0.2 drop. The gate says so instead of passing silently.
