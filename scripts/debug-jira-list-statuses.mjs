#!/usr/bin/env node
/**
 * List recent KAN issues and their status names (to compare with WORKFLOW active_states).
 * Run: node --env-file=.env scripts/debug-jira-list-statuses.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {}

const workflowPath = path.join(root, 'WORKFLOW.md');
const raw = fs.readFileSync(workflowPath, 'utf8');
const frontMatter = raw.slice(raw.indexOf('---') + 3, raw.indexOf('\n---', 4));
const yaml = await import('yaml').then((m) => m.parse(frontMatter));
const trackers = yaml.trackers ?? (yaml.tracker ? [yaml.tracker] : []);
const jiraConfig = trackers.find((t) => t.kind === 'jira');
function resolveEnv(obj) {
  const out = { ...obj };
  for (const k of ['api_token', 'email']) {
    if (typeof out[k] === 'string' && out[k].startsWith('$')) {
      out[k] = process.env[out[k].slice(1)] ?? '';
    }
  }
  return out;
}
const config = resolveEnv(jiraConfig);

const baseUrl = config.host.replace(/\/+$/, '');
const jql = `project = "${config.project_key}" ORDER BY updated DESC`;
const url = new URL('/rest/api/3/search/jql', baseUrl);
url.searchParams.set('jql', jql);
url.searchParams.set('maxResults', '20');
url.searchParams.set('fields', 'summary,status,updated');

const auth = Buffer.from(`${config.email}:${config.api_token}`).toString('base64');
const res = await fetch(url.toString(), {
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Basic ${auth}`,
  },
  signal: AbortSignal.timeout(15000),
});
const data = await res.json();
if (!res.ok) {
  console.log('HTTP', res.status, data);
  process.exit(1);
}

const issues = data.issues ?? [];
const statusSet = new Set();
console.log('KAN recent issues (up to 20) and status names:\n');
issues.forEach((i) => {
  const name = i.fields?.status?.name ?? '?';
  statusSet.add(name);
  console.log(`  ${i.key}  status="${name}"  ${(i.fields?.summary ?? '').slice(0, 50)}`);
});
console.log('\nDistinct status names in result:', [...statusSet].sort().join(', '));
console.log('\nWORKFLOW active_states:', jiraConfig.active_states);
console.log('Match: active_states must exactly match Jira status name (e.g. "검토 중" not "검토중").');
