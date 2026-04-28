/**
 * ContainerAdmissionSet — 이슈(=컨테이너) 단위의 admission 집합.
 *
 * 이슈 identifier를 키로 관리하므로 같은 이슈의 재-dispatch(리뷰, PR 피드백, recovery)는
 * 추가 슬롯을 소비하지 않는다. 슬롯은 컨테이너가 제거될 때(terminal state cleanup)까지 유지된다.
 * 프로세스 재기동 시에는 기존 컨테이너/워크스페이스 목록으로 prefill하여 상태를 복원한다.
 */

export class ContainerAdmissionSet {
  private readonly admitted = new Set<string>();

  constructor(private readonly max: number) {}

  /**
   * 이슈를 admission set에 추가한다.
   * 이미 추가된 이슈에 대해서는 idempotent(= true 반환, 집합 크기 변화 없음).
   * 새 이슈인데 cap을 초과하면 false 반환.
   */
  admit(identifier: string): boolean {
    if (this.admitted.has(identifier)) return true;
    if (this.admitted.size >= this.max) return false;
    this.admitted.add(identifier);
    return true;
  }

  /**
   * cap을 무시하고 강제로 admit한다.
   * 재기동/핫 리로드 시 기존 컨테이너를 복원할 때 사용 (over-commit 허용).
   * 새로 추가되어 over-commit이 발생한 경우 true를 반환한다.
   */
  forceAdmit(identifier: string): boolean {
    const wasNew = !this.admitted.has(identifier);
    this.admitted.add(identifier);
    return wasNew && this.admitted.size > this.max;
  }

  /** 이슈를 admission set에서 제거한다. 없는 identifier에 대한 호출은 무해하다. */
  release(identifier: string): void {
    this.admitted.delete(identifier);
  }

  /** 이슈가 현재 admitted 상태인지 확인한다. */
  has(identifier: string): boolean {
    return this.admitted.has(identifier);
  }

  /** 현재 admitted된 이슈 수. */
  size(): number {
    return this.admitted.size;
  }

  /** 추가로 admit할 수 있는 여유 슬롯 수. */
  available(): number {
    return Math.max(0, this.max - this.admitted.size);
  }

  /** 진단·전이용 스냅샷. */
  snapshot(): string[] {
    return [...this.admitted];
  }

  /** 최대 컨테이너 수. */
  get maxContainers(): number {
    return this.max;
  }
}

/** @deprecated Use ContainerAdmissionSet */
export const ConcurrencyLimiter = ContainerAdmissionSet;
