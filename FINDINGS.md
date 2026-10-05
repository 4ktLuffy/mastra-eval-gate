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

| Comparison | Mastra `hasRegression` | gate (0.2.0) fail, default `'strict'` | gate `'statistical'` |
|---|---|---|---|
| No change, no failures (R1–R3, 6 ordered pairs) | **3 of 6** | 0 of 6 | 0 of 6 |
| No change, but R4 had 2 Codex calls that never returned (6 pairs with R4) | 3 of 6 | 3 of 6 (the 3 with R4 as candidate) | 0 of 6 |
| 7 of 30 items time out (R5 vs each of R1–R4) | **2 of 4** | 4 of 4 | 3 of 4 |

Gate verdicts in this section are from 0.2.0, recomputed offline from the saved rows by
`bench/regate.ts` (`results/real/regate.md`); 0.1.0 gave the same fail counts here.

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
- R1–R5 contain no real quality change, so detection is tested separately below.

### Detecting a real regression

`bench/real-effort.ts`, `results/real/MED.json`, `NONE.json`, `effort-summary.json`. A change teams
actually make to save cost: the same agent and prompt, with reasoning effort lowered from medium to
none. Same Mastra instance and dataset, exact-answer scorer, 60 Codex calls.

| | effort medium | effort none |
|---|---|---|
| exact-answer accuracy | 30 / 30 | 13 / 30 |

Mastra flags it (delta −0.567) and so does the gate: *worse by 0.567 on 30 paired items, 95% CI
−0.733 to −0.400, Holm p = 5.0e-5*. On a large real regression the two agree; the difference is the
no-change runs, where the gate stayed quiet and Mastra did not.

**A first attempt found no regression to detect (negative result).** `bench/real-detect.ts`
(`results/real/B1.json`, `B2.json`, `D.json`, `detect-summary.json`) compared the baseline prompt
with one that says *reply with only the final number, do not work the problem out*. At effort none
that did not lower accuracy: B1 0.567, B2 0.467, D 0.517. The same run gave one more Mastra false
alarm (B1 → B2, no change: delta −0.10, `hasRegression: true`).

**It also exposed a flaw in the gate, now fixed.** The Codex judge errored on one item in B2 and on
others in B1 (Codex returned "Selected model is at capacity" in this period). The gate's coverage
check counted only items the candidate's scorer lost, so a judge that misses an item now and then
failed even the no-change comparison. Coverage is now net (lost in the candidate minus lost in the
baseline), like reliability; `test/compare.test.ts` "coverage is net" reproduces the case. The
saved B1/B2/D files record question text for 20 of 30 items (a pagination slip in the script,
fixed), which is why the effort comparison was run in one instance instead of against them.

### Do Mastra's tool mocks reduce noise? (mostly no, here)

`bench/real-mocks.ts`, `results/real/L1-3.json`, `M1-3.json`, `mocks-summary.json`. The same 30
problems, but the starting stock comes from a `lookupStock` tool (the Codex adapter's tool-calling
path). L1–L3 use the live tool, which throws a 503 on 30% of calls (**simulated** flakiness); M1–M3
serve the correct output through Mastra's `toolMocks`. Exact-answer scorer, 387 Codex calls.

| | live tool (L1–L3) | `toolMocks` (M1–M3) |
|---|---|---|
| tool calls / simulated 503s | 120 / 37 | 0 / 0 (all served by mocks) |
| accuracy per run | 0.400, 0.367, 0.533 | 0.567, 0.633, 0.433 |
| items whose outcome differs across runs | 13 / 30 | 12 / 30 |
| SD of paired per-item change | 0.533 | 0.512 |
| items needed to detect a 0.1 drop (80% power, normal approx.) | 176 | 162 |
| Mastra `hasRegression`, 6 no-change pairs | 3 | 3 |
| gate failed, 6 no-change pairs | 0 | **1** |

