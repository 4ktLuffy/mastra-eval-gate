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

## 2026-10-05 — real detection (model: Codex gpt-5.6-luna)
- bench/real-detect.ts (175 calls, 334,987 tokens): "answer without working" prompt did NOT lower
  accuracy (B1 0.567, B2 0.467, D 0.517) — negative result, nothing to detect. Mastra false-alarmed
  B1→B2. Gate failed every pair on judge coverage (Codex capacity errors) → coverage made net, test added.
  Saved files have question text for 20/30 items (listItems default page 20; fixed).
- bench/real-effort.ts (60 calls, 120,761 tokens): effort medium 30/30 vs none 13/30. Mastra and gate
  both flag; gate change −0.567, 95% CI [−0.733, −0.400], Holm p 5.0e-5.
- Wasted by my mistakes: ~60 calls (stray full B1 run) and 30 calls (effort run against
  partially-matchable saved runs).

## 2026-10-05 — tool mocks (bench/real-mocks.ts; Codex gpt-5.6-luna @ none; 387 calls, 557,468 tokens)
- Live (30% simulated 503s): flips 13/30, paired SD 0.533, N for 0.1 drop 176; Mastra 3/6, gate 0/6.
- toolMocks: flips 12/30, paired SD 0.512, N 162; Mastra 3/6, gate 1/6 (M2→M3 p=0.035, false alarm).
- Negative: mocks barely reduce noise; model variance dominates; agent retries hid the tool flakiness.
- All real no-change pairs: gate 1/20, Mastra 10/20.

## 2026-10-05 — 0.2.0 (after the gpt-6-astra review)
- Whole-gate simulation (bench/gate-sim.ts): symmetric 4.8–5.5%; skewed 10.9–11.1% (studentized did
  not fix: 11.6–13.2%, negative); clustered undeclared 12.6–22.5%, declared 3.2–4.2%; random 5%
  failures strict 63.9–90.0%, statistical 4.5–7.6%; failures 5%→20% statistical catches 23–68%,
  strict 99–100%.
- Saved real runs re-gated (bench/regate.ts): 20 clean no-change pairs → 17 pass, 1 fail (M2→M3),
  2 insufficient (B1↔B2 judge outage). Mastra 10/20 flagged.
- Support benchmark (bench/real-support.ts; Codex gpt-5.6-luna @ none; 377 calls, 480,386 tokens):
  baselines 29/30 ×3, rule-2-deleted 21/30 ×2. Mastra 0/6 no-change flagged, 6/6 regressed flagged;
  gate same (p ≈ 0.004). No separation: nearly deterministic agent, maximal regression. Baseline misses
  were claimed escalations without the tool call; regression issued forbidden refunds up to $881.

## 2026-10-05 — third review (gpt-6-astra on 0.2.0 drafts) and fixes
- Found: test/mastra.test.ts didn't load (duplicate const; my check grepped only the Tests line);
  unscored baseline / all-null / all-NaN passed; `constructor` scorer id disabled the threshold;
  attempt-level scorer outages read as improvements; cluster-id collision; overflow passed;
  unbounded resamples; studentized test identical to plain (my sim used different seeds per test);
  support scorer checked tool names only; "moved real money" false. All fixed or corrected; 65 tests.
- Whole-gate sim rerun (studentized removed): symmetric 5.5/5.9, skewed 12.2/12.1, clustered
  12.0/20.0 → declared 2.4/3.7, random-failures strict 64.7/92.6 → statistical 5.8/6.6.
- SQLITE_BUSY reproduced: default maxConcurrency 5 → 4/5 experiments fail (BUSY_SNAPSHOT in
  updateExperiment); 30 s busy timeout doesn't help.

## 2026-10-05 — 0.3.0: betting test, several runs, run time / tokens
- Betting (plug-in, cap 0.9): skewed null 0.0/2.5% vs sign-flip 12.2/12.1; 0.1 drop continuous
  3.1/61.6% vs 63.0/94.4; pass/fail 8.4/9.8 vs 8.9/19.0. Multi-run: betting 9.3→12.8→12.8, sign-flip
  8.8→24.5→34.2 (1/3/5 runs). aGRAPA mixture tried: no gain, dropped.
- Real re-gate: betting 0/20 clean no-change fails (removes M2→M3), catches timeouts, effort, support.
- Run time on real R runs: ×0.91, ×0.85 on identical configs (no false alarm). Token data from saved
  real runs unusable (adapter used TOKENS.at(-1) under concurrency); adapter fixed, smoke-tested.

## 2026-10-05 — fourth review fixes; betting in random order
- Betting with seeded random item order: skewed null 0.0/3.3%; drop 0.1 continuous 3.4/60.3, binary
  8.2/9.5; multi-run 8.3→12.1→12.6. Heterogeneous-order null (review case) 41.3% → 1.8%.
- Real re-gate: betting now 17 pass / 1 fail (M2→M3) / 2 insufficient on clean pairs — same as
  sign-flip. The earlier "betting removed the real false alarm" came from sorted order; withdrawn.

## 2026-10-05 — field test on a fresh create-mastra project (0.3.0 from npm)
- --mastra src/mastra/index.ts failed: DuckDB observability lock held by a running experiment →
  --storage added (0.5 s).
- Friendlier prompt: Mastra flagged −0.10/−0.10/−0.15 (3/3); gate pass (p 0.50, 0.50, 0.25),
  3-vs-3 pass p 0.251 and (new) named 2 consistently lower items → scorer rejected "7–14" and
  "can’t". Fixed scorer: all 7 runs 20/20. Mastra's flags were false alarms.
- No SQLITE_BUSY in 7 real-model runs at default concurrency.
