import { describe, expect, it } from 'vitest';
import { AdminPasswords, HashGate, HashGateFullError } from '../src/admin/hashing.js';
import { HttpProblem } from '../src/lib/problem.js';
import { CHEAP_ARGON2 } from './adminSupport.js';

/**
 * The Argon2 gate of the API process: at most `concurrency` hashes at once,
 * `queue` more waiting in arrival order, and a refusal at once past that,
 * so a flood of logins cannot hold libuv's thread pool (DNS, files, SCRAM).
 */

interface Pending {
  started: boolean;
  release: () => void;
}

function job(log: string[], name: string): { pending: Pending; work: () => Promise<string> } {
  const pending: Pending = { started: false, release: () => undefined };
  const work = () =>
    new Promise<string>((resolve) => {
      pending.started = true;
      log.push(`start ${name}`);
      pending.release = () => {
        log.push(`end ${name}`);
        resolve(name);
      };
    });
  return { pending, work };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('admin hash gate', () => {
  it('runs at most `concurrency` at once, queues in order, and refuses past the queue at once', async () => {
    const gate = new HashGate({ concurrency: 2, queue: 2 });
    const log: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((name) => job(log, name));
    const runs = jobs.map((j) => gate.run(j.work));
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    expect(gate.load).toEqual({ running: 2, waiting: 2 });
    // The fifth is refused without waiting.
    await expect(gate.run(async () => 'e')).rejects.toBeInstanceOf(HashGateFullError);

    jobs[1]!.pending.release();
    await tick();
    expect(log).toEqual(['start a', 'start b', 'end b', 'start c']);
    jobs[0]!.pending.release();
    await tick();
    expect(log.at(-1)).toBe('start d');
    expect(gate.load).toEqual({ running: 2, waiting: 0 });
    jobs[2]!.pending.release();
    jobs[3]!.pending.release();
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c', 'd']);
    expect(gate.load).toEqual({ running: 0, waiting: 0 });
  });

  it('frees the slot when the work fails', async () => {
    const gate = new HashGate({ concurrency: 1, queue: 0 });
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.load).toEqual({ running: 0, waiting: 0 });
    expect(await gate.run(async () => 7)).toBe(7);
  });

  it('refuses a bad size', () => {
    expect(() => new HashGate({ concurrency: 0, queue: 1 })).toThrow(RangeError);
    expect(() => new HashGate({ concurrency: 1, queue: -1 })).toThrow(RangeError);
  });

  it('answers 503 with Retry-After for a password operation the gate cannot take', async () => {
    const gate = new HashGate({ concurrency: 1, queue: 0 });
    const passwords = new AdminPasswords(CHEAP_ARGON2, gate);
    const log: string[] = [];
    const busy = job(log, 'busy');
    const holding = gate.run(busy.work);
    await tick();
    for (const attempt of [() => passwords.hash('correct horse battery'), () => passwords.verify('x', '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFndGFndGFndGFndGFndGFndGFndGFndGE'), () => passwords.burn('x')]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpProblem);
      expect((error as HttpProblem).statusCode).toBe(503);
      expect((error as HttpProblem).init.headers?.['retry-after']).toBe('5');
    }
    busy.pending.release();
    await holding;
    const hash = await passwords.hash('correct horse battery');
    expect(await passwords.verify('correct horse battery', hash)).toBe(true);
    expect(passwords.needsRehash(hash)).toBe(false);
  });
});
