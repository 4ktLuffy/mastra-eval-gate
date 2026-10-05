# The whole gate, simulated

1000 trials per cell, alpha 0.05, default options (`allowSubset` on). "fail" = gate verdict FAIL; "quality fail" = a regression reason (the statistical test); "insufficient" = no verdict.
With drop 0 every FAIL is a false alarm. MC s.e. ≤ 1.6 pts.

| scenario | n | true drop | FAIL | quality FAIL | INSUFFICIENT | PASS |
|---|---|---|---|---|---|---|
| symmetric null, continuous | 20 | 0 | 5.5% | 5.5% | 0.0% | 94.5% |
| skewed null (0.1 vs 0/1 at 10%) | 20 | 0 | 12.2% | 12.2% | 0.0% | 87.8% |
| clustered null (5 clusters) | 20 | 0 | 12.0% | 12.0% | 0.0% | 88.0% |
| clustered null, clusters declared | 20 | 0 | 2.4% | 2.4% | 0.0% | 97.6% |
| unequal repetitions null (1 vs 3, binary) | 20 | 0 | 3.2% | 3.2% | 0.0% | 96.8% |
| three scorers null (correlated) | 20 | 0 | 2.8% | 2.8% | 0.0% | 97.2% |
| random failures null (5% both runs) | 20 | 0 | 64.7% | 5.6% | 0.0% | 35.3% |
| random failures null, budget 2 | 20 | 0 | 12.2% | 4.5% | 0.0% | 87.8% |
| random failures null, reliability 'statistical' | 20 | 0 | 5.8% | 5.6% | 0.0% | 94.2% |
| failures rise 5% -> 20%, reliability 'strict' | 20 | 0.15 | 98.4% | 5.2% | 0.0% | 1.6% |
| failures rise 5% -> 20%, reliability 'statistical' | 20 | 0.15 | 19.8% | 4.7% | 0.0% | 80.2% |
| drop 0.05, continuous | 20 | 0.05 | 26.6% | 26.6% | 0.0% | 73.4% |
| drop 0.05, binary | 20 | 0.05 | 4.5% | 4.5% | 0.0% | 95.5% |
| drop 0.1, continuous | 20 | 0.1 | 63.0% | 63.0% | 0.0% | 37.0% |
| drop 0.1, binary | 20 | 0.1 | 8.9% | 8.9% | 0.0% | 91.1% |
| skewed drop 0.05 (0.1 vs 0/1 at 5%) | 20 | 0.05 | 35.5% | 35.5% | 0.0% | 64.5% |
| symmetric null, continuous | 50 | 0 | 5.9% | 5.9% | 0.0% | 94.1% |
| skewed null (0.1 vs 0/1 at 10%) | 50 | 0 | 12.1% | 12.1% | 0.0% | 87.9% |
| clustered null (5 clusters) | 50 | 0 | 20.0% | 20.0% | 0.0% | 80.0% |
| clustered null, clusters declared | 50 | 0 | 3.7% | 3.7% | 0.0% | 96.3% |
| unequal repetitions null (1 vs 3, binary) | 50 | 0 | 3.5% | 3.5% | 0.0% | 96.5% |
| three scorers null (correlated) | 50 | 0 | 2.5% | 2.5% | 0.0% | 97.5% |
| random failures null (5% both runs) | 50 | 0 | 92.6% | 5.6% | 0.0% | 7.4% |
| random failures null, budget 2 | 50 | 0 | 45.1% | 6.2% | 0.0% | 54.9% |
| random failures null, reliability 'statistical' | 50 | 0 | 6.6% | 5.4% | 0.0% | 93.4% |
| failures rise 5% -> 20%, reliability 'strict' | 50 | 0.15 | 100.0% | 5.3% | 0.0% | 0.0% |
| failures rise 5% -> 20%, reliability 'statistical' | 50 | 0.15 | 62.4% | 5.4% | 0.0% | 37.6% |
| drop 0.05, continuous | 50 | 0.05 | 50.0% | 50.0% | 0.0% | 50.0% |
| drop 0.05, binary | 50 | 0.05 | 8.8% | 8.8% | 0.0% | 91.2% |
| drop 0.1, continuous | 50 | 0.1 | 94.4% | 94.4% | 0.0% | 5.6% |
| drop 0.1, binary | 50 | 0.1 | 19.0% | 19.0% | 0.0% | 81.0% |
| skewed drop 0.05 (0.1 vs 0/1 at 5%) | 50 | 0.05 | 50.3% | 50.3% | 0.0% | 49.7% |

Resample check (symmetric null, n=50, 400 trials, 20000 resamples): 4.3%.
