/** Runs async jobs with at most `concurrency` in flight, starting them in the order they were added. */
export class JobQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`JobQueue: bad concurrency ${concurrency}`);
  }

  /** Jobs running or waiting. */
  get size(): number {
    return this.active + this.waiting.length;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active++;
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.waiting.shift()?.();
          });
      };
      if (this.active < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}
