/**
 * 单消费者异步队列 —— pi 双口(subscribe 推 + prompt 终值)专属的 push→pull 基建。
 * 它被 pi 的双口形状召唤:async-iterable 原生的引擎(如 claude SDK)不需要它。
 * 单线程 JS:push 与 drain 之间无 await 交错,无需锁。
 */
export class EventQueue<T> {
  private buffer: T[] = [];
  private wake?: () => void;

  push(item: T): void {
    this.buffer.push(item);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /**
   * 把已 push 的事件按序 yield,直到 `done` settle **且** 缓冲排空后停止。
   * 不 yield `done` 的结果——终局由调用方单独产出(toTerminal)。
   * `done` 的 reject 在这里被吞掉(调用方另行 `await run` 处理),避免 unhandled rejection。
   */
  async *drainUntil(done: Promise<unknown>): AsyncGenerator<T> {
    let settled = false;
    const onSettle = () => {
      settled = true;
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
    };
    const finished = done.then(onSettle, onSettle);

    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    await finished;
  }
}
