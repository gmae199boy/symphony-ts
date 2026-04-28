/**
 * DiffSender 단위 테스트
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { DiffSender } from './diff-sender.js';
import type { DiffQueueStore, DiffQueueRecord } from './diff-queue.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRecord(overrides: Partial<DiffQueueRecord> = {}): DiffQueueRecord {
  return {
    issueIdentifier: 'TEST-1',
    pr_url: 'https://example.com/pr/1',
    pr_number: 1,
    thread_ts: '9000',
    channel: 'C1',
    summary_sent: false,
    approval_sent: false,
    files: [
      {
        path: 'src/foo.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        content: '@@ -1,2 +1,5 @@\n-old\n+new',
        upload_sent: false,
      },
      {
        path: 'src/bar.ts',
        status: 'added',
        additions: 10,
        deletions: 0,
        content: '@@ -0,0 +1,10 @@\n+new file',
        upload_sent: false,
      },
    ],
    ...overrides,
  };
}

function makeStore(record: DiffQueueRecord): DiffQueueStore {
  return {
    get: vi.fn().mockReturnValue(record),
    set: vi.fn(),
    delete: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    getPendingIdentifiers: vi.fn().mockReturnValue(['TEST-1']),
  } as unknown as DiffQueueStore;
}

function makeClient(): WebClient {
  return {
    files: {
      uploadV2: vi.fn().mockResolvedValue({ ok: true }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1000', channel: 'C1' }),
    },
  } as unknown as WebClient;
}

/** 테스트용 DiffSender — 딜레이 없음. */
function makeSender(client: WebClient, store: DiffQueueStore) {
  return new DiffSender(client, store, { interFileDelayMs: 0 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DiffSender', () => {
  describe('정상 경로', () => {
    it('파일 2개를 순서대로 snippet 업로드하고 upload_sent/approval_sent를 마킹한다', async () => {
      const record = makeRecord();
      const store = makeStore(record);
      const client = makeClient();
      const sender = makeSender(client, store);

      await sender.sendPendingDiffs('TEST-1');

      expect(client.files.uploadV2).toHaveBeenCalledTimes(2);

      const firstCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstCall).toMatchObject({
        channel_id: 'C1',
        thread_ts: '9000',
        filetype: 'diff',
        snippet_type: 'diff',
        filename: 'src_foo.ts.diff',
        content: '@@ -1,2 +1,5 @@\n-old\n+new',
      });

      const secondCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(secondCall.filename).toBe('src_bar.ts.diff');

      expect(record.files[0].upload_sent).toBe(true);
      expect(record.files[1].upload_sent).toBe(true);
      expect(record.approval_sent).toBe(true);
      expect(store.save).toHaveBeenCalled();
    });

    it('이미 upload_sent=true인 파일은 건너뛴다', async () => {
      const record = makeRecord();
      record.files[0].upload_sent = true;
      const store = makeStore(record);
      const client = makeClient();
      const sender = makeSender(client, store);

      await sender.sendPendingDiffs('TEST-1');

      expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
      const call = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.filename).toBe('src_bar.ts.diff');
    });

    it('approval_sent=true이면 아무것도 하지 않는다', async () => {
      const record = makeRecord({ approval_sent: true });
      const store = makeStore(record);
      const client = makeClient();
      const sender = makeSender(client, store);

      await sender.sendPendingDiffs('TEST-1');

      expect(client.files.uploadV2).not.toHaveBeenCalled();
    });

    it('요약 메시지에 unfurl_links=false, unfurl_media=false를 전달한다', async () => {
      const record = makeRecord();
      const store = makeStore(record);
      const client = makeClient();
      const sender = makeSender(client, store);

      await sender.sendPendingDiffs('TEST-1');

      const postMessageCall = (client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(postMessageCall).toMatchObject({ unfurl_links: false, unfurl_media: false });
    });

    it('thread_ts가 빈 문자열이면 즉시 throw한다', async () => {
      const record = makeRecord({ thread_ts: '' });
      const store = makeStore(record);
      const client = makeClient();
      const sender = makeSender(client, store);

      await expect(sender.sendPendingDiffs('TEST-1')).rejects.toThrow('thread_ts is empty');
      expect(client.files.uploadV2).not.toHaveBeenCalled();
    });

    it('동일 identifier 중복 호출은 기존 Promise를 재사용한다', async () => {
      const record = makeRecord();
      const store = makeStore(record);
      const client = makeClient();
      const sender = makeSender(client, store);

      const p1 = sender.sendPendingDiffs('TEST-1');
      const p2 = sender.sendPendingDiffs('TEST-1');

      expect(p1).toBe(p2);
      await p1;
    });
  });

  describe('재시도 경로', () => {
    it('일시 실패 후 성공하면 재시도로 업로드를 완료한다', async () => {
      vi.useFakeTimers();
      const record = makeRecord();
      const store = makeStore(record);
      const uploadV2 = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: 'timeout' })
        .mockResolvedValue({ ok: true });
      const client = {
        files: { uploadV2 },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1', channel: 'C1' }) },
      } as unknown as WebClient;
      // interFileDelayMs=0으로 설정하면 summary 이후 파일 딜레이가 없어 runAllTimersAsync만으로 충분
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      const sendPromise = sender.sendPendingDiffs('TEST-1');
      await vi.runAllTimersAsync();
      await sendPromise;

      // 파일1: 1실패 + 1성공, 파일2: 1성공 = 총 3회
      expect(uploadV2.mock.calls.length).toBe(3);
      expect(record.files[0].upload_sent).toBe(true);
      expect(record.files[1].upload_sent).toBe(true);
      expect(record.approval_sent).toBe(true);
      // 파일1 성공, 파일2 성공, 완료 마킹 = save 최소 3회
      expect((store.save as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('rate-limit 에러 시 retryAfter 시간 후 재시도한다', async () => {
      vi.useFakeTimers();
      const record = makeRecord({ files: [makeRecord().files[0]] });
      const store = makeStore(record);
      const uploadV2 = vi.fn()
        .mockRejectedValueOnce({ code: 'slack_webapi_rate_limited_error', retryAfter: 5 })
        .mockResolvedValue({ ok: true });
      const client = {
        files: { uploadV2 },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1', channel: 'C1' }) },
      } as unknown as WebClient;
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      const sendPromise = sender.sendPendingDiffs('TEST-1');
      await vi.runAllTimersAsync();
      await sendPromise;

      expect(uploadV2).toHaveBeenCalledTimes(2);
      expect(record.approval_sent).toBe(true);
    });

    it('요약 rate-limit 에러 시 retryAfter 시간 후 재시도한다', async () => {
      vi.useFakeTimers();
      const record = makeRecord({ files: [makeRecord().files[0]] });
      const store = makeStore(record);
      const postMessage = vi.fn()
        .mockRejectedValueOnce({ code: 'slack_webapi_rate_limited_error', retryAfter: 3 })
        .mockResolvedValue({ ok: true, ts: '1', channel: 'C1' });
      const client = {
        files: { uploadV2: vi.fn().mockResolvedValue({ ok: true }) },
        chat: { postMessage },
      } as unknown as WebClient;
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      const sendPromise = sender.sendPendingDiffs('TEST-1');
      await vi.runAllTimersAsync();
      await sendPromise;

      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(record.approval_sent).toBe(true);
    });
  });

  describe('영구 에러 경로', () => {
    it('missing_scope 에러 시 즉시 throw하고 큐에서 삭제한다', async () => {
      const record = makeRecord();
      const store = makeStore(record);
      const uploadV2 = vi.fn().mockRejectedValue({ data: { error: 'missing_scope' } });
      const client = {
        files: { uploadV2 },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1', channel: 'C1' }) },
      } as unknown as WebClient;
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      await expect(sender.sendPendingDiffs('TEST-1')).rejects.toBeDefined();
      expect(uploadV2).toHaveBeenCalledTimes(1);
      expect(store.delete).toHaveBeenCalledWith('TEST-1');
    });

    it('not_allowed_token_type 에러 시 즉시 throw하고 큐에서 삭제한다', async () => {
      const record = makeRecord();
      const store = makeStore(record);
      const uploadV2 = vi.fn().mockRejectedValue({ data: { error: 'not_allowed_token_type' } });
      const client = {
        files: { uploadV2 },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1', channel: 'C1' }) },
      } as unknown as WebClient;
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      await expect(sender.sendPendingDiffs('TEST-1')).rejects.toBeDefined();
      expect(store.delete).toHaveBeenCalledWith('TEST-1');
    });

    it('ok=false + 영구 에러 코드 응답 시 throw하고 큐에서 삭제한다', async () => {
      const record = makeRecord({ files: [makeRecord().files[0]] });
      const store = makeStore(record);
      const uploadV2 = vi.fn().mockResolvedValue({ ok: false, error: 'invalid_auth' });
      const client = {
        files: { uploadV2 },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1', channel: 'C1' }) },
      } as unknown as WebClient;
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      await expect(sender.sendPendingDiffs('TEST-1')).rejects.toBeDefined();
      expect(uploadV2).toHaveBeenCalledTimes(1);
      expect(store.delete).toHaveBeenCalledWith('TEST-1');
    });

    it('summary의 영구 에러(postMessage) 시 즉시 throw하고 큐에서 삭제한다', async () => {
      const record = makeRecord();
      const store = makeStore(record);
      const client = {
        files: { uploadV2: vi.fn() },
        chat: {
          postMessage: vi.fn().mockRejectedValue({ data: { error: 'invalid_auth' } }),
        },
      } as unknown as WebClient;
      const sender = new DiffSender(client, store, { interFileDelayMs: 0 });

      await expect(sender.sendPendingDiffs('TEST-1')).rejects.toBeDefined();
      expect(client.files.uploadV2).not.toHaveBeenCalled();
      expect(store.delete).toHaveBeenCalledWith('TEST-1');
    });
  });
});
