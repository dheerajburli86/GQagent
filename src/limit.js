"use strict";
// A counting semaphore with hand-off: when a slot frees up it passes straight to
// the next waiter, so a newcomer can never jump the queue or overfill the limit.
// Used to bound how many model calls run at once across every person and channel.
class Semaphore {
  constructor(max) { this.max = Math.max(1, max | 0); this.active = 0; this.queue = []; }
  get waiting() { return this.queue.length; }
  async run(fn) {
    if (this.active < this.max) this.active++;
    else await new Promise((resolve) => this.queue.push(resolve)); // the slot is handed over, already counted
    try { return await fn(); }
    finally {
      const next = this.queue.shift();
      if (next) next(); else this.active--;
    }
  }
}

/** Wraps a provider so every chat() call takes a slot. */
function limitProvider(provider, sem) {
  if (!provider) return provider;
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get lastModel() { return provider.lastModel || provider.model; },
    chat: (args) => sem.run(() => provider.chat(args)),
  };
}

module.exports = { Semaphore, limitProvider };
