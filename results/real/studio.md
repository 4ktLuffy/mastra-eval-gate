# Studio field test (2026-10-05)

Project: fresh `npx create-mastra` (@mastra/core 1.74.0), run with `mastra dev`; Studio storage
`src/mastra/public/mastra.db`. Agent and judge model: Codex `gpt-5.6-luna` through bench/codex-model.ts
(agent effort low, judge effort low). Gate: mastra-eval-gate 0.3.1 (local build), `--storage`.

## Agent target, dataset "policy-questions-studio" (UI-made, 20 items)

| experiment | started from | change | policy-fact | tool-call-accuracy | answer-relevancy |
|---|---|---|---|---|---|
| 993bc251 studio-baseline | Studio Run | v1 | 20/20 | 20/20 | – |
| af926381 studio-baseline-2 | Studio Rerun | v1 | 20/20 | 20/20 | – |
| af2089be studio-candidate-v2 | Studio Rerun | v2 prompt | 20/20 | 20/20 | – |
| 95416813 agent-judge-1 | API | v1 | 20/20 | – | 0.869 (0.5–1.0) |
| c028d972 agent-judge-2 | API | v1 | 20/20 | – | 0.888 |

- Gate, 2 baselines vs v2: PASS, tokens ×1.19 (p = 0.28), run time ×0.97.
- `/api/datasets/:id/compare` on 993bc251 vs af2089be: response keys `baselineId`, `items` only.
- Judge noise: Mastra `compareExperiments` 95416813→c028d972 no regression; c028d972→95416813
  regression (0.888 → 0.869). Gate: PASS both ways; detects ≈ 0.059.

## Workflow target, dataset "support-workflow-questions" (20 items, input `{ question }`)

| experiment | workflow | dataset version | succeeded/failed | workflow-fact | answer-relevancy |
|---|---|---|---|---|---|
| 3e569aaf wf-baseline-1 | v1 answer | 1 | 20/0 | 1.00 | 0.00 (all 20) |
| b23571fc wf-candidate-review | v2 + human review | 1 | 18/2 (suspended) | 0.90 (suspend payloads scored 0) | 0.00 |
| ded7d316 wf-candidate-review-resumed | v2, items carry `resumeData` | 3 | 20/0 | 1.00 | 0.00 |

- Judge reason on every workflow item: "The score is 0 because both the input and output are empty".
- 3e569aaf→b23571fc: Mastra `hasRegression: true` (workflow-fact 1.00 → 0.90), no warnings. Gate:
  FAIL, 2 new failures, each with "Workflow suspended — provide resume data via item.resumeSteps/…".
- 3e569aaf→ded7d316: gate PASS with "Dataset versions differ (1 vs 3)" and the floor warning for
  answer-relevancy-scorer.
