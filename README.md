# mastra-eval-gate

**Tells you whether a change made your Mastra agent worse, before you ship it.**

You run your agent on a test set before and after a change (Mastra calls these experiments). Mastra
can compare the two, but I found that comparison is easy to fool: it can say an agent that
**crashed** got *better*, and it raises false alarms on changes that did nothing. This package
reads the same experiments and gives one honest answer:

- **PASS**: no sign it got worse.
- **FAIL**: it got worse, and here is what broke.
- **INSUFFICIENT**: there isn't enough to tell, so it won't pretend to pass.

```
$ npx mastra-eval-gate --storage file:./src/mastra/public/mastra.db --baseline 3e569aaf… --candidate b23571fc…

FAIL  baseline 3e569aaf…  →  candidate b23571fc…
  ✗ 2 item(s) fail in the candidate that passed in the baseline; allowed 0 …

Items:
  new-failure     45a4ab72…  run failure rate: 0.00 → 1.00
                  error: Workflow suspended — provide resume data via item.resumeSteps/item.resumeData …
  new-failure     f573ac9f…  run failure rate: 0.00 → 1.00
                  error: Workflow suspended — provide resume data via item.resumeSteps/item.resumeData …
```

(A real run from Mastra Studio: a new human-review step paused two questions. Mastra's own comparison
reported it as a score regression, 1.00 → 0.90, as if the answers were wrong.)

## Why I built it

I spent time using Mastra's experiments the way a team would, with a real model (OpenAI's Codex),
on a fresh `create-mastra` project and in Mastra Studio. What I saw:

- **A crash can look like an improvement.** When the agent crashes on a question, Mastra still
  scores the empty answer, and some of its own scorers give that a perfect 1.0. An agent that
  crashed on its 3 hardest questions out of 10 went *up* from 0.72 to 0.90, with no warning.
- **Timeouts too.** With 7 of 30 questions timing out, Mastra showed accuracy going *up* by 0.12.
- **Lots of false alarms.** I compared the same agent with itself 20 times. Mastra said "regression"
  10 times. This gate failed 1.
- **It finds the real cause.** On a fresh project, Mastra flagged a prompt change as worse three
  times. The gate passed it and pointed at the 2 questions that changed. The agent was right; my
  answer check was rejecting "7–14" and "can’t".
- **Studio hides its own verdict.** Studio's compare works out whether anything regressed, then
  throws that answer away before showing you the results.
- **A built-in judge scores workflows 0.** Mastra's answer-relevancy judge can't read a workflow's
  output, so it gave 20 correct answers a 0 each, without any error. The gate now warns about this.
- **Paused workflows are treated as wrong answers.** A human-review step that paused 2 questions
  showed up in Mastra as "answers got worse, 1.00 → 0.90". The gate reports them as paused, with
  Mastra's own message.

Every number comes from a script in this repo. The details are in [FINDINGS.md](FINDINGS.md), and
I wrote fixes for Mastra itself too ([below](#the-upstream-fixes)).

## What it checks

- **Quality**: did a score really drop, or is it just the normal wobble between runs?
- **Crashes and timeouts**: counted as failures, never as good answers.
- **Speed and tokens**: same answers but slower, or more tokens, gets flagged.
- **Questions that keep failing**: with a few runs per side, it names the questions that got worse
  in every run.
- **Broken setups**: a scorer stuck at 0 on everything, a scorer missing from one run, or a test set
  that changed between the two runs.

## Use it

```bash
npm install mastra-eval-gate
```

From a terminal or CI, straight from your project's database (it doesn't load your app, so it's
fast and works while Studio is running):

```bash
npx mastra-eval-gate --storage file:./mastra.db --baseline <id> --candidate <id>
```

Studio keeps its database at `src/mastra/public/mastra.db`. Exit codes: 0 pass, 1 fail, 3 not
enough evidence, 2 usage error. Repeat `--baseline` and `--candidate` to compare several runs (more
runs, smaller drops caught). Add `--max-latency-increase 0.2` or `--max-token-increase 0.2` to fail
on 20% slower or 20% more tokens, and `--json` for the full result.
[`examples/ci/eval-gate.yml`](examples/ci/eval-gate.yml) is a GitHub Actions workflow you can copy.

In code:

```ts
import { gate, formatReport } from 'mastra-eval-gate';

const result = await gate(mastra, {
  baseline: baselineExperimentId,
  candidate: candidateExperimentId,
  thresholds: { faithfulness: { value: 0.05 } }, // allow a drop of up to 0.05
});
console.log(formatReport(result));
if (result.verdict !== 'pass') process.exit(1);
```

In a Vitest test:

```ts
import { expectGate } from 'mastra-eval-gate/vitest';

test('the new version is not worse', async () => {
  await expectGate(mastra, { baseline, candidate }).toPass();
});
```

## What it can't do

- **A drop on just 1–2 questions can't be proven** with 20 questions. Instead, it names those
  questions so you can look at them.
- **Small test sets miss small drops.** With 20 pass/fail questions, a 10% drop is caught about 1 time in
  10 from one run each, and 1 in 3 with five runs each. The report tells you the smallest drop it
  could have caught.
- **I tested it with one model** (Codex) on test sets of 20–30 questions.

## The details

Everything below is for people who want to check the statistics or the numbers.

| Verdict | Means |
|---|---|
| `pass` | **No evidence of a regression** at this sample size. Not proof that quality is fine: the report's `detects` column says how large a drop the comparison could have missed. |
| `fail` | A quality regression (significant, beyond your tolerance), more failures, or a scorer the candidate lost. |
| `insufficient` | No verdict is possible: nothing scored on shared items, an unfinished experiment, a scorer outage, items the candidate didn't run, or too few items for the test to ever be significant. |

| Check | How |
|---|---|
| **Quality** per scorer | Mean change over items scored in both runs (repeated attempts averaged, scores of failed runs excluded), one-sided paired sign-flip test against your tolerance, Holm-adjusted across scorers; 95% bootstrap interval |
| **Reliability** | Per-item failure rate. `'strict'` (default): fail on any extra failures beyond `maxNewTargetFailures` (default 0). `'statistical'`: also require the increase to be significant (exact McNemar). |
| **Missing scorer** | A scorer with scores in the baseline and none in the candidate fails. |
| **Run time, tokens** | Per item: geometric-mean ratio and a one-sided test on log ratios. Gated with `latency` / `tokens: { maxIncrease }`; otherwise reported, with a warning on a significant rise over 20%. |
| **Coverage** | Scores the candidate lost (scorer error, skipped) beyond `maxCoverageLoss`, or items it didn't run (`allowSubset` to accept): insufficient. |

Options: `thresholds`, `expectedScorers`, `alpha` (0.05), `test` (`'sign-flip'` | `'betting'`),
`scoreBounds`, `latency`, `tokens`, `reliability` (`'strict'` | `'statistical'`), `maxNewTargetFailures` (0), `maxCoverageLoss` (0),
`clusters` (item id → cluster id), `allowSubset`, `requireCompleted` (true), `seed`, `resamples`
(20000), `includeScoresOfFailedRuns`, `midP`, `itemDetail` (10). Invalid values throw. The CLI also
takes `--mastra src/mastra/index.ts` to load your configured app instead of `--storage`.

### Where it breaks (measured)

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

**A regression on a few items can't be significant.** If only 2–3 of 20 items change, no
item-level test can reach p < 0.05 (3 items: p ≥ 1/8). With several runs per side the gate names
items that are lower in every candidate run than in every baseline run, so they get reviewed even
when the verdict is PASS.

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
