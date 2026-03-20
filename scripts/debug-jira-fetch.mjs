#!/usr/bin/env node
/**
 * One-off debug: load config, create JiraClient, call fetchCandidateIssues(), log result.
 * Run from repo root: node --env-file=.env scripts/debug-jira-fetch.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load .env (Node 22+)
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {}

const workflowPath = path.join(root, 'WORKFLOW.md');
const raw = await import('node:fs').then((fs) => fs.readFileSync(workflowPath, 'utf8'));

// Minimal YAML parse for trackers[0] (Jira)
const frontMatter = raw.slice(raw.indexOf('---') + 3, raw.indexOf('\n---', 4));
const yaml = await import('yaml').then((m) => m.parse(frontMatter));

const trackers = yaml.trackers ?? (yaml.tracker ? [yaml.tracker] : []);
const jiraConfig = trackers.find((t) => t.kind === 'jira');
if (!jiraConfig) {
  console.error('No Jira tracker in WORKFLOW.md');
  process.exit(1);
}

// Resolve env refs in api_key/email
function resolveEnv(obj) {
  const out = { ...obj };
  for (const k of ['api_token', 'email']) {
    if (typeof out[k] === 'string' && out[k].startsWith('$')) {
      const name = out[k].slice(1);
      out[k] = process.env[name] ?? '';
    }
  }
  return out;
}

const config = resolveEnv(jiraConfig);
console.log('Config (masked):', {
  project_key: config.project_key,
  host: config.host,
  email: config.email ? `${config.email.slice(0, 3)}***` : '(empty)',
  api_token_set: Boolean(config.api_token),
  active_states: config.active_states,
  terminal_states: config.terminal_states,
});

const jql =
  `project = "${config.project_key}" AND status IN (${config.active_states.map((s) => `"${s}"`).join(', ')})` +
  ' ORDER BY priority ASC, updated DESC';
console.log('JQL:', jql);

// Call Jira REST API /rest/api/3/search/jql (same as real code)
const baseUrl = config.host.replace(/\/+$/, '');
const url = new URL('/rest/api/3/search/jql', baseUrl);
url.searchParams.set('jql', jql);
url.searchParams.set('maxResults', '50');
url.searchParams.set('fields', 'summary,description,priority,status,assignee,labels,created,updated');

const auth = Buffer.from(`${config.email}:${config.api_token}`).toString('base64');
const res = await fetch(url.toString(), {
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Basic ${auth}`,
  },
  signal: AbortSignal.timeout(15000),
});

const text = await res.text();
console.log('HTTP status:', res.status);

if (!res.ok) {
  console.log('Response body:', text.slice(0, 800));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(text);
} catch {
  console.log('Response (parse error):', text.slice(0, 500));
  process.exit(1);
}

const issues = data.issues ?? [];
const isLast = data.isLast;
const nextPageToken = data.nextPageToken;

console.log('Result: isLast=%s, nextPageToken=%s, issues.length=%d', isLast, nextPageToken ?? '(none)', issues.length);
if (issues.length > 0) {
  issues.slice(0, 3).forEach((i, idx) => {
    console.log(`  [${idx}] ${i.key} status="${i.fields?.status?.name}" title=${(i.fields?.summary ?? '').slice(0, 40)}`);
  });
} else {
  console.log('(No issues returned. Try broadening active_states or check project has issues in those statuses.)');
}
