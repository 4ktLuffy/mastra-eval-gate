# mastra-eval-gate

**A CI gate for Mastra experiments that won't approve an agent just because it crashed.**

Mastra's `compareExperiments` answers "did my change make the agent worse?" by comparing average
scores. Run it on real Mastra experiments and an agent that crashes on its three hardest items
comes out *better* (0.72 → 0.90, no regression, no warning), because failed runs leave the average
and nothing counts them. This package compares the same stored experiments item by item, counts
failures as failures, refuses to pass when there is nothing to compare, and decides quality on a
test whose false-alarm rate is measured, including where it breaks.

```
$ npx tsx examples/crash-demo.ts
Mastra compareExperiments: hasRegression=false, quality 0.72 → 0.90 (delta +0.18), errorRate 0, warnings []
(the candidate failed 3 of 10 items)

FAIL  baseline <id>  →  candidate <id>
  ✗ 3 item(s) fail in the candidate that passed in the baseline; allowed 0 (0 fixed, which do not offset). …
  ! "quality": 3 item(s) scored in the baseline have no score in the candidate because the target failed; …

Items:
  new-failure <item id>  run failure rate: 0.00 → 1.00
  …
```

**What it found in Mastra** (details and intent labels in [FINDINGS.md](FINDINGS.md); every number
comes from a script in this repo):

- **Crashes raise scores.** Failed runs are still scored, with empty input and output. Three of
  Mastra's prebuilt code scorers (keyword-coverage, textual-difference, tone) give them a perfect
  1.0, and two drop them. `compareExperiments` then reports keyword coverage *improving* from 0
  to 0.3 because the agent crashed.
- **Different item sets, missing scorers, repeated trials.** A candidate that is better on every
  item it ran is flagged as a regression when it ran fewer items. A scorer missing from one run
  counts as a mean of 0. Only the last of several attempts is kept.
- **On a real model, half of all no-change comparisons are flagged.** Across 20 comparisons of a
  Codex-backed Mastra agent against itself, Mastra flagged 10; this gate failed 1, passed 17, and
  reported insufficient evidence on 2 (its judge had errored). With a realistic 20 s item timeout
  (7 of 30 items timed out), Mastra showed accuracy *improving* by 0.12 in two comparisons; the
  gate failed all four.
- **Beyond quality: run time and tokens.** The gate also catches "same answers, but slower" or
  "same answers, more tokens", which Mastra's comparison doesn't look at.
- **On a customer-style workload** (a support agent with refund and escalate tools; one policy
  rule deleted as the regression), both catch the regression (29/30 → 21/30, gate p ≈ 0.004) and
  neither false-alarms: that agent was nearly deterministic, so this run shows the gate isn't
  over-cautious, not that it beats Mastra. The regressed agent called the (simulated) refund tool
  for orders up to $881 that the policy says to escalate.

## Use it

```bash
npm install mastra-eval-gate
```

```ts
import { gate, formatReport } from 'mastra-eval-gate';

const result = await gate(mastra, {
  baseline: baselineExperimentId,
  candidate: candidateExperimentId,
  expectedScorers: ['faithfulness', 'toxicity'],
  thresholds: { faithfulness: { value: 0.05 }, toxicity: { value: 0.05, direction: 'lower-is-better' } },
});
console.log(formatReport(result));
if (result.verdict !== 'pass') process.exit(1);
```

From a shell or CI, against the module that exports your configured `mastra` (TypeScript is loaded
directly):

```bash
npx mastra-eval-gate --mastra src/mastra/index.ts --baseline <id> --candidate <id> --expect faithfulness --threshold faithfulness=0.05
```

Exit codes: 0 pass, 1 fail, 3 insufficient evidence, 2 usage error. Repeat `--baseline` and
`--candidate` to compare several runs of the same dataset (more runs, more power), and add
`--max-latency-increase 0.2` / `--max-token-increase 0.2` to gate on run time and tokens. `--json` prints the full
result. [`examples/ci/eval-gate.yml`](examples/ci/eval-gate.yml) is a GitHub Actions workflow to
copy, with [`examples/ci/run-candidate.ts`](examples/ci/run-candidate.ts).

In a Vitest test, next to Mastra's own `expectEvals`:

```ts
import { expectGate } from 'mastra-eval-gate/vitest';

test('no evidence the candidate is worse than the baseline', async () => {
  await expectGate(mastra, { baseline, candidate, thresholds: { accuracy: { value: 0.05 } } }).toPass();
});
```

