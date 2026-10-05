/**
 * Copy to scripts/run-candidate.ts. Runs the agent under test over the dataset the baseline used
 * and prints the experiment id, for examples/ci/eval-gate.yml. Adjust the ids to your project.
 */
import { mastra } from '../src/mastra/index.js';

const DATASET_ID = process.env.EVAL_DATASET_ID ?? 'your-dataset-id';
const AGENT_ID = process.env.EVAL_AGENT_ID ?? 'your-agent-id';

const dataset = await mastra.datasets.get({ id: DATASET_ID });
const run = await dataset.startExperiment({
  targetType: 'agent',
  targetId: AGENT_ID,
  // Use the same scorers as the baseline experiment, or the gate reports them as missing.
  scorers: ['answer-relevancy', 'tool-call-accuracy'],
  maxConcurrency: 4,
});
console.log(run.experimentId);
process.exit(0);
