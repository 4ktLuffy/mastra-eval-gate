# mastra-eval-gate

**A CI gate for Mastra experiments that a crashing agent can't pass.**

Mastra's `compareExperiments` answers "did my change make the agent worse?" by comparing average
scores. Run it on real Mastra experiments and an agent that crashes on its three hardest items
comes out *better* (0.72 → 0.90, no regression, no warning), because failed runs leave the average
and nothing counts them. This package compares the same stored experiments item by item, counts
failures as failures, and decides on a test with a known false-alarm rate.

```
$ npx tsx examples/crash-demo.ts
Mastra compareExperiments: hasRegression=false, quality 0.72 → 0.90 (delta +0.18), errorRate 0, warnings []
(the candidate failed 3 of 10 items)

FAIL  baseline <experiment id>  →  candidate <experiment id>
  ✗ 3 item(s) fail in the candidate that passed in the baseline (0 fixed); allowed net 0.
  ! "quality": 3 item(s) scored in the baseline have no score in the candidate because the target failed; …
```

**What it found in Mastra** (details and intent labels in [FINDINGS.md](FINDINGS.md); every number
comes from a script in this repo, run on `@mastra/core` 1.74.0):

- **Crashes raise scores.** Failed runs are still scored, with empty input and output. Three of
  Mastra's prebuilt code scorers (keyword-coverage, textual-difference, tone) give them a perfect
  1.0, and two drop them. `compareExperiments` then reports keyword coverage *improving* from 0
  to 0.3 because the agent crashed.
- **Different item sets, missing scorers, repeated trials.** A candidate that is better on every
  item it ran is flagged as a regression when it ran fewer items. A scorer missing from one run
  counts as a mean of 0. Only the last of several attempts is kept.
- **The default flags half of all no-change comparisons.** With zero tolerance, 38.6–51.7% of
  simulated comparisons between two runs of the *same* system are flagged; this gate flags
  0.9–5.2% (at most 5.7% when the true drop equals a non-zero tolerance).
- **On a real model too.** A Mastra agent and judge on Codex, 30 problems, the same configuration
  run three times: Mastra flagged 3 of 6 comparisons, the gate none. With a 20 s item timeout
  (7 of 30 items timed out), Mastra reported no regression in 2 of 4 comparisons and showed
  accuracy *improving* by 0.12; the gate failed all 4. On a real regression (reasoning effort
  lowered from medium to none: 30/30 → 13/30 correct) both flag it; the gate with
  p = 5e-5 and a 95% interval for the drop. Over all 20 real no-change comparisons, the gate
  failed 1 (5%) and Mastra flagged 10 (50%).

## Use it

```ts
import { gate, formatReport } from 'mastra-eval-gate';

const result = await gate(mastra, {
  baseline: baselineExperimentId,
  candidate: candidateExperimentId,
  thresholds: { faithfulness: { value: 0.05 }, toxicity: { value: 0.05, direction: 'lower-is-better' } },
});
console.log(formatReport(result));
if (!result.passed) process.exit(1);
```

Or in CI, against a module that exports your configured `mastra`:

```bash
npx tsx node_modules/.bin/mastra-eval-gate --mastra src/mastra/index.ts --baseline <id> --candidate <id> --threshold faithfulness=0.05
```

It exits 1 on a failed gate, with one line per reason. `--json` prints the full result.

Or in a Vitest test, next to Mastra's own `expectEvals`:

```ts
import { expectGate } from 'mastra-eval-gate/vitest';

test('candidate is not worse than the baseline', async () => {
  await expectGate(mastra, { baseline, candidate, thresholds: { accuracy: { value: 0.05 } } }).toPass();
});
```

A failed gate throws `GateFailedError` with the full report as its message. After
`registerGateMatchers()`, `expect(await gate(mastra, { baseline, candidate })).toPassEvalGate()` works too.

## What it checks

The gate fails, with a reason, on any of:

| Check | How |
|---|---|
| **Quality regression** per scorer | Change over items scored in both runs (repeated attempts averaged per item), one-sided paired sign-flip test against your tolerance, Holm-adjusted across scorers, 95% bootstrap interval |
| **Reliability** | Items that newly fail in the candidate (target errors and timeouts) beyond `maxNewTargetFailures` (default 0); exact McNemar p reported |
| **Coverage** | Items the baseline scored that the candidate's scorer silently didn't (scorer error, skipped, or a non-finite score); baseline items the candidate never ran (`allowSubset` to accept); no shared items at all |
| **Missing scorer** | A scorer that ran in the baseline but not the candidate |

