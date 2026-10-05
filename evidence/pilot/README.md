# Mastra fault-injection pilot (local only, mocked models, no network except fetching template source)
Versions: @mastra/core 1.74.0 (latest on npm 2026-10-05), @mastra/memory 1.35.0, ai 5.0.271, zod 4.6.5, tsx 4.23.15.
Setup: `npm i`. Templates fetched into tpl/ (weather-agent verbatim tool+workflow; refund/kyc only read for shape — workflow scenarios are condensed re-creations, NOT verbatim).
Run (each writes results/<name>.txt via tee):
- npx tsx model-faults.mjs        > results/model-faults.txt     (model faults x {single, fallback array}; weather tool verbatim)
- npx tsx timeouts.mjs            > results/timeouts.txt         (modelSettings.timeout stepMs/firstChunkMs/totalMs, abortSignal)
- npx tsx tool-faults.mjs         > results/tool-faults.txt      (throw/hang/invalid output/slow+fast)
- npx tsx workflow-faults.mjs     > results/workflow-faults.txt  (retries, post-effect throw, suspend/resume, parallel, nested, hang, dowhile+suspend)
- npx tsx template-workflow.mjs   > results/template-workflow.txt (VERBATIM weather-workflow.ts under model faults)
- npx tsx consume-paths.mjs       > results/consume-paths.txt    (text vs textStream vs fullStream vs getFullOutput under model failure)
- npx tsx memory-generate.mjs ; npx tsx memory-replay.mjs  > results/memory-*.txt
Negative controls: control_* rows in each file.
