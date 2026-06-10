/**
 * 单写者租约:同 session 同一时刻只允许一个在飞 turn(SPEC portable conformance 的并发面)。
 *
 * **争用策略 = fail-fast,不排队**:已被占用时 `tryAcquire` 返回 null,调用方据此产出
 * `failed{retryable:true}`("session busy")。这是个**只防写坏的地板**,不替场景选 UX——
 * dedupe / 排队 / steering 等是 channel/上层 的决策(它知道 trigger 语义)。
 *
 * 为什么不排队:同 session 并发的真实场景多是「重复意图」(去重)或「单用户连发」(steering),
 * 而非「两个真 turn」;FIFO 串跑只契合「多参与者」一种,且会引入无界队列 + 取消时的槽泄漏死锁。
 *
 * 同步、无 await:acquire 与进 try 之间无 await 交错 → 取消任意处都能在 finally 释放,无死锁。
 * 跨进程/多实例的分布式锁(TTL + fencing)以后另设接口,不在此。
 */
export type Release = () => void;

export interface Lease {
  /** 尝试独占该 session 的写权(fail-fast)。已被占用则返回 null,不排队。 */
  tryAcquire(session: string): Release | null;
}

/** 进程内单写者:per-session 占用标记。 */
export function inProcessLease(): Lease {
  const busy = new Set<string>();
  return {
    tryAcquire(session: string): Release | null {
      if (busy.has(session)) return null;
      busy.add(session);
      let released = false;
      return () => {
        if (released) return; // 幂等
        released = true;
        busy.delete(session);
      };
    },
  };
}