Scores that scorers produce for failed runs are excluded from quality (`includeScoresOfFailedRuns`
to keep them) and counted under reliability instead; each score is matched to its own attempt
(Mastra encodes it in caller-driven score ids), so a crashed attempt's score is dropped even when a
retry of the item succeeded. A drop beyond tolerance that is within noise is reported as
inconclusive, with the smallest drop the dataset could have detected, and with fewer than 6 paired
items the gate says plainly that the test can never reach p < 0.05.

## What it does not do (measured)

From `bench/power.ts` (2000 simulated comparisons per cell, table in
[results/power.md](results/power.md)):

- **Pairing gave no extra power here.** An unpaired rule given an oracle cut-off detects real
  drops slightly more often (pass/fail scores, 20 items, drop 0.2: 32.1% vs 25.8%). That cut-off
  needs the true noise model, which a user doesn't have; the gate gets 5% false alarms without it.
- **Small pass/fail datasets can't see small drops.** With 20 items, no calibrated rule here
  detects a 0.2 drop more than ~36% of the time. The gate warns when a non-zero tolerance is
  below what the dataset can detect, and when there are too few items to detect anything.
- The exact test is conservative on discrete scores (0.9–3.5% false alarms with no change).
- **Mastra's tool mocks did not shrink the noise much** in the real tool-using run (items needed to
  detect a 0.1 drop: 176 live, 162 mocked); the model's own run-to-run variance dominated. `midP: true` recovers
  power but reached 6.65% false alarms at the tolerance boundary, so it is opt-in.

## The upstream fix

[`upstream/compare-experiments.patch`](upstream/compare-experiments.patch) is a small fix to
Mastra's own `compareExperiments` (base `73aaaca04e`): deltas over items scored in both runs and
not failed in either, `missingIn` for absent scorers (and `hasRegression` when the candidate lost
one), averaged attempts, a `failedItems` count with an opt-in gate on newly failed items, and a
relative float-noise guard. `delta` changes meaning (see [FINDINGS.md](FINDINGS.md#the-fix)). Its
test passes 10/10 on the patch and fails 10/10 on the original. It has not been run inside the
full Mastra monorepo.

## Reproduce

```bash
npm install
npm run build                 # the CLI test runs dist/cli.js
npm test                      # 45 tests: unit, real Mastra experiments, CLI over LibSQL
npx tsx bench/power.ts        # M1 simulation → results/power.{json,md}
npx tsx bench/real.ts         # real run on Codex (~300 calls; needs the Codex CLI signed in)
npx tsx bench/real-effort.ts  # real regression: effort medium vs none (60 calls)
npx tsx bench/real-mocks.ts   # live tool vs Mastra toolMocks, 3 runs each (~390 calls)
npx tsx examples/crash-demo.ts
cd evidence/phase0 && npm install && node g5_prebuilt.mjs   # each finding has a gN.mjs script
```

Apart from `bench/real.ts`, no API keys and no network calls: models are scripted mocks
(`ai/test`), so every run is deterministic. `bench/real.ts` calls the Codex CLI (no API key) through
`bench/codex-model.ts`, an AI SDK model adapter, and saves every output so its verdicts can be
recomputed without calling it again. `evidence/pilot/` holds the fault-injection pilot that came first, including copies
of three Mastra templates (Apache-2.0, © Mastra) used to test them under faults.

## Layout

| Path | What |
|---|---|
| `src/compare.ts` | Paired, error-aware comparison over stored rows (pure) |
| `src/stats.ts` | Sign-flip, McNemar, Holm, bootstrap, minimum detectable effect |
| `src/load.ts`, `src/cli.ts`, `src/report.ts` | Mastra storage loader, CLI, text report |
| `test/` | Unit tests, real-Mastra integration tests (old verdict vs gate), CLI end-to-end |
| `bench/power.ts` | False-alarm and power simulation |
| `evidence/` | One script per finding, with raw outputs and negative controls |
| `FINDINGS.md`, `PLAN.md`, `REVIEWS.md` | Findings with intent labels; the plan and the reviews that changed it |

MIT licensed.
