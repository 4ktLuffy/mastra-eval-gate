# Running results log

## 2026-10-05 — M1 power simulation (`npx tsx bench/power.ts`, full table in results/power.md)

2000 trials per cell, alpha 0.05, seeded.

- False alarms with no real change, tolerance 0: old rule 38.6–51.7%, gate 0.9–5.2% (all models, n 10/20/50).
- At tolerance 0.05 the old rule still false-alarms up to 40.3% (binary, n=10) when nothing changed.
- **Negative result:** an unpaired rule calibrated to 5% false alarms (cut-off taken from the simulated
  null, so it needs the true noise model, which users don't have) detects real drops slightly more
  often than the gate's paired sign-flip test, e.g. binary n=20 drop 0.2: 32.1% vs 25.8%;
  continuous σ=0.2 n=20 drop 0.1: 49.3% vs 45.0%. Pairing gave no power gain in this model.
- **Negative result:** the sign-flip test is conservative on discrete scores (false alarms 2.2–3.5%
  for binary and 3-level at n=20/50, vs nominal 5%), costing power. Candidate fix: mid-p. Not yet
  measured.
- Honest framing: the gate's value is calibrated false alarms without knowing the noise model, plus
  correct handling of failures, coverage and missing scorers. Small binary datasets cannot detect
  small drops with any calibrated rule (binary n=20: ≤ 32% detection of a 0.2 drop).

## Integration tests (`npx vitest run`, 28 passing at the time; 41 after the review fixes)
Real Mastra experiments (@mastra/core 1.74.0, @mastra/evals 1.10.5, in-memory store, mocked model):
old `compareExperiments` verdict vs the gate on G1, G3, G4, G5 (+ prebuilt scorers) and a negative
control. Each test asserts both the old (wrong) and the new verdict.

## 2026-10-05 — mid-p variant (same simulation, column "gate (mid-p)")
- With no real change (tolerance 0): mid-p false alarms ≤ 5.1% (all cells).
- At the tolerance boundary (true drop = tolerance): mid-p up to **6.65%** (3-level, n=10, tol 0.1),
  ~3 MC s.e. above 5%; exact test up to 5.7%. Old rule up to 51.8%.
- Power gain on discrete scores is large: binary n=20 drop 0.2 25.8% → 36.0%; 3-level n=10 drop 0.2
  28.5% → 43.7%. Versus the oracle-calibrated unpaired rule: above it for binary n=20 (36.0% vs
  32.1%), still below it for 3-level n=10 (43.7% vs 54.5%).
- Decision: exact test stays the default; mid-p is opt-in (`midP: true`), with the 6.65% worst case
  documented on the option.

## Side finding (not investigated) — LibSQL file store + concurrent experiment items
`startExperiment` with default concurrency against `LibSQLStore({ url: 'file:...' })`
(@mastra/libsql 1.25.0, @mastra/core 1.74.0) failed with `SQLITE_BUSY_SNAPSHOT` ("database is
locked") in `ExperimentsLibSQL.updateExperiment`. `maxConcurrency: 1` avoids it. Seen once in
test/cli.test.ts; not yet reproduced in isolation or checked against open issues.

## 2026-10-05 — independent review (Claude Sonnet; Codex out of credits)
Reproduced every headline number exactly from a clean copy (power.md byte-identical). Found 7 gate
bugs (failed-attempt scores kept when a retry succeeded, disjoint item sets pass, subset passes, NaN
fail-open, all-null baseline scorer silent, n<6 can never fail with a "detectable ~0" message,
float noise at the tolerance boundary) and 8 patch problems (type error in buildEmptyResult,
crashed-but-scored items still paired, all-null scorer not missing, counts-not-items gate, absolute
epsilon, delta/stats inconsistency, missing scorer never gates, mixed null attempts). All fixed,
each with a test (test/compare.test.ts "review fixes", test/load.test.ts, test/mastra.test.ts
"review bug 1", and the upstream test file).

## 2026-10-05 — real-model run (`npx tsx bench/real.ts`; model: Codex gpt-5.6-luna @ effort none, agent and judge)
300 Codex calls, 739,563 tokens, median call 14.0 s. Full table in FINDINGS.md "On a real model".
- Clean no-change pairs (R1–R3): Mastra flagged 3/6, gate 0/6.
- R5 (itemTimeout 20 s, 7/30 timed out) vs R1–R4: Mastra flagged 2/4 and showed exact accuracy
  +0.122/+0.129 in the two it missed; gate failed 4/4.
- R4: 2 Codex calls hung > 300 s and were killed by the adapter's own cap (not Mastra's).
- Judge scored timed-out (empty) replies 0; exact scorer threw and stored nothing.
- No real quality regression was present, so no real detection result.
