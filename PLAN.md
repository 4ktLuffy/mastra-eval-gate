# Mastra eval gate — plan v2 (after blind + context review)

Date 2026-10-05. v1 and the reviews that changed it: see REVIEWS.md. Working folder name stays
`mastra-faultline` until a package name is chosen.

## Goal (unchanged)

Fix a verified gap in Mastra's own open-source work, build a better tool on top of the fix,
prove both with measurements on Mastra's own material, email the right engineer. Target role:
Mastra Customer Engineer (fully remote): "reliability, eval strategies, monitoring", "turn
recurring customer challenges into OSS improvements".

## The story (one, not four)

**Mastra's experiment comparison can't be trusted as a CI gate, and agent failures make it worse.**
`compareExperiments` is what a Mastra user runs to ask "did my change make the agent worse?".
It compares unpaired means over different item sets, never gates on errors, drops repeated
trials, and treats a missing scorer as a score of 0. The automation angle: when the agent
crashes, times out, or its judge fails, those items fall out of the average, so a less
reliable agent can look better.

## Findings to verify first (Phase 0, code on main, file:line@SHA)

Read on main today (`compare.ts` unchanged since 927c2af979, 2026-02-12):
- G1 Unpaired: per-scorer stats use every score in each run (`compare.ts` step 10); the
  overlap set (step 7) only feeds a warning.
- G2 Errors don't gate: `avgScore` excludes null scores (`aggregate.ts` computeScorerStats);
  `hasRegression` looks only at the mean delta.
- G3 Missing scorer → mean 0: a scorer absent from one run gives `avgScore: 0` there
  (`computeMean([]) = 0`), so a large false regression, or a false improvement for
  lower-is-better.
- G4 Repeated trials overwritten: `groupScoresByScorerAndItem` keeps only the last score per
  (scorer, item). To verify: whether experiments can store more than one score per item
  (`attempt` / repeated runs).
- G5 **Hypothesis, headline if true:** a target run that errors or times out stores no score row
  at all, so `errorRate` stays 0 and the item silently leaves the mean. Test: run a real
  experiment (in-memory/libsql storage, mocked model) where the agent throws on the hardest items.
- G6 Judge failure: scorers that get an empty verdict list while claims/opinions are non-empty
  (toxicity returns 1 and ignores `scale`) → should be a scorer error, not a score.
  Re-verify per scorer after #25039.
Each one gets an intent check (comments, tests, docs, changelog) before it is called a fault.

## D1 — The fix (upstream-ready, in a local Mastra checkout, with tests)

`compareExperiments`, backward-compatible (all existing fields unchanged; new fields added;
new behaviour opt-in where it changes a verdict):
- paired comparison over items scored in both runs; `pairedN`, `onlyInA`, `onlyInB` reported;
- per-scorer `errorRate` for both runs, including target-run failures (if G5 holds), and an
  opt-in `maxErrorRateIncrease` gate;
- a scorer missing from one run → `status: 'missing'`, never a 0 mean;
- repeated trials (if G4 holds) aggregated per item, not overwritten;
- optional uncertainty: paired sign-flip/permutation test for continuous scores, McNemar exact
  for binary pass/fail; reported as interval + p, gate opt-in.
Plus G6 in the scorers: empty verdicts with non-empty inputs → scorer error.

## D2 — The better tool: a trustworthy eval gate for Mastra CI

A small package (name TBD) on top of the D1 logic, usable today without waiting for upstream:
- `gate(mastra, { baseline, candidate, thresholds })` reads two experiments from Mastra
  storage and returns pass/fail with reasons: regression beyond tolerance (with interval),
  reliability drop (error/timeout rate up), coverage drop (fewer items scored), missing scorer.
- **Sample-size advice:** "with your judge's noise and N items, the smallest regression this
  gate can see is X" (power), so users know whether their dataset is big enough.
- **Variance from replay:** measure how much Mastra's own `toolMocks` (static tool outputs)
  shrink run-to-run variance, and therefore the N the gate needs. This ties the gate to a
  feature Mastra just shipped.
- Vitest helper alongside `@mastra/evals/vitest`; a CLI for CI (`npx <name> gate A B`).
Competitor check before claiming novelty: LangSmith, Braintrust, Langfuse, Phoenix experiment
comparison (paired? error-aware? power?) from their own docs.

## D3 — Findings page
Negative results first (pilot: core timeouts, thrown-error fallback, retries, suspend/resume all
correct). Then G1–G6 with evidence, intent label, fix. Side findings with their status: F4
fallback (#21280, filed), F5 tool barrier (#21902, filed), weather template silent success
(2 files, one-line fix), bias trim (latent, 0/242 observed), closed-but-not-fixed #19887 and
#18594.

## D4 — Email (after Henos' yes; ideally after an issue exists)
One evals/datasets CODEOWNER (YujohnNattrass, DanielSLew, intojhanurag or wardpeet), with the
issue link and two numbers. Henos decides recipient and whether to file the issue first.

## Measurements

| M | What | How |
|---|---|---|
| M1 | Type-I error and power, old vs new comparison, at tolerances 0, 0.05, 0.1; N ∈ {10, 20, 50}; judge noise swept (binary, 3-level, continuous bounded) | simulation, seeded, script stored |
| M2 | Headline (if G5 holds): a crashier agent vs a correct one, old vs new verdict | real Mastra experiments with mocked models, on a Mastra example dataset/agent |
| M3 | Missing-scorer and unpaired-set false verdicts | constructed experiments on real storage |
| M4 | Variance reduction from `toolMocks` and the N it saves | repeated runs, mocked model with sampling noise; real judge via Codex only if credits allow (record model) |
| M5 | G6: false pass/fail from empty verdicts with non-empty claims, per scorer | scorer runs with fixtures; ground truth = the fixture |
| M6 | F4 confirmed with a provider-shaped SSE error (not just a mock chunk) | aimock or a recorded SSE fixture |
Every number has its script on disk and a negative control.

## Build order
1. Phase 0: verify G1–G6 on main (G5 first). Stop and report if G5 is false; the story then
   leads with G1–G3 instead.
2. D1 patch + tests in a local Mastra checkout (no fork push, no PR).
3. M1–M3 simulations and experiments.
4. D2 gate package, then M4.
5. D3 findings page, D4 draft email.
Every diff shown to Henos before any commit; push and any public action need a separate yes.

## Cut from v1 (see REVIEWS.md)
Fault-model/fault-tool engine (duplicates aimock/agent-chaos), duplicated-side-effect pass/fail
check (tests documented semantics), static lint (2 files of yield), the 49% headline, "calibrated
on __recordings__", seeded-bug detector validation.
