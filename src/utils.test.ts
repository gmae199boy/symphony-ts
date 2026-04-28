import { describe, it, expect } from 'vitest';
import { formatIssueLabel } from './utils.js';

describe('formatIssueLabel', () => {
  it('식별자와 제목을 "(제목)" 형식으로 합친다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '슬랙 메시지 포맷 변경' }))
      .toBe('TEST-1 (슬랙 메시지 포맷 변경)');
  });

  it('title이 빈 문자열이면 identifier만 반환한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '' }))
      .toBe('TEST-1');
  });

  it('title이 공백만 있으면 identifier만 반환한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '   ' }))
      .toBe('TEST-1');
  });

  it('title 앞뒤 공백을 제거한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '  포맷 변경  ' }))
      .toBe('TEST-1 (포맷 변경)');
  });

  it('mrkdwn bold/italic/strike 메타문자를 제거한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '*bold* _italic_ ~strike~' }))
      .toBe('TEST-1 (bold italic strike)');
  });

  it('backtick 코드 스팬을 제거한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '`code`' }))
      .toBe('TEST-1 (code)');
  });

  it('Slack 링크 토큰 < > 을 HTML 엔티티로 이스케이프한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '<https://example.com|클릭>' }))
      .toBe('TEST-1 (&lt;https://example.com|클릭&gt;)');
  });

  it('& 를 &amp; 로 이스케이프한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: 'A & B' }))
      .toBe('TEST-1 (A &amp; B)');
  });

  it('Slack mention 토큰 <!channel> 을 제거한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '<!channel> 공지' }))
      .toBe('TEST-1 (공지)');
  });

  it('이모지 shortcode를 제거한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: ':white_check_mark: 완료' }))
      .toBe('TEST-1 (완료)');
  });

  it('유니코드 신호용 이모지를 제거한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: '✅ 승인' }))
      .toBe('TEST-1 (승인)');
  });

  it('대괄호를 제거해 라벨 경계 모호성을 방지한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: 'foo] bar [baz' }))
      .toBe('TEST-1 (foo bar baz)');
  });

  it('control character를 공백으로 치환한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: 'line1\nline2' }))
      .toBe('TEST-1 (line1 line2)');
  });

  it('정제 후 title이 비어있으면 identifier만 반환한다', () => {
    expect(formatIssueLabel({ identifier: 'TEST-1', title: ':x: ✅ *_~`[]' }))
      .toBe('TEST-1');
  });
});