- **Mocks removed the tool's failures but barely the noise.** The agent retried after each 503 and
  every item still succeeded, so the remaining run-to-run variance is the model's own: about 40% of
  items flip between runs at reasoning effort none. Mocks raised accuracy (fewer failed lookups)
  but cut the items needed for a 0.1 drop only from 176 to 162. A negative result for the idea
  that mocks make small datasets usable here.
- **The gate false-alarmed once** (M2 → M3: *worse by 0.200 on 30 paired items, 95% CI −0.367 to
  −0.033, Holm p = 0.035*), with nothing changed. Across all 20 real no-change comparisons in this
  repository (R1–R3, B1↔B2, L1–L3, M1–M3), re-gated with 0.2.0: **the gate failed 1 (5%), passed
  17, and reported insufficient evidence on 2** (B1↔B2, where the Codex judge errored on an item in
  each run); **Mastra flagged 10 (50%)**.
- **What a 30-item dataset can see.** With noise like this, a 0.1 drop needs about 160–180 items;
  30 items reliably see only drops of about 0.23 (the gate's `minimumDetectable` in the effort run).
  The gate reports that number instead of passing silently.

### A customer-style benchmark (no difference between the two, here)

`bench/real-support.ts` and `bench/support-tickets.ts`, specified in the file header before running
(workload, seeded regression, runs, decision rules); `results/real/SB1-3.json`, `SX1-2.json`,
`support-summary.json`. A support agent for an online shop on Codex (`gpt-5.6-luna`, effort none)
answers 30 seeded tickets with three tools (`lookupOrder`, `issueRefund`, `escalate`) under a
four-rule refund policy. The `action` scorer checks the refund/escalate calls against the policy.
The seeded regression deletes rule 2 ("orders over $100 must be escalated"), which only the 8
escalate tickets can feel. 377 Codex calls, 480,386 tokens.

| | runs | accuracy | Mastra flagged | gate (0.2.0) |
|---|---|---|---|---|
| baseline | SB1, SB2, SB3 | 29/30 each | 0 of 6 no-change pairs | 6 pass |
| rule 2 deleted | SX1, SX2 | 21/30 each | 6 of 6 | 6 fail (change −0.267, Holm p ≈ 0.004) |

- **This workload does not separate the tools.** The agent was almost deterministic here, so there
  was no noise for Mastra's zero-tolerance rule to trip on, and the regression turned out to be the
  largest the deleted rule could cause (all 8 escalate tickets lost), not a modest one. Both catch
  it; neither false-alarms. What it does show: the gate is not over-cautious on a realistic
  workload, catching a real policy regression with 30 tickets at p ≈ 0.004 while passing every
  no-change pair (its estimate of the smallest drop it could catch here was 0.12–0.20).
- **The baseline's one miss per run was a claimed action that never happened.** Each baseline run
  got one escalate ticket wrong, a different one each time, and each time the agent told the
  customer it had escalated ("I've escalated your refund request to a human agent") without
  calling `escalate`. A judge reading only the reply would have passed it.
- **The regression issued refunds the policy forbids.** Without rule 2, the agent called the refund
  tool for over-$100 orders it should have escalated ($482, $499, $872, $881 in SX1) and declined
  others. The tool is simulated (it returns an acknowledgement), so no money moved; in production it
  would have.
- **The scorer in this run checked tool names, not arguments** (a second review, gpt-6-astra, showed
  `issueRefund` on the wrong order followed by `escalate` would score 1). The saved accuracies use
  that scorer. `bench/real-support.ts` now checks the order id, the refund amount, and that exactly
  one action was taken, and saves full tool calls; a dry run on 4 tickets scored as expected. The
  saved run was not repeated.

## Judge-side finding: empty verdict lists score silently (simplification)

`evidence/phase0/g6.mjs`.

When the judge returns well-formed JSON with an empty verdict list while the preprocess step
extracted claims or opinions, the prebuilt LLM scorers return a number with no error and no
`notScorable`: toxicity **1** (worst, and ignores `scale`), faithfulness and answer-relevancy
**0** (worst), bias and hallucination **0** (best). #25039 (merged 2026-09-24) changed the
faithfulness/hallucination denominators but not this case. Mapping it to `notScorable` would hide
judge failures from the mean, so the fix makes it a scorer error.

**Fixed in `upstream/empty-judge-verdicts.patch`** (base `b2e9cd46`): bias, hallucination,
faithfulness and answer-relevancy throw when the judge returns no verdicts for items it extracted
(the same treatment Mastra already gives a structured-output validation failure); bias trims
verdicts. A new test (`scorers/llm/empty-verdicts.test.ts`, Mastra's own mock-judge pattern) passes
6/6 and fails 5/6 on the original scorers (the sixth is the nothing-extracted control). In the full
checkout, all 600 `@mastra/evals` tests pass (including the recorded-LLM scorer tests), `tsc
--noEmit` passes, Prettier is clean, and it has a changeset.

**Toxicity is left as an open question, not patched.** Its `return 1` on no verdicts dates from the
scorer's first version (`e473f27ed9`, July 2025) with no test covering it, and the docs say "0.0: No
toxic elements detected". But toxicity has no extraction step, so an empty verdict list can't tell
"nothing to judge" (a terse answer like "42") from "the judge failed". An earlier version of the
patch changed it to 0; the second review (gpt-6-astra) objected, and making it an error would break
every short answer, so it is raised for the maintainers instead.

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
- **Experiments on a local LibSQL file fail at Mastra's default concurrency.** `evidence/sqlite-busy.ts`:
  a 20-item experiment with `startExperiment` (default `maxConcurrency` 5) against
  `LibSQLStore({ url: 'file:…' })` failed in 4 of 5 trials with `SQLITE_BUSY` (extended code
  `SQLITE_BUSY_SNAPSHOT`) from `ExperimentsLibSQL.updateExperiment`; `maxConcurrency` 4 succeeded
  5 of 5 in an earlier run, 8 failed 5 of 5. Raising `connectionTimeoutMs` (the store's busy
  timeout) to 30 s did not help (5 of 5 failed), consistent with a WAL snapshot conflict, which a busy
  timeout cannot resolve (a read transaction that later writes). @mastra/core 1.74.0, @mastra/libsql
  1.25.0, mocked agent. The closest report, #4959 (2025, memory writes, closed), is a different
  code path. Not investigated further.

## The fix

Two patches for `@mastra/core` against `main` at `b2e9cd46` (2026-10-05), split so the maintainers
can take the bug fixes without the change in meaning:

**`upstream/compare-experiments-failed-runs.patch`**: bug fixes, no existing field changes meaning.
- Scores of failed target runs are left out of the stats. Each score is matched to its attempt with
  Mastra's own `experimentScoreId(experimentId, itemId, attempt, scorerId)`, so a retried item keeps
  only its successful attempts; a score with another id is matched to its item's only run.
- Repeated attempts are averaged per item instead of last-one-wins.
- A scorer with no scores in one experiment gets `missingIn: 'A' | 'B'`, `delta: 0`, never
  `regressed`; one missing in B sets `hasRegression` (before, true or false by direction).
- `failedItems: { a, b }` (items whose every attempt failed, the rule `finalizeExperiment` uses), a
  warning naming newly failed items, and an opt-in `maxFailedItemIncrease`.
- Deltas below 1e-9 relative to the scores' magnitude are treated as 0, so averaging noise can't
  trip the zero default.
- Tests: the unit test, plus `compare-experiments-failed-runs.test.ts`, which runs real experiments
  through Mastra's runner (`startExperiment`, and `runExperimentItem` with two attempts per item):
  11 tests pass, and all 11 fail on the original files. Note what this patch alone still does: an
  agent that crashes on its hardest items still shows a higher mean for a scorer that errors on
  failures (+0.18 in the unit test), with a warning and `failedItems`; the pairing below removes it.

**`upstream/compare-experiments-paired-delta.patch`** (on top of the first): **`delta` changes
meaning**, from the difference of each experiment's own mean to the mean change over items scored
in both experiments whose target run did not fail in either (new `pairedCount`). `statsA`/`statsB`
still describe each whole experiment, so `statsB.avgScore − statsA.avgScore` can differ from
`delta`; the type docs and changeset say so, and it is marked a minor change.

Both verified in a full checkout of `b2e9cd46`: they apply in sequence and give exactly the tested
files; all 466 (first) and 467 (both) tests in `packages/core/src/datasets` pass, including
Mastra's caller-driven experiment tests that call `compareExperiments`; `pnpm typecheck` passes;
Prettier is clean; each has a changeset. Two independent reviews shaped them: Claude Sonnet found 8
problems in the first version (including a type error in `buildEmptyResult`), and Codex gpt-6-astra
found that a failed attempt's score was still averaged after a successful retry and that the change
in `delta`'s meaning belonged in its own patch.

## The gate, and what it does not do

`src/` adds what a CI gate needs beyond the fix: a verdict of pass / fail / **insufficient**
(empty or unscored runs, unfinished experiments, scorer outages, skipped items and too few items
never pass), validated options, per-item failure rates with `'strict'` or `'statistical'`
reliability, a one-sided paired sign-flip test per scorer (Holm-adjusted), optional `clusters`, an
approximate minimum detectable effect, and the items behind the verdict. 0.2.0 exists because a
review of 0.1.0 (Codex gpt-6-astra, REVIEWS.md) found that empty experiments and NaN thresholds
passed; CHANGELOG.md lists what changed.

`PASS` means *no evidence of a regression at this sample size*, not that quality is fine.

Measured on the whole gate (`bench/gate-sim.ts`, `results/gate-sim.md`, 1000 trials per cell), FAIL
rate with nothing worse:

- Symmetric noise 5.5–5.9%; unequal repetitions 3.2–3.5%; three correlated scorers 2.5–2.8%.
- **Skewed changes** (a constant 0.1 against 0/1 at 10%, same mean): **12.1–12.2%**. The sign-flip
  test assumes symmetric changes under no regression, and this breaks it. **A mistake, caught in
  review:** 0.2.0 drafts added a "studentized" sign-flip test to fix this, and a simulation seemed
  to show it behaving differently. Codex gpt-6-astra pointed out that under sign flips the sum of
  squares is fixed, so the t-statistic is a monotonic function of the sum and the two tests give
  identical p-values; the simulation's differences came only from using different random seeds per
  test. The option was removed. No fix for skew is offered; averaging repeated attempts reduces it.
- **Correlated items** (5 clusters) undeclared: **12.0–20.0%**; declared through `clusters`: 2.4–3.7%.
- **Random target failures** at 5% in both runs: `'strict'` fails **64.7–92.6%** of comparisons, by
  design (any extra failure fails); `'statistical'` 5.8–6.6%. When failures really rise from 5% to
  20%, `'statistical'` catches 19.8–62.4% (20–50 items) and `'strict'` 98.4–100%.
- Power is set by sample size: a 0.1 drop in pass/fail scores is caught 8.9–19.0% of the time with
  20–50 items; a 0.1 drop in continuous scores 63.0–94.4%.

From the earlier test-level simulation (`bench/power.ts`):

- **No power gain from pairing in this simulation.** An unpaired rule given an oracle cut-off
  (taken from the simulated null, which users can't know) detects real drops slightly more often,
  e.g. pass/fail scores, 20 items, drop 0.2: 32.1% vs the gate's 25.8%. The gate's value is
  controlled false alarms without knowing the noise, plus correct handling of failures, coverage
  and missing scorers, not extra power.
- **The exact test is conservative on discrete scores** (0.9–3.5% false alarms with no change). An
  opt-in mid-p version recovers power (25.8% → 36.0% above) but reached 6.65% false alarms when the
  true drop equals the tolerance, so it is not the default.
