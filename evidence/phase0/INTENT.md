# Intent check: failed target runs and prebuilt code scorers

Source: mastra-ai/mastra main @ 73aaaca04e0777f175f7274f5f98bc729cbc173a. Runs: `node g5_prebuilt.mjs`
(@mastra/core 1.74.0, @mastra/evals 1.10.5, mocked model, in-memory store).

## What happens
- The runner scores an item even when the target run failed. It skips scoring only on a preflight
  failure: `packages/core/src/datasets/experiment/index.ts:614-618` ("A preflight failure ... skips
  scoring because the target never ran under valid conditions"), then calls `runScorersForItem` with
  `execResult.output`, `execResult.scorerInput`, `execResult.scorerOutput` (:628-641).
  → Scoring failed runs is **intended** (not a fault): scorers are allowed to see failures.
- For a failed run the scorers see empty input and empty output:
  - `textual-difference` (`scorers/code/textual-difference/index.ts:10-11`): `input === output` → 1.0.
  - `keyword-coverage` (`scorers/code/keyword-coverage/index.ts:17-24`): no input and no output →
    empty keyword sets → score 1.
  - `tone`: empty message → stable sentiment → 1.
  - `completeness` / `content-similarity`: throw on undefined `run.input` / `run.output`
    (`completeness/index.ts:87-96`, `content-similarity/index.ts:20-21`) → scorer error → no score
    row persisted (`experiment/scorer.ts:238-239`).
- `compareExperiments` reads only score rows (`analytics/compare.ts:104`) and never the result rows'
  `error`, so `errorRate` stays 0 and nothing gates on the 3 failed items.

## Labels
| Behaviour | Label | Why |
|---|---|---|
| Runner scores failed target runs | not a fault | explicit comment; lets scorers penalise failure |
| Code scorers return 1.0 for empty input + empty output | simplification | sensible for identical strings in isolation; no failed-run path |
| completeness / content-similarity throw on missing input/output | simplification | defensive gap, error is caught and logged |
| compareExperiments ignores target errors (errorRate dead for runner output) | **unintended** | `errorRate` is documented as error items / total (`aggregate.ts:28`, `types.ts:16`) but the runner never persists null rows, so it can't be non-zero from a run |
| Net effect: crashes raise keyword-coverage 0 → 0.3 and drop items from other means, with no warning | **unintended** | no doc, test, or comment describes it |
