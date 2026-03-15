/**
 * Loads and parses WORKFLOW.md.
 *
 * WORKFLOW.md uses YAML front-matter (between --- delimiters) for config and
 * the remaining content as the Liquid prompt template.
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
 * Load and parse WORKFLOW.md from `filePath`.
 * Results are cached — call `reloadConfig()` to force a fresh load.
 */
export function loadWorkflow(filePath: string): WorkflowFile {
  if (cached) return cached;
  cached = parseWorkflowFile(filePath);
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

function parseWorkflowFile(filePath: string): WorkflowFile {
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`WORKFLOW.md not found: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, 'utf8');
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

  const result = configSchema.safeParse(yamlObj);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`WORKFLOW.md config validation failed:\n${issues}`);
  }

  logger.info('Loaded WORKFLOW.md config', { path: absPath });

  return {
    config: result.data,
    promptTemplate: body.trim(),
  };
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
