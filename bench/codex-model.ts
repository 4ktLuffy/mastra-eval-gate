/**
 * The Codex CLI as an AI SDK v5 language model, so a Mastra agent or LLM-judge scorer can run on
 * the ChatGPT account Codex is signed in with, without an API key.
 *
 * Each call is one `codex exec`. The system messages replace Codex's own agent instructions through
 * `model_instructions_file` (`experimental_instructions_file` is ignored); the other messages become
 * the prompt. A JSON response format is passed as `--output-schema` (made strict, as Codex
 * requires). An abort kills the process, so Mastra's item timeout really stops the call.
 *
 * Ported from judge-admissibility's bench/codex_judge.py.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Prompt } from '@ai-sdk/provider';

const WORKDIR = resolve(import.meta.dirname, '..', 'results', 'scratch', 'codex');

/** Tokens Codex reports per call, for the cost line in the results. */
export const TOKENS: number[] = [];
/** Wall-clock seconds per completed call. */
export const SECONDS: number[] = [];

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string; output?: unknown; input?: unknown; toolName?: string }) => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text ?? '';
      if (part.type === 'tool-call') return `[tool call ${part.toolName}: ${JSON.stringify(part.input)}]`;
      if (part.type === 'tool-result') return `[tool result ${part.toolName}: ${JSON.stringify(part.output)}]`;
      return '';
    })
    .join('\n');
}

function split(prompt: LanguageModelV2Prompt): { instructions: string; prompt: string } {
  const system = prompt.filter(m => m.role === 'system').map(m => messageText(m.content));
  const rest = prompt.filter(m => m.role !== 'system');
  // A single user message goes as is; a conversation is labelled by role.
  const text =
    rest.length === 1 && rest[0]!.role === 'user'
      ? messageText(rest[0]!.content)
      : rest.map(m => `${m.role}: ${messageText(m.content)}`).join('\n\n');
  return { instructions: system.join('\n\n').trim(), prompt: text };
}

/** Codex's structured output wants every object closed and every property required. */
function strict(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strict);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (k !== 'title' && k !== '$schema') out[k] = strict(v);
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties);
    }
    return out;
  }
  return schema;
}

function writeOnce(prefix: string, text: string, ext: string): string {
  mkdirSync(WORKDIR, { recursive: true });
  const path = join(WORKDIR, `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.${ext}`);
  if (!existsSync(path)) {
    const partial = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(partial, text);
    renameSync(partial, path); // atomic, so a concurrent call never reads a half-written file
  }
  return path;
}

export interface CodexOptions {
  model?: string;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** Hard cap per call, independent of Mastra's own timeouts. */
  timeoutMs?: number;
}

export async function runCodex(
  instructions: string,
  prompt: string,
  { model = 'gpt-5.6-luna', effort = 'none', timeoutMs = 300_000 }: CodexOptions,
  schema?: unknown,
  abortSignal?: AbortSignal,
): Promise<string> {
  const instructionsFile = writeOnce('instructions', instructions || 'Answer the request.', 'md');
  const outPath = join(WORKDIR, `out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const args = [
    'exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`,
    '-c', `model_instructions_file="${instructionsFile}"`,
    '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '-o', outPath,
  ];
  if (schema !== undefined) args.push('--output-schema', writeOnce('schema', JSON.stringify(strict(schema)), 'json'));
  args.push(prompt);

  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn('codex', args, { cwd: WORKDIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => (log += d));
    child.stderr.on('data', d => (log += d));
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, timeoutMs);
    abortSignal?.addEventListener('abort', kill, { once: true });
    child.on('close', code => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', kill);
      const used = log.split('tokens used')[1]?.trim().split(/\s+/)[0]?.replace(/,/g, '');
      if (used && /^\d+$/.test(used)) TOKENS.push(Number(used));
      if (abortSignal?.aborted) {
        rmSync(outPath, { force: true });
        return reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('aborted'));
      }
      if (code !== 0 || !existsSync(outPath)) {
        rmSync(outPath, { force: true });
        return reject(new Error(`codex exited ${code}: ${log.slice(-300)}`));
      }
      SECONDS.push((Date.now() - started) / 1000);
      const reply = readFileSync(outPath, 'utf8');
      rmSync(outPath, { force: true });
      resolvePromise(reply);
    });
  });
}

export function codexModel(options: CodexOptions = {}): LanguageModelV2 {
  const modelId = `${options.model ?? 'gpt-5.6-luna'}@${options.effort ?? 'none'}`;
  const generate = async (call: LanguageModelV2CallOptions) => {
    const { instructions, prompt } = split(call.prompt);
    const schema = call.responseFormat?.type === 'json' ? (call.responseFormat.schema ?? undefined) : undefined;
    const text = await runCodex(
      instructions + (schema ? '\nReply with JSON only, matching the requested schema.' : ''),
      prompt,
      options,
      schema,
      call.abortSignal,
    );
    return {
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: TOKENS.at(-1) },
      warnings: [],
    };
  };
  return {
    specificationVersion: 'v2',
    provider: 'codex-cli',
    modelId,
    supportedUrls: {},
    doGenerate: generate,
    async doStream(call) {
      const result = await generate(call);
      const text = result.content[0]!.text;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: text });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: result.usage });
          controller.close();
        },
      });
      return { stream };
    },
  } as LanguageModelV2;
}
