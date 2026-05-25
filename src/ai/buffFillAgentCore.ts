import { buildBuffTypeCatalogPromptSection } from './buffFillCatalog';
import {
  buildBuffFillSectionPrompt,
  extractArkOutputText,
  splitAiFillWorkflow,
  type AiFillWorkflowState,
} from './buffFillAgent';
import { createOpenAiResponseFormatPayload } from './buffFillSchema';
import type { BuffFillAiDraft } from './buffFillSchema';
import {
  convertBuffFillAiDraftToBuffDraft,
  sanitizeBuffFillAiDraft,
  validateBuffFillAiDraft,
} from './buffFillValidator';

export type BuffFillAgentStage =
  | 'init'
  | 'split'
  | 'extract'
  | 'merge'
  | 'sanitize'
  | 'validate'
  | 'convert'
  | 'done'
  | 'failed';

export type BuffFillModelClient = {
  completeJson(input: {
    prompt: string;
    responseFormat?: unknown;
    sectionId?: string;
    sectionType?: string;
  }): Promise<unknown>;
};

export type BuffFillAgentOptions = {
  sourceText: string;
  modelClient?: BuffFillModelClient;
  stopAfterStage?: BuffFillAgentStage;
  debug?: boolean;
  systemPrompt?: string;
  catalogPrompt?: string;
};

export type BuffFillSectionRun = {
  sectionId: string;
  sectionType: string;
  title?: string;
  text: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  prompt?: string;
  rawOutput?: unknown;
  aiDraft?: unknown;
  sanitizedDraft?: unknown;
  errors: string[];
};

export type BuffFillAgentRun = {
  id: string;
  createdAt: string;
  stage: BuffFillAgentStage;
  input: {
    sourceText: string;
    sourceHash: string;
  };
  workflow?: unknown;
  sectionResults: BuffFillSectionRun[];
  mergedAiDraft?: unknown;
  sanitizedAiDraft?: unknown;
  validation?: {
    ok: boolean;
    errors: string[];
  };
  buffDraft?: unknown;
  errors: string[];
};

