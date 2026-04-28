/**
 * Unified diff → 파일별 DiffFile 파싱.
 *
 * `git diff origin/main...HEAD` 출력을 파일별로 분리한다.
 * Slack snippet 업로드용으로 파일당 content 문자열을 반환하며,
 * 1500라인 또는 900KB 초과 시 part N/M 접미사로 분할한다.
 */

import type { DiffFile } from './diff-queue.js';

/** Slack snippet 1개당 최대 라인 수. */
const MAX_LINES_PER_PART = 1_500;
/** Slack snippet 1MB 한도의 안전 마진 (바이트). */
const MAX_BYTES_PER_PART = 900_000;
/** 단일 파일당 최대 파트 수 — 초과 시 처음 N개 파트만 업로드하고 절단 표시. */
const MAX_PARTS_PER_FILE = 50;

/**
 * raw unified diff를 파일별 DiffFile 배열로 파싱한다.
 * 매우 큰 파일은 여러 DiffFile 레코드(part 1/N, 2/N, …)로 분할된다.
 */
export function parseDiffToFiles(rawDiff: string): DiffFile[] {
  const fileDiffs = splitByFile(rawDiff);
  return fileDiffs.flatMap(parseSingleFile);
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
  const regex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const matches = [...rawDiff.matchAll(regex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : rawDiff.length;
    const section = rawDiff.slice(start, end);

    const hhIdx = section.indexOf('\n@@');
    const header = hhIdx >= 0 ? section.slice(0, hhIdx) : section;
    const body = hhIdx >= 0 ? section.slice(hhIdx + 1) : '';

    parts.push({
      header,
      path: match[2],
      oldPath: match[1],
      body,
    });
  }

  return parts;
}

function parseSingleFile(raw: RawFileDiff): DiffFile[] {
  const status = detectStatus(raw.header, raw.oldPath);
  const { additions, deletions } = countChanges(raw.body);
  const content = raw.body.trim();

  let parts = splitContent(content);

  if (parts.length > MAX_PARTS_PER_FILE) {
    parts = parts.slice(0, MAX_PARTS_PER_FILE);
    parts[parts.length - 1] +=
      `\n\n... (파일이 너무 커서 처음 ${MAX_PARTS_PER_FILE}개 파트만 표시합니다. PR을 직접 확인해 주세요.)`;
  }

  const totalParts = parts.length;

  return parts.map((partContent, i) => ({
    path: totalParts > 1 ? `${raw.path} (part ${i + 1}/${totalParts})` : raw.path,
    status,
    additions,
    deletions,
    content: partContent || '(empty diff)',
    upload_sent: false,
  }));
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
 * diff 본문을 라인/바이트 상한 기준으로 분할한다.
 * 상한 미만이면 길이 1의 배열을 반환한다.
 */
function splitContent(content: string): string[] {
  if (!content) return [''];

  const rawLines = content.split('\n');
  // split('\n')의 후행 빈 원소 제거
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const lines = rawLines;

  const joined = lines.join('\n');
  if (lines.length <= MAX_LINES_PER_PART && Buffer.byteLength(joined, 'utf8') <= MAX_BYTES_PER_PART) {
    return [joined];
  }

  const parts: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
    if (
      current.length > 0 &&
      (current.length >= MAX_LINES_PER_PART || currentBytes + lineBytes > MAX_BYTES_PER_PART)
    ) {
      parts.push(current.join('\n'));
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += lineBytes;
  }

  if (current.length > 0) parts.push(current.join('\n'));
  return parts;
}