A failed gate throws `GateFailedError` with the full report as its message. After
`registerGateMatchers()`, `expect(await gate(mastra, { baseline, candidate })).toPassEvalGate()` works too.

## What the verdict means

| Verdict | Means |
|---|---|
| `pass` | **No evidence of a regression** at this sample size. Not proof that quality is fine: the report's `detects` column says how large a drop the comparison could have missed. |
| `fail` | A quality regression (significant, beyond your tolerance), a reliability regression, or a scorer the candidate lost. |
| `insufficient` | No verdict is possible: no scorer with valid scores on shared items, an unfinished experiment, a scorer outage, items the candidate didn't run, scores that overflow, or too few paired items for the test to ever be significant. |

| Check | How |
|---|---|
| **Quality** per scorer | Mean change over items scored in both runs (repeated attempts averaged, scores of failed runs excluded and matched to their attempt), one-sided paired sign-flip test against your tolerance, Holm-adjusted across scorers; 95% bootstrap interval (descriptive) |
| **Reliability** | Per-item failure rate (target errors, timeouts). `'strict'` (default): fail when the gross increase exceeds `maxNewTargetFailures` (default 0); fixed items don't offset broken ones. `'statistical'`: also require the increase to be significant (exact McNemar). |
| **Missing scorer** | A scorer with scores in the baseline and none in the candidate fails; one in `expectedScorers` that never ran anywhere is insufficient. |
| **Run time, tokens** | Per item, over successful runs: geometric-mean ratio and a one-sided test on log ratios. Gated with `latency` / `tokens: { maxIncrease }`; otherwise reported, with a warning on a significant rise over 20%. |
| **Coverage** | Scores the candidate's scorer lost relative to the baseline, per successful attempt (error, skipped, non-finite), beyond `maxCoverageLoss`; or baseline items the candidate didn't run (`allowSubset` to accept): insufficient. |

Options: `thresholds`, `expectedScorers`, `alpha` (0.05), `test` (`'sign-flip'` | `'betting'`),
`scoreBounds`, `latency`, `tokens`, `reliability` (`'strict'` | `'statistical'`), `maxNewTargetFailures` (0), `maxCoverageLoss` (0),
`clusters` (item id → cluster id), `allowSubset`, `requireCompleted` (true), `seed`, `resamples`
(20000), `includeScoresOfFailedRuns`, `midP`, `itemDetail` (10). Invalid values throw.

## Where it breaks (measured)

The whole gate, simulated end to end in [`bench/gate-sim.ts`](bench/gate-sim.ts) (1000 trials per
cell, table in [results/gate-sim.md](results/gate-sim.md)). FAIL rate when nothing got worse:

| Situation | 20 items | 50 items | What to do |
|---|---|---|---|
| Symmetric noise (the test's assumption) | 5.5% | 5.9% | nothing |
| Unequal repetitions (1 vs 3 attempts, pass/fail) | 3.2% | 3.5% | nothing |
| Three correlated scorers (Holm) | 2.8% | 2.5% | nothing |
| **Skewed changes** (constant 0.1 vs 0/1 at 10%, same mean) | **12.2%** | **12.1%** | `test: 'betting'`: 0.0%, 3.3% |
| **Correlated items** (5 clusters), undeclared | **12.0%** | **20.0%** | pass `clusters`: 2.4%, 3.7% |
| **Random target failures, 5% in both runs**, `'strict'` | **64.7%** | **92.6%** | `reliability: 'statistical'`: 5.8%, 6.6% |

**Small datasets: run them more than once.** Pass several runs per side and items are averaged
across them. With 20 pass/fail items and a true 0.1 drop, 1 / 3 / 5 runs catch it 9% / 25% / 34% of
the time, false alarms 2.7–3.3%.

**The betting test** (`test: 'betting'`) makes no symmetry assumption, so it fixes the
skewed-scores row above. Like any item-level test it treats items as a sample of tasks; it takes
them in a seeded random order. It needs far more data: a 0.1 drop over 20 continuous items is
caught 3.4% of the time (sign-flip: 63.0%), 60.3% at 50 items (94.4%), and extra runs add little
(8.3% → 12.6% at 5 runs). On the real Codex runs it gives the same verdicts as sign-flip. Use it
when a scorer's changes are lopsided (rare large gains, many small losses), not as the default.

The price of `'statistical'`: when failures really rise from 5% to 20%, it catches 19.8% (20 items)
or 62.4% (50 items) of cases; `'strict'` catches 98.4–100%. Pick by whether a crash is a defect in your
product or background noise from your provider.

Power is limited by dataset size, not by the test: a 0.1 drop in pass/fail scores is caught 8.9–19.0%
of the time with 20–50 items (63.0–94.4% for continuous scores). From the earlier simulation ([results/power.md](results/power.md)), an
unpaired rule with an oracle cut-off was no less powerful than pairing here; the gate's value is
calibrated false alarms without knowing the noise, plus failure, coverage and missing-scorer
handling. Mastra's tool mocks did not reduce noise much in a real tool-using run (items needed for a
0.1 drop: 176 live, 162 mocked).

