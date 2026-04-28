/**
 * Loads and parses workflow configuration.
 *
 * Supports two layouts:
 *   1. Split (preferred): symphony.yaml in the same directory as WORKFLOW.md
 *      — config lives in symphony.yaml, WORKFLOW.md is a pure Liquid template.
 *   2. Legacy: WORKFLOW.md with YAML front-matter (--- ... ---) followed by the template.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type Config } from './schema.js';
import { logger } from '../logger.js';

export interface WorkflowFile {
  config: Config;
  promptTemplate: string;
}

let cached: WorkflowFile | null = null;

/**
 * Load and parse workflow config from `filePath` (path to WORKFLOW.md).
 * Results are cached — call `reloadConfig()` to force a fresh load.
 *
 * If `symphony.yaml` exists alongside WORKFLOW.md it is used for config and
 * WORKFLOW.md is treated as a pure Liquid template. Otherwise the legacy
 * YAML front-matter layout is used.
 */
export function loadWorkflow(filePath: string): WorkflowFile {
  if (cached) return cached;

  const absTemplatePath = path.resolve(filePath);
  const configPath = path.join(path.dirname(absTemplatePath), 'symphony.yaml');

  if (fs.existsSync(configPath)) {
    cached = parseWorkflowSplit(configPath, absTemplatePath);
  } else {
    cached = parseWorkflowFile(absTemplatePath);
  }

  return cached;
}

export function reloadConfig(filePath: string): WorkflowFile {
  cached = null;
  return loadWorkflow(filePath);
}

export function getConfig(): Config {
  if (!cached) throw new Error('Config not loaded yet — call loadWorkflow() first');
  return cached.config;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseWorkflowSplit(configPath: string, templatePath: string): WorkflowFile {
  if (!fs.existsSync(configPath)) {
    throw new Error(`symphony.yaml not found: ${configPath}`);
  }
  if (!fs.existsSync(templatePath)) {
    throw new Error(`WORKFLOW.md not found: ${templatePath}`);
  }

  let yamlObj: unknown;
  try {
    yamlObj = parseYaml(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse symphony.yaml: ${String(err)}`);
  }

  checkDeprecatedKeys(yamlObj, configPath);
  const result = configSchema.safeParse(yamlObj);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`symphony.yaml config validation failed:\n${issues}`);
  }

  const templateRaw = fs.readFileSync(templatePath, 'utf8');
  const { body } = splitFrontMatter(templateRaw);

  cleanupSensitiveEnv();
  logger.info('Loaded config from symphony.yaml', { configPath, templatePath });

  return {
    config: result.data,
    promptTemplate: body.trim(),
  };
}

function parseWorkflowFile(filePath: string): WorkflowFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`WORKFLOW.md not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const { frontMatter, body } = splitFrontMatter(raw);

  if (!frontMatter) {
    throw new Error('WORKFLOW.md must start with a YAML front-matter block (--- ... ---)');
  }

  let yamlObj: unknown;
  try {
    yamlObj = parseYaml(frontMatter);
  } catch (err) {
    throw new Error(`Failed to parse WORKFLOW.md YAML front-matter: ${String(err)}`);
  }

  checkDeprecatedKeys(yamlObj, filePath);
  const result = configSchema.safeParse(yamlObj);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`WORKFLOW.md config validation failed:\n${issues}`);
  }

  cleanupSensitiveEnv();
  logger.info('Loaded WORKFLOW.md config', { path: filePath });

  return {
    config: result.data,
    promptTemplate: body.trim(),
  };
}

/** config 파싱 완료 후 부모 프로세스 env에서 민감 토큰을 제거한다 (defense-in-depth). */
function cleanupSensitiveEnv(): void {
  // SEMGREP_APP_TOKEN은 config.app_token으로 이미 캡처됨.
  // 이후 semgrep-runner는 options.env로 자식 프로세스에 명시적 전달 — 부모 env 불필요.
  delete process.env['SEMGREP_APP_TOKEN'];
}

/**
 * 구 설정 키 사용 여부를 검사하고 발견 시 fatal 에러를 던진다.
 * 무성 regression(잘못된 키가 zod에서 무시되어 기본값으로 폴백)을 방지한다.
 */
function checkDeprecatedKeys(raw: unknown, filePath: string): void {
  if (typeof raw !== 'object' || raw === null) return;
  const agents = (raw as Record<string, unknown>)['agents'];
  if (typeof agents === 'object' && agents !== null && 'max_concurrent' in agents) {
    throw new Error(
      `[${filePath}] 'agents.max_concurrent' is no longer supported. ` +
      `Please rename it to 'agents.max_containers' in your config file.`,
    );
  }
}

/**
 * Split a Markdown file into YAML front-matter and body.
 *
 * Returns `{ frontMatter: null, body: raw }` if no front-matter is found.
 */
function splitFrontMatter(raw: string): { frontMatter: string | null; body: string } {
  const normalised = raw.replace(/\r\n/g, '\n');

  if (!normalised.startsWith('---')) {
    return { frontMatter: null, body: normalised };
  }

  const endIndex = normalised.indexOf('\n---', 3);

  if (endIndex === -1) {
    return { frontMatter: null, body: normalised };
  }

  const frontMatter = normalised.slice(3, endIndex).trim();
  const body = normalised.slice(endIndex + 4); // skip the closing ---\n

  return { frontMatter, body };
}
