/** 一个用户的浏览器锁。同一时间只跑一个 bot 的一段浏览器操作。 */
export class UserBrowserLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const run = this.tail.then(action, action);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
