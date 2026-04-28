/**
 * diff-parser 단위 테스트
 */

import { describe, it, expect } from 'vitest';
import { parseDiffToFiles } from './diff-parser.js';

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 context
-removed
+added
+also added
 context2
diff --git a/src/bar.ts b/src/bar.ts
new file mode 100644
--- /dev/null
+++ b/src/bar.ts
@@ -0,0 +1,2 @@
+new file line 1
+new file line 2
diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-deleted line
`;

describe('parseDiffToFiles', () => {
  it('파일별로 올바르게 파싱한다', () => {
    const files = parseDiffToFiles(SAMPLE_DIFF);
    expect(files).toHaveLength(3);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[1].path).toBe('src/bar.ts');
    expect(files[2].path).toBe('src/baz.ts');
  });

  it('status를 올바르게 감지한다', () => {
    const files = parseDiffToFiles(SAMPLE_DIFF);
    expect(files[0].status).toBe('modified');
    expect(files[1].status).toBe('added');
    expect(files[2].status).toBe('deleted');
  });

  it('additions/deletions를 올바르게 집계한다', () => {
    const files = parseDiffToFiles(SAMPLE_DIFF);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[1].additions).toBe(2);
    expect(files[1].deletions).toBe(0);
    expect(files[2].additions).toBe(0);
    expect(files[2].deletions).toBe(1);
  });

  it('upload_sent는 초기값 false다', () => {
    const files = parseDiffToFiles(SAMPLE_DIFF);
    expect(files.every(f => f.upload_sent === false)).toBe(true);
  });

  it('content에 diff 본문이 포함된다', () => {
    const files = parseDiffToFiles(SAMPLE_DIFF);
    expect(files[0].content).toContain('@@ -1,3 +1,4 @@');
    expect(files[0].content).toContain('-removed');
    expect(files[0].content).toContain('+added');
  });

  it('라인 상한 초과 시 part N/M 접미사로 분할한다', () => {
    // 1500라인을 초과하는 diff 생성
    const manyLines = Array.from({ length: 1600 }, (_, i) => `+line ${i}`).join('\n');
    const bigDiff = `diff --git a/big.ts b/big.ts
new file mode 100644
--- /dev/null
+++ b/big.ts
@@ -0,0 +1,1600 @@
${manyLines}
`;
    const files = parseDiffToFiles(bigDiff);
    expect(files.length).toBeGreaterThan(1);
    expect(files[0].path).toMatch(/big\.ts \(part 1\/\d+\)/);
    expect(files[1].path).toMatch(/big\.ts \(part 2\/\d+\)/);
    // status/additions는 모든 파트에서 동일
    expect(files[0].status).toBe('added');
  });

  it('빈 diff는 빈 배열을 반환한다', () => {
    expect(parseDiffToFiles('')).toHaveLength(0);
  });
});
