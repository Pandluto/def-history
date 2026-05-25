import { BuffFillAgent } from './buffFillAgentCore';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function testSplitStopsWithoutModelClient() {
  const run = await new BuffFillAgent().run({
    sourceText: '天赋\n攻击力提升20%',
    stopAfterStage: 'split',
  });

  assert(run.stage === 'split', `expected split stage, got ${run.stage}`);
  assert(run.input.sourceHash.length === 64, 'expected sha256 source hash');
  assert(run.sectionResults.length === 1, 'expected one section');
  assert(run.sectionResults[0].status === 'pending', 'expected pending section');
  assert(run.sectionResults[0].prompt === undefined, 'split should not build prompts');
}

async function testExtractRequiresModelClient() {
  const run = await new BuffFillAgent().run({
    sourceText: '天赋\n攻击力提升20%',
  });

  assert(run.stage === 'failed', `expected failed stage, got ${run.stage}`);
  assert(
    run.errors.includes('BuffFillAgent requires modelClient for extract stage'),
    'expected modelClient missing error',
  );
}

await testSplitStopsWithoutModelClient();
await testExtractRequiresModelClient();
