# Phase 0 evidence (G1-G6)
Versions: @mastra/core 1.74.0, @mastra/evals 1.10.5, @mastra/libsql 1.25.0 (unused: core InMemoryStore), ai ^5. Source read at mastra-ai/mastra main 73aaaca04e0777f175f7274f5f98bc729cbc173a (2026-10-05).
Setup: `npm i` then `node gN.mjs > results/gN.txt`. No network model calls; MockLanguageModelV2 only. lib.mjs holds mocks.
- g5.mjs  G5: agent B throws/times out on q8-q10; compareExperiments(A,B). Includes negative control (B == A).
- g1.mjs  G1: B runs only q8-q10 (each +0.05 vs A) -> regression flagged on unpaired means. Neg control: full set.
- g2.mjs  G2: scorer throws on q8-q10 -> no score row; null row injected directly to show errorRate is ignored by hasRegression.
- g3.mjs  G3: scorer missing from one run -> mean 0 (both directions, plus neg control).
- g4.mjs  G4: runExperimentItem attempt=0..2 -> 12 score rows; compare keeps last. Neg control: single attempt.
- g6.mjs  G6: five LLM scorers with mock judge returning empty verdicts after non-empty extraction. Neg control with real verdicts.
