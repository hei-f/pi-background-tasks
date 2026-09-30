#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--root' && value) out.root = resolve(value);
    else if (key === '--scenario' && value) out.scenario = value;
    else if (key === '--sample-root' && value) out.sampleRoot = resolve(value);
    else if (key === '--runtime' && (value === 'source' || value === 'compiled')) out.runtime = value;
    else throw new Error(`unknown or incomplete argument: ${key ?? '(missing)'}`);
  }
  if (!out.root || !out.scenario || !out.sampleRoot) throw new Error('worker requires --root, --scenario, and --sample-root');
  out.runtime ??= 'source';
  return out;
}

const args = parseArgs(process.argv.slice(2));
const project = join(args.sampleRoot, 'project');
const agentDir = join(args.sampleRoot, 'agent');
const binDir = join(args.sampleRoot, 'bin');
await Promise.all([
  mkdir(project, { recursive: true }),
  mkdir(agentDir, { recursive: true }),
  mkdir(binDir, { recursive: true }),
]);
Object.assign(process.env, {
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  CI: '1',
  PI_CODING_AGENT_DIR: agentDir,
});

const url = (relative) => pathToFileURL(join(args.root, relative)).href;
const elapsed = (start) => Number((performance.now() - start).toFixed(6));

function emit(metrics, facts = {}) {
  console.log(JSON.stringify({ scenario: args.scenario, metrics, facts }));
}

const runtimePath = (sourcePath, compiledPath) =>
  args.runtime === 'compiled' ? compiledPath : sourcePath;

const sdkImportStart = performance.now();
const sdk = await import(url('node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
const sdkImportMs = elapsed(sdkImportStart);
const {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = sdk;

const backgroundPath = join(
  args.root,
  runtimePath('extensions/background-tasks.ts', 'dist/extensions/background-tasks.js'),
);
async function makeLoader(paths) {
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'bench-provider',
    defaultModel: 'bench-model',
  });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: paths,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  return { loader, settingsManager, eventBus };
}

function inventory(result) {
  return {
    tools: result.extensions.flatMap((extension) => [...extension.tools.keys()]).sort(),
    commands: result.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
    renderers: result.extensions.flatMap((extension) => [...extension.messageRenderers.keys()]).sort(),
  };
}

if (
  args.scenario === 'sdk-no-extension-load' ||
  args.scenario === 'sdk-process-only-load' ||
  args.scenario === 'sdk-default-load'
) {
  if (args.scenario === 'sdk-process-only-load') process.env.PI_BG_DOCK_SHORTCUT = 'off';
  else Reflect.deleteProperty(process.env, 'PI_BG_DOCK_SHORTCUT');
  const paths = args.scenario === 'sdk-no-extension-load' ? [] : [backgroundPath];
  const { loader } = await makeLoader(paths);
  const start = performance.now();
  await loader.reload();
  const loadMs = elapsed(start);
  const result = loader.getExtensions();
  if (result.errors.length > 0) throw new Error(`extension load errors: ${JSON.stringify(result.errors)}`);
  emit({ sdk_import_ms: sdkImportMs, package_load_ms: loadMs }, inventory(result));
  process.exit(0);
}

process.env.PI_BG_DOCK_SHORTCUT = 'off';

const { loader, settingsManager, eventBus } = await makeLoader([backgroundPath]);
const loaderStart = performance.now();
await loader.reload();
const packageLoadMs = elapsed(loaderStart);
const extensionResult = loader.getExtensions();
if (extensionResult.errors.length > 0) throw new Error(`extension load errors: ${JSON.stringify(extensionResult.errors)}`);
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
const modelRegistry = new ModelRegistry(modelRuntime);
modelRegistry.registerProvider('bench-provider', {
  name: 'Cold benchmark provider',
  baseUrl: 'https://example.invalid',
  apiKey: 'PI_BG_FUSION_TEST_KEY',
  api: 'openai-responses',
  models: [{
    id: 'bench-model',
    name: 'Cold benchmark model',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 4096,
  }],
});
const created = await createAgentSession({
  cwd: project,
  agentDir,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(project),
  settingsManager,
  modelRuntime,
  noTools: 'builtin',
});
const session = created.session;
const model = modelRegistry.find('bench-provider', 'bench-model');
if (!model) throw new Error('benchmark model did not register');
await session.setModel(model);
session.setThinkingLevel('low');
await session.bindExtensions({ mode: 'json' });

function tool(name) {
  const found = session.getToolDefinition(name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function execute(name, input) {
  return tool(name).execute(
    `benchmark-${name}`,
    input,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
}

function field(value, key) {
  if (typeof value !== 'object' || value === null) throw new Error(`${key} parent is not an object`);
  return Reflect.get(value, key);
}

async function waitTerminal(taskId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await execute('bg_status', { taskId });
    const details = field(result, 'details');
    const tasks = field(details, 'tasks');
    if (Array.isArray(tasks) && tasks.length === 1) {
      const status = field(tasks[0], 'status');
      if (status !== 'running') return status;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`task ${taskId} did not settle`);
}

async function close() {
  try {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    session.dispose();
  }
}

throw new Error(`unsupported scenario: ${args.scenario}`);