const MODEL_CLIENT_REQUIRED_ERROR = 'BuffFillAgent requires modelClient for extract stage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createSourceHash(sourceText: string) {
  const data = new TextEncoder().encode(sourceText);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createRunId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `buff-fill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function shouldStop(stage: BuffFillAgentStage, stopAfterStage?: BuffFillAgentStage) {
  return stage === stopAfterStage;
}

function extractCandidateDraft(rawOutput: unknown): unknown {
  if (isRecord(rawOutput) && isRecord(rawOutput.draft)) {
    return rawOutput.draft;
  }
  if (typeof rawOutput !== 'string') {
    return rawOutput;
  }

  const text = rawOutput.trim();
  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) && isRecord(parsed.draft) ? parsed.draft : parsed;
  } catch {
    const balancedJson = extractBalancedJsonObject(text);
    if (!balancedJson) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(balancedJson) as unknown;
      return isRecord(parsed) && isRecord(parsed.draft) ? parsed.draft : parsed;
    } catch {
      return undefined;
    }
  }
}

function extractBalancedJsonObject(text: string) {
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function firstNonEmpty(field: string, drafts: unknown[]) {
  for (const draft of drafts) {
    if (!isRecord(draft)) {
      continue;
    }
    const value = draft[field];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function mergeSectionDrafts(drafts: unknown[]) {
  return {
    id: firstNonEmpty('id', drafts),
    name: firstNonEmpty('name', drafts),
    sourceName: firstNonEmpty('sourceName', drafts),
    source: firstNonEmpty('source', drafts),
    description: firstNonEmpty('description', drafts),
    items: drafts.flatMap((draft) => {
      if (!isRecord(draft) || !Array.isArray(draft.items)) {
        return [];
      }
      return draft.items;
    }),
  };
}

export class BuffFillAgent {
  async run(options: BuffFillAgentOptions): Promise<BuffFillAgentRun> {
    const run: BuffFillAgentRun = {
      id: createRunId(),
      createdAt: new Date().toISOString(),
      stage: 'init',
      input: {
        sourceText: options.sourceText,
        sourceHash: await createSourceHash(options.sourceText),
      },
      sectionResults: [],
      errors: [],
    };

    try {
      if (shouldStop('init', options.stopAfterStage)) {
        return run;
      }

      run.stage = 'split';
      const workflow = splitAiFillWorkflow(options.sourceText);
      run.workflow = workflow;
      run.sectionResults = workflow.sections.map((section) => ({
        sectionId: section.id,
        sectionType: section.sectionType,
        title: section.title,
        text: section.rawText,
        status: 'pending',
        errors: [],
      }));
      if (shouldStop('split', options.stopAfterStage)) {
        return run;
      }

      if (!options.modelClient) {
        run.stage = 'failed';
        run.errors.push(MODEL_CLIENT_REQUIRED_ERROR);
        return run;
      }

      run.stage = 'extract';
      await this.extractSections(run, workflow, options);
      if (shouldStop('extract', options.stopAfterStage)) {
        return run;
      }

      run.stage = 'merge';
      run.mergedAiDraft = mergeSectionDrafts(
        run.sectionResults
          .filter((section) => section.status === 'completed')
          .map((section) => section.aiDraft),
      );
      if (shouldStop('merge', options.stopAfterStage)) {
        return run;
      }

      run.stage = 'sanitize';
      run.sanitizedAiDraft = sanitizeBuffFillAiDraft(run.mergedAiDraft);
      run.sectionResults = run.sectionResults.map((section) => ({
        ...section,
        sanitizedDraft: section.aiDraft === undefined ? undefined : sanitizeBuffFillAiDraft(section.aiDraft),
      }));
      if (shouldStop('sanitize', options.stopAfterStage)) {
        return run;
      }

      run.stage = 'validate';
      const validation = validateBuffFillAiDraft(run.sanitizedAiDraft);
      run.validation = validation;
      if (!validation.ok) {
        run.errors.push(...validation.errors);
      }
      if (shouldStop('validate', options.stopAfterStage)) {
        return run;
      }
      if (!validation.ok) {
        run.stage = 'failed';
        return run;
      }

      run.stage = 'convert';
      run.buffDraft = convertBuffFillAiDraftToBuffDraft(run.sanitizedAiDraft as BuffFillAiDraft);
      if (shouldStop('convert', options.stopAfterStage)) {
        return run;
      }

      run.stage = 'done';
      return run;
    } catch (error) {
      run.stage = 'failed';
      run.errors.push(error instanceof Error ? error.message : String(error));
      return run;
    }
  }

  private async extractSections(
    run: BuffFillAgentRun,
    workflow: AiFillWorkflowState,
    options: BuffFillAgentOptions,
  ) {
    const catalogPrompt = options.catalogPrompt ?? buildBuffTypeCatalogPromptSection();
    const systemPrompt = options.systemPrompt ?? '';
    const responseFormat = createOpenAiResponseFormatPayload();

    for (const section of workflow.sections) {
      const sectionRun = run.sectionResults.find((entry) => entry.sectionId === section.id);
      if (!sectionRun) {
        continue;
      }

      sectionRun.status = 'running';
      sectionRun.prompt = buildBuffFillSectionPrompt(systemPrompt, catalogPrompt, section);

      try {
        const rawOutput = await options.modelClient!.completeJson({
          prompt: sectionRun.prompt,
          responseFormat,
          sectionId: section.id,
          sectionType: section.sectionType,
        });
        sectionRun.rawOutput = rawOutput;
        const outputText = extractArkOutputText(rawOutput);
        sectionRun.aiDraft = extractCandidateDraft(outputText || rawOutput);
        if (sectionRun.aiDraft === undefined) {
          sectionRun.status = 'failed';
          sectionRun.errors.push('模型返回内容无法解析为 JSON 对象');
        } else {
          sectionRun.status = 'completed';
        }
      } catch (error) {
        sectionRun.status = 'failed';
        sectionRun.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
}
