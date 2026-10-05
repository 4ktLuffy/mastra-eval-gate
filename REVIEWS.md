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

## Review of the built tool (2026-10-05) — Codex gpt-6-astra, reasoning effort medium

Read-only review of the repository at `8695651` (Vitest could not run in its sandbox; it replayed
saved results and type-checked). Verdict: "a strong engineering prototype, but not yet a trustworthy
general-purpose CI gate"; as a Customer Engineer work sample, "yes". Findings, all checked against
the code before acting:

1. Fail-open: empty experiments, or experiments with no scores, pass; experiment status and dataset
   version are not checked (`src/compare.ts`, `src/load.ts`).
2. No option validation: a CLI threshold like `quality=..` becomes NaN and disables the check.
3. "A crashing agent can't pass" overstated: reliability and coverage were net, so fixes offset new
   breakage; "any attempt failed" penalises more repetitions.
4. The sign-flip test assumes symmetric differences; a skewed null (same mean) is rejected at
   p ≈ 0.001 in a 10-item example. Holm can't repair invalid p-values.
5. The 5% false-alarm claim covers the quality test only; the simulation called `signFlipPValue`,
   not the gate, with 1,000 resamples instead of 20,000.
6. MDE ignores Holm and the tolerance, uses observed variance, can report 0; "need at least 6 items"
   is wrong (5 items reach 1/32).
7. Real runs show behaviour, not calibration; reversed pairs are dependent; the coverage policy
   changed after seeing the data; the effort regression is an easy target.
8. The compare patch still averages a failed attempt's score after a successful retry; `delta`'s
   change in meaning needs maintainer agreement; the toxicity change needs a stronger argument.
9. PASS means "no evidence of regression", not "quality is fine".

Its ranked plan: close fail-open paths; validate the statistical contract on the whole gate; tighten
the upstream patch; one realistic benchmark with a modest seeded regression; package for customers.
All five are being done for 0.2.0.

## Review of the 0.2.0 drafts (2026-10-05) — Codex gpt-6-astra, reasoning effort medium

Ran the code this time (workspace-write sandbox, scratch files only; no tracked file changed).
Reproduced `bench/regate.ts` byte for byte and all 12 support-benchmark verdicts. Verdict: "substantially
better, but I still would not recommend this staged version as an unattended CI gate." Found, each
reproduced by me and fixed with a test (test/compare.test.ts "third review"):

1. test/mastra.test.ts did not load (a duplicated `const`); the suite reported 49 passed because my
   check read only the tests line. Now 65 tests across 6 files, and test files are type-checked.
2. Unscored baseline, all-null and all-NaN scores passed → `insufficient`.
3. Scorer ids `constructor`, `toString`, `__proto__` read inherited properties as thresholds and
   passed a total regression → own-property lookups.
4. Scorer outages on some attempts of an item read as improvements → coverage per successful attempt.
5. A cluster id could collide with the fallback id of an unclustered item → separate namespaces.
6. Scores of 1e308 overflowed the mean to Infinity and passed → `insufficient`.
7. `resamples: 1e100` hung → capped at 1e7; `seed` and cluster ids validated.
8. The studentized sign-flip test is identical to the plain one (fixed sum of squares makes t
   monotonic in the sum); the simulation's differences came from different seeds → option removed.
9. The support benchmark's scorer checked tool names only, and "moved real money" was false (the
   tool is simulated) → scorer checks order and amount; wording corrected; saved run not repeated.
10. README numbers were stale against the committed table → regenerated from the rerun.
Not changed, documented: skewed nulls (~12% false alarms), reversed real-run pairs being dependent.
