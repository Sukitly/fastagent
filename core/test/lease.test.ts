import { describe, expect, it } from "vitest";
import { inProcessLease } from "../src/index.ts";

describe("inProcessLease (fail-fast 单写者)", () => {
  it("同 session 已占用 → 第二次 tryAcquire 返回 null(不排队)", () => {
    const lease = inProcessLease();
    const r1 = lease.tryAcquire("s");
    expect(r1).not.toBeNull();
    expect(lease.tryAcquire("s")).toBeNull(); // busy
    r1!();
    expect(lease.tryAcquire("s")).not.toBeNull(); // 释放后可再取
  });

  it("不同 session 互不影响", () => {
    const lease = inProcessLease();
    expect(lease.tryAcquire("a")).not.toBeNull();
    expect(lease.tryAcquire("b")).not.toBeNull(); // b 不受 a 占用影响
  });

  it("release 幂等,且不误放他人", () => {
    const lease = inProcessLease();
    const r = lease.tryAcquire("s")!;
    r();
    r(); // 重复 release 安全
    const r2 = lease.tryAcquire("s")!; // 仍能正常取得
    expect(r2).not.toBeNull();
    // 旧 release 再调不应释放 r2 持有的锁
    r();
    expect(lease.tryAcquire("s")).toBeNull(); // r2 仍持有
  });
});
