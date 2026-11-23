/** 序列化非同步 mutation，並在 shutdown 開始後拒絕新工作。 */
export class SerialTaskQueue {
  /** 一律成功 settled 的 promise tail，使後續 task 可繼續。 */
  #tail = Promise.resolve();
  /** close 阻擋新工作後為 true。 */
  #closed = false;
  /** close 開始後有工作進入時回報的錯誤。 */
  readonly #closedMessage: string;

  constructor(closedMessage: string) {
    this.#closedMessage = closedMessage;
  }

  /** 在目前 tail 後排入工作，並跨失敗保持順序。 */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(this.#closedMessage));
    const result = this.#tail.then(work, work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 阻擋新工作並等待既有 tail；僅第一個 closer 回傳 true。 */
  async close(): Promise<boolean> {
    if (this.#closed) {
      await this.#tail;
      return false;
    }
    this.#closed = true;
    await this.#tail;
    return true;
  }
}
