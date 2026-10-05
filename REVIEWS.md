# Plan reviews (2026-10-05)

Codex was out of credits, so both reviews were run by **Claude Sonnet** subagents (recorded per
the model rule).

| Review | Model | Context given |
|---|---|---|
| Blind | Claude Sonnet | PLAN.md v1 only + public sources |
| Context | Claude Sonnet | PLAN.md v1, pilot scripts/results, repros, Mastra repo, mission |

## Reproduced by the context reviewer
- A/A simulation: 49.7% "regressed" (plan said ~49%).
- Verbatim weather workflow: `status: success, activities: ""` in 4/4 fault rows.

## Accepted findings → changes in PLAN v2
1. **M1 is a strawman.** With tolerance 0, P(Δ<0)=0.5 for identical systems by symmetry. Dropped as a
   headline. Replaced by type-I error and power of old vs new method at thresholds users set.
2. **Better F1 defect.** `compare.ts` computes `overlappingItemIds` but only warns; per-scorer means
   are over different item sets, and `errorRate` never gates. Now the lead finding.
3. **Judge-noise calibration from `__recordings__` is infeasible.** 7 files, temperature 0, one response
   per request. Noise is now a swept, stated parameter; optional real repeated calls via Codex later.
4. **M3 null result.** 0 of 242 recorded verdict strings differ by case/space/punct. F3 demoted to a
   latent one-line consistency fix, reported as 0/242.
5. **F2 fix was wrong.** Empty verdicts → `notScorable` hides judge failures (survivor bias). Now:
   record as a scorer error. F2 narrowed to "empty verdicts while claims/opinions are non-empty";
   toxicity `return 1` (also ignores `scale`) is the clearest case. Re-verify per scorer after #25039.
6. **F6 is not a pattern.** 2 of ~25 template/example files (the same weather workflow, copied).
   One-line template fix; never claimed as a pattern. M5 dropped as a "rate".
7. **Fault-injection engine duplicates aimock / agent-chaos.** Cut. Use aimock or MockLanguageModel.
8. **Duplicated-side-effect check tests documented at-least-once semantics.** Cut as a pass/fail check.
9. **M7 circular** (we seeded the bugs). Replaced by validation of the statistics by simulation and a
   real-provider-shaped error fixture for F4.
10. **Owners:** evals/datasets CODEOWNERS are YujohnNattrass, DanielSLew, intojhanurag, wardpeet.
11. **Merge path:** Mastra auto-closes PRs without a triaged issue. Issues first (with Henos' yes).
12. **Statistics:** bounded scores, small N, ties, missing items, multiple scorers → paired
    permutation/sign-flip test, McNemar for binary, missing/errored as separate outcomes,
    tolerance-scaling opt-in, validated by simulation.

## Rejected findings
- Blind reviewer said F1 line cites were ~40 lines off. **Wrong**: `compare.ts:22` (DEFAULT_THRESHOLD)
  and `:158` (delta) are correct on main; the file has not changed since 927c2af979 (2026-02-12).
- Blind reviewer said the toxicity scorer path 404s. **Wrong path guessed** (`scorers/prebuilt/...`);
  the file is `packages/evals/src/scorers/llm/toxicity/index.ts`.