## The upstream fixes

Three patches against Mastra `main` (`b2e9cd46`, 2026-10-05), each verified in a full checkout with
Mastra's own tests, type check, Prettier, and a changeset:

- [`compare-experiments-failed-runs.patch`](upstream/compare-experiments-failed-runs.patch)
  (`@mastra/core`, bug fixes, no field changes meaning): scores of failed runs left out (matched to
  their attempt with Mastra's `experimentScoreId`), attempts averaged, `missingIn` for absent
  scorers, `failedItems` with a warning and an opt-in gate, a float-noise guard. Tests through the
  real experiment runner; 11 tests pass, fail 11/11 on the original; all 466 core dataset tests pass.
- [`compare-experiments-paired-delta.patch`](upstream/compare-experiments-paired-delta.patch)
  (on top of the first; changes what `delta` means, so it is separate for the maintainers to
  decide): `delta` over items scored in both runs. All 467 core dataset tests pass.
- [`empty-judge-verdicts.patch`](upstream/empty-judge-verdicts.patch) (`@mastra/evals`): bias,
  hallucination, faithfulness and answer-relevancy error when the judge returns no verdicts for
  extracted items, instead of scoring. Test passes 6/6, fails 5/6 on the original; all 600 evals
  tests pass. (Toxicity's "no verdicts → 1" is left as an open question: no verdicts can't tell
  "nothing toxic" from "the judge failed".)

To check them: clone `mastra-ai/mastra`, `git checkout b2e9cd46`, `git apply` the patch(es),
`pnpm install`, `pnpm turbo build --filter "@mastra/evals^..."`, then `pnpm vitest run` and
`pnpm typecheck` (core) or `pnpm check` (evals) in the package.

## Reproduce

```bash
npm install && npm run build
npm test                        # unit, real Mastra experiments, CLI over LibSQL
npx tsx bench/gate-sim.ts       # the whole gate, simulated → results/gate-sim.{json,md}
npx tsx bench/power.ts          # test-level simulation → results/power.{json,md}
npx tsx bench/regate.ts         # re-gate every saved real run, offline → results/real/regate.*
npx tsx examples/crash-demo.ts
cd evidence/phase0 && npm install && node g5_prebuilt.mjs   # each finding has a gN.mjs script
```

Real-model runs (Codex CLI signed in, no API key; every output is saved in `results/real/`, so
their verdicts can be recomputed without calling Codex again): `bench/real.ts` (no-change and
timeouts, ~300 calls), `bench/real-effort.ts` (a real regression, 60), `bench/real-mocks.ts` (tool
mocks, ~390), `bench/real-support.ts` (customer-style benchmark, ~375). They run through
`bench/codex-model.ts`, an AI SDK model adapter for the Codex CLI, with tool calling.
`evidence/pilot/` holds the fault-injection pilot that came first, including copies of three Mastra
templates (Apache-2.0, © Mastra).

## Layout

| Path | What |
|---|---|
| `src/compare.ts` | Verdict, quality/reliability/coverage checks over stored rows (pure) |
| `src/stats.ts` | Sign-flip (exact, Monte Carlo, mid-p), betting test, McNemar, Holm, bootstrap, minimum detectable effect |
| `src/load.ts`, `src/cli.ts`, `src/report.ts`, `src/vitest.ts` | Mastra loader, CLI, text report, Vitest helpers |
| `test/` | Unit tests, real-Mastra integration tests (Mastra's verdict vs the gate's), CLI end-to-end |
| `bench/` | Simulations, real-model runs, re-gating |
| `evidence/` | One script per finding, with raw outputs and negative controls |
| `FINDINGS.md`, `PLAN.md`, `REVIEWS.md`, `CHANGELOG.md` | Findings with intent labels; the plan and the reviews that changed it |

MIT licensed.
