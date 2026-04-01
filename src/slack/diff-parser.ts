/**
 * Unified diff → 파일별 청크 파싱.
 *
 * `git diff origin/main...HEAD` 출력을 파일별로 분리하고,
 * Slack 메시지 크기 제한에 맞게 청크를 사전 분할한다.
 */

import type { DiffFile } from './diff-queue.js';

/** Slack 메시지 한 청크의 최대 문자 수 (헤더 + 코드블록 감싸기 여유 포함). */
const MAX_CHUNK_CHARS = 3_500;

/**
 * raw unified diff를 파일별 DiffFile 배열로 파싱한다.
 */
export function parseDiffToFiles(rawDiff: string): DiffFile[] {
  const fileDiffs = splitByFile(rawDiff);
  return fileDiffs.map(parseSingleFile);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface RawFileDiff {
  header: string; // "diff --git ..." 블록
  path: string;
  oldPath: string;
  body: string; // @@ ... 이하 전체
}

/** diff --git a/... b/... 기준으로 파일별 분리. */
function splitByFile(rawDiff: string): RawFileDiff[] {
  const parts: RawFileDiff[] = [];
  // diff --git a/path b/path 패턴으로 분리
  const regex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const matches = [...rawDiff.matchAll(regex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : rawDiff.length;
    const section = rawDiff.slice(start, end);

    // header: diff --git 부터 첫 @@ 까지 (또는 전체)
    const hhIdx = section.indexOf('\n@@');
    const header = hhIdx >= 0 ? section.slice(0, hhIdx) : section;
    const body = hhIdx >= 0 ? section.slice(hhIdx + 1) : '';

    parts.push({
      header,
      path: match[2], // b/ 경로 (rename 대응)
      oldPath: match[1],
      body,
    });
  }

  return parts;
}

function parseSingleFile(raw: RawFileDiff): DiffFile {
  const status = detectStatus(raw.header, raw.oldPath);
  const { additions, deletions } = countChanges(raw.body);

  // diff 본문을 코드블록으로 감싸서 청크 분할
  const diffContent = raw.body.trim();
  const chunks = splitIntoChunks(diffContent);

  return {
    path: raw.path,
    status,
    additions,
    deletions,
    chunks,
    sent_chunks: chunks.map(() => false),
  };
}

function detectStatus(header: string, oldPath: string): 'added' | 'modified' | 'deleted' {
  if (header.includes('new file mode')) return 'added';
  if (header.includes('deleted file mode')) return 'deleted';
  if (oldPath === '/dev/null') return 'added';
  return 'modified';
}

function countChanges(body: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/**
 * diff 본문을 Slack 코드블록(```diff ... ```)으로 감싸고,
 * MAX_CHUNK_CHARS를 초과하면 라인 경계에서 분할한다.
 */
function splitIntoChunks(diffContent: string): string[] {
  if (!diffContent) return ['_(빈 diff)_'];

  const lines = diffContent.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  // 코드블록 감싸기 오버헤드: "```diff\n" (8) + "\n```" (4) = ~12
  const overhead = 12;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for newline
    if (currentLen + lineLen + overhead > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push(wrapCodeBlock(current.join('\n')));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }

  if (current.length > 0) {
    chunks.push(wrapCodeBlock(current.join('\n')));
  }

  return chunks.length > 0 ? chunks : ['_(빈 diff)_'];
}

function wrapCodeBlock(content: string): string {
  return '```diff\n' + content + '\n```';
}
