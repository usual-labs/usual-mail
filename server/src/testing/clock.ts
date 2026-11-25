// A clock and scheduler that only move when told to, so tests can step through come-back times and polls.

import type { Clock, Scheduler } from "../host.ts";

export class ManualClock implements Clock, Scheduler {
  #now: number;
  /** Time the machine slept (`sleep`), which `monotonic` doesn't count. */
  #slept = 0;
  #timers: Array<{ at: number; run: () => void; id: number }> = [];
  #next = 0;

  constructor(start: number | string) {
    this.#now = typeof start === "string" ? Date.parse(start) : start;
  }

  now(): number {
    return this.#now;
  }

  monotonic(): number {
    return this.#now - this.#slept;
  }

  /**
   * The machine sleeps for `ms`: the wall clock jumps, the monotonic one doesn't, and every timer falls due that much
   * later, as Node's timers do after a Mac sleeps. Nothing runs meanwhile.
   */
  sleep(ms: number): void {
    this.#now += ms;
    this.#slept += ms;
    for (const timer of this.#timers) timer.at += ms;
  }

  setTimer(delayMs: number, run: () => void): () => void {
    const id = ++this.#next;
    this.#timers.push({ at: this.#now + Math.max(0, delayMs), run, id });
    return () => {
      this.#timers = this.#timers.filter((timer) => timer.id !== id);
    };
  }

  /** Moves time forward, running each timer that falls due, in time order. */
  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((timer) => timer !== due);
      this.#now = Math.max(this.#now, due.at);
      due.run();
    }
    this.#now = until;
  }

  set(time: number | string): void {
    this.advance((typeof time === "string" ? Date.parse(time) : time) - this.#now);
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }
}
