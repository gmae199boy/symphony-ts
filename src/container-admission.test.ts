/**
 * ContainerAdmissionSet 단위 테스트
 */

import { describe, it, expect } from 'vitest';
import { ContainerAdmissionSet } from './concurrency-limiter.js';

describe('ContainerAdmissionSet', () => {
  describe('admit()', () => {
    it('cap 미만일 때 새 identifier를 추가하고 true 반환', () => {
      const set = new ContainerAdmissionSet(3);
      expect(set.admit('PROJ-1')).toBe(true);
      expect(set.size()).toBe(1);
    });

    it('이미 admitted된 identifier에 대해 idempotent (true 반환, 크기 변화 없음)', () => {
      const set = new ContainerAdmissionSet(3);
      set.admit('PROJ-1');
      expect(set.admit('PROJ-1')).toBe(true);
      expect(set.size()).toBe(1);
    });

    it('cap 초과 시 false 반환하고 집합에 추가하지 않음', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.admit('PROJ-2');
      expect(set.admit('PROJ-3')).toBe(false);
      expect(set.size()).toBe(2);
    });

    it('cap 경계값: 정확히 max개까지 허용', () => {
      const set = new ContainerAdmissionSet(1);
      expect(set.admit('PROJ-1')).toBe(true);
      expect(set.admit('PROJ-2')).toBe(false);
    });
  });

  describe('release()', () => {
    it('admitted된 identifier를 제거한다', () => {
      const set = new ContainerAdmissionSet(3);
      set.admit('PROJ-1');
      set.release('PROJ-1');
      expect(set.has('PROJ-1')).toBe(false);
      expect(set.size()).toBe(0);
    });

    it('존재하지 않는 identifier에 대한 호출은 무해하다', () => {
      const set = new ContainerAdmissionSet(3);
      expect(() => set.release('PROJ-999')).not.toThrow();
    });

    it('release 후 슬롯이 확보되어 새 identifier를 admit할 수 있다', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.admit('PROJ-2');
      set.release('PROJ-1');
      expect(set.admit('PROJ-3')).toBe(true);
      expect(set.size()).toBe(2);
    });
  });

  describe('forceAdmit()', () => {
    it('cap을 초과해서도 강제 추가한다', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.admit('PROJ-2');
      set.forceAdmit('PROJ-3'); // over-commit
      expect(set.has('PROJ-3')).toBe(true);
      expect(set.size()).toBe(3);
    });

    it('이미 admitted된 identifier에 대해서도 무해하다', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.forceAdmit('PROJ-1');
      expect(set.size()).toBe(1);
    });
  });

  describe('available()', () => {
    it('빈 집합에서 max를 반환한다', () => {
      const set = new ContainerAdmissionSet(5);
      expect(set.available()).toBe(5);
    });

    it('전체 cap 사용 시 0을 반환한다', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.admit('PROJ-2');
      expect(set.available()).toBe(0);
    });

    it('over-commit 시에도 음수가 아닌 0을 반환한다', () => {
      const set = new ContainerAdmissionSet(2);
      set.forceAdmit('PROJ-1');
      set.forceAdmit('PROJ-2');
      set.forceAdmit('PROJ-3');
      expect(set.available()).toBe(0);
    });
  });

  describe('snapshot()', () => {
    it('현재 admitted된 identifier 목록을 반환한다', () => {
      const set = new ContainerAdmissionSet(5);
      set.admit('PROJ-1');
      set.admit('PROJ-2');
      const snap = set.snapshot();
      expect(snap).toHaveLength(2);
      expect(snap).toContain('PROJ-1');
      expect(snap).toContain('PROJ-2');
    });

    it('빈 집합에서는 빈 배열을 반환한다', () => {
      const set = new ContainerAdmissionSet(5);
      expect(set.snapshot()).toEqual([]);
    });
  });

  describe('maxContainers', () => {
    it('생성 시 설정한 max 값을 반환한다', () => {
      const set = new ContainerAdmissionSet(7);
      expect(set.maxContainers).toBe(7);
    });
  });

  describe('forceAdmit() — return value', () => {
    it('cap 내에서 새로 추가 시 false 반환 (over-commit 없음)', () => {
      const set = new ContainerAdmissionSet(3);
      expect(set.forceAdmit('PROJ-1')).toBe(false);
    });

    it('cap 초과 강제 추가 시 true 반환 (over-commit 발생)', () => {
      const set = new ContainerAdmissionSet(1);
      set.admit('PROJ-1');
      expect(set.forceAdmit('PROJ-2')).toBe(true);
    });

    it('이미 admitted된 identifier는 false 반환 (크기 변화 없음)', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      expect(set.forceAdmit('PROJ-1')).toBe(false);
      expect(set.size()).toBe(1);
    });

    it('forceAdmit → release → available()이 cap 내로 회복된다', () => {
      const set = new ContainerAdmissionSet(2);
      set.forceAdmit('PROJ-1');
      set.forceAdmit('PROJ-2');
      set.forceAdmit('PROJ-3'); // over-commit
      set.release('PROJ-1');
      expect(set.size()).toBe(2);
      expect(set.available()).toBe(0);
      set.release('PROJ-2');
      expect(set.available()).toBe(1);
    });
  });

  describe('경계 동작', () => {
    it('cap 가득 + 이미 admitted identifier 재admit → true + size 불변', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.admit('PROJ-2');
      expect(set.admit('PROJ-1')).toBe(true);
      expect(set.size()).toBe(2);
    });

    it('forceAdmit 후 신규 identifier admit → cap 초과 시 false', () => {
      const set = new ContainerAdmissionSet(2);
      set.forceAdmit('PROJ-1');
      set.forceAdmit('PROJ-2');
      set.forceAdmit('PROJ-3'); // over-commit
      expect(set.admit('PROJ-4')).toBe(false);
    });

    it('동일 identifier 여러 번 release 시 상태 일관성 유지', () => {
      const set = new ContainerAdmissionSet(3);
      set.admit('PROJ-1');
      set.release('PROJ-1');
      set.release('PROJ-1'); // 두 번째 release는 무해
      expect(set.size()).toBe(0);
      expect(set.has('PROJ-1')).toBe(false);
    });

    it('admit → release → admit cycle이 true 반환', () => {
      const set = new ContainerAdmissionSet(2);
      set.admit('PROJ-1');
      set.release('PROJ-1');
      expect(set.admit('PROJ-1')).toBe(true);
      expect(set.size()).toBe(1);
    });
  });
});
