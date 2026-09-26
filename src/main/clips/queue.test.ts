import { describe, expect, it } from 'vitest';
import { JobQueue } from './queue';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('JobQueue', () => {
  it('never runs more than `concurrency` jobs, and starts them in order', async () => {
    const q = new JobQueue(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await Promise.all(
      [30, 10, 20, 5, 15].map((ms, i) =>
        q.run(async () => {
          started.push(i);
          peak = Math.max(peak, ++running);
          await tick(ms);
          running--;
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(q.size).toBe(0);
  });

  it('keeps going after a job fails', async () => {
    const q = new JobQueue(1);
    const failing = q.run(async () => {
      throw new Error('boom');
    });
    const next = q.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
