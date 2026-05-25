import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuffFillAgent, type BuffFillAgentRun, type BuffFillAgentStage } from '../ai/buffFillAgentCore';
import { sanitizeBuffFillAiDraft, validateBuffFillAiDraft } from '../ai/buffFillValidator';
import type { BuffFillAiDraft } from '../ai/buffFillSchema';

const VALID_STAGES = new Set<BuffFillAgentStage>([
  'init',
  'split',
  'extract',
  'merge',
  'sanitize',
  'validate',
  'convert',
  'done',
  'failed',
]);

type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      flags[rawName] = inlineValue;
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[rawName] = next;
      index += 1;
    } else {
      flags[rawName] = true;
    }
  }

  return { command, positional, flags };
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  pnpm buff-cli split ./input.txt',
    '  pnpm buff-cli fill ./input.txt [--stage split|extract|merge|sanitize|validate|convert|done] [--out ./runs/case001.run.json] [--debug]',
    '  pnpm buff-cli validate ./draft.json',
    '  pnpm buff-cli inspect ./runs/case001.run.json',
    '',
  ].join('\n'));
}

function readTextFile(inputPath: string) {
  return readFile(resolve(process.cwd(), inputPath), 'utf8');
}

async function readSystemPrompt() {
  const cliFile = fileURLToPath(import.meta.url);
  const promptPath = resolve(dirname(cliFile), '../prompts/buff-sheet-ai-system-prompt.md');
  return readFile(promptPath, 'utf8');
}

function getStage(value: string | boolean | undefined): BuffFillAgentStage | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (!VALID_STAGES.has(value as BuffFillAgentStage)) {
    throw new Error(`Unknown stage: ${value}`);
  }
  return value as BuffFillAgentStage;
}

async function runAgent(sourceText: string, stopAfterStage?: BuffFillAgentStage, debug?: boolean) {
  const systemPrompt = stopAfterStage === 'split' ? undefined : await readSystemPrompt();
  return new BuffFillAgent().run({
    sourceText,
    stopAfterStage,
    debug,
    systemPrompt,
  });
}

async function commandSplit(inputPath: string | undefined) {
  if (!inputPath) {
    throw new Error('split requires an input file');
  }
  const sourceText = await readTextFile(inputPath);
  const run = await new BuffFillAgent().run({
    sourceText,
    stopAfterStage: 'split',
  });

  printJson({
    sourceHash: run.input.sourceHash,
    workflow: run.workflow,
    sections: run.sectionResults,
  });
}

async function commandFill(inputPath: string | undefined, args: ParsedArgs) {
  if (!inputPath) {
    throw new Error('fill requires an input file');
  }

  const sourceText = await readTextFile(inputPath);
  const stage = getStage(args.flags.stage) ?? undefined;
  const run = await runAgent(sourceText, stage, Boolean(args.flags.debug));
  const out = args.flags.out;

  if (typeof out === 'string') {
    const outPath = resolve(process.cwd(), out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }

  printJson({
    id: run.id,
    stage: run.stage,
    sourceHash: run.input.sourceHash,
    sections: run.sectionResults.length,
    validation: run.validation,
    errors: run.errors,
    out: typeof out === 'string' ? resolve(process.cwd(), out) : undefined,
  });

  if (run.stage === 'failed') {
    process.exitCode = 1;
  }
}

async function commandValidate(inputPath: string | undefined) {
  if (!inputPath) {
    throw new Error('validate requires a draft JSON file');
  }

  const rawText = await readTextFile(inputPath);
  const parsed = JSON.parse(rawText) as unknown;
  const candidate = parsed && typeof parsed === 'object' && 'draft' in parsed
    ? (parsed as { draft: unknown }).draft
    : parsed;
  const sanitizedDraft = sanitizeBuffFillAiDraft(candidate);
  const validation = validateBuffFillAiDraft(sanitizedDraft);

  printJson({
    ok: validation.ok,
    errors: validation.errors,
    sanitizedDraft,
  });

  if (!validation.ok) {
    process.exitCode = 1;
  }
}

function countDraftEffects(value: unknown) {
  if (!value || typeof value !== 'object' || !Array.isArray((value as BuffFillAiDraft).items)) {
    return 0;
  }
  return (value as BuffFillAiDraft).items.reduce((sum, item) => {
    return sum + (Array.isArray(item.effects) ? item.effects.length : 0);
  }, 0);
}

function formatInspect(run: BuffFillAgentRun) {
  const lines = [
    `Run: ${run.id}`,
    `CreatedAt: ${run.createdAt}`,
    `Stage: ${run.stage}`,
    `SourceHash: ${run.input.sourceHash}`,
    `Sections: ${run.sectionResults.length}`,
    `Errors: ${run.errors.length}`,
    '',
  ];

  for (const section of run.sectionResults) {
    lines.push(`[${section.sectionId}] ${section.sectionType} ${section.status}`);
    lines.push(`title: ${section.title ?? ''}`);
    lines.push(`prompt: ${section.prompt ? 'yes' : 'no'}`);
    lines.push(`effects: ${countDraftEffects(section.sanitizedDraft ?? section.aiDraft)}`);
    lines.push(`errors: ${section.errors.length}`);
    if (section.errors.length > 0) {
      lines.push('errors:');
      section.errors.forEach((error) => lines.push(`- ${error}`));
    }
    lines.push('');
  }

  if (run.errors.length > 0) {
    lines.push('Run errors:');
    run.errors.forEach((error) => lines.push(`- ${error}`));
  }

  return lines.join('\n').trimEnd();
}

async function commandInspect(inputPath: string | undefined) {
  if (!inputPath) {
    throw new Error('inspect requires a run JSON file');
  }
  const run = JSON.parse(await readTextFile(inputPath)) as BuffFillAgentRun;
  process.stdout.write(`${formatInspect(run)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printUsage();
    return;
  }

  if (args.command === 'split') {
    await commandSplit(args.positional[0]);
    return;
  }
  if (args.command === 'fill') {
    await commandFill(args.positional[0], args);
    return;
  }
  if (args.command === 'validate') {
    await commandValidate(args.positional[0]);
    return;
  }
  if (args.command === 'inspect') {
    await commandInspect(args.positional[0]);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
