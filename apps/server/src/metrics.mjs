// Rolling-window rates for tokens / tool calls / errors.
//
// Token totals only arrive when DSH rewrites the projcache (roughly at every
// step boundary), so the collector feeds *deltas* here and the wire value is a
// smoothed tokens-per-second over the last 60 s.

export class RateTracker {
  /**
   * @param {{windowMs?:number, minSpanMs?:number, startAt?:number}} [opts]
   */
  constructor({ windowMs = 60_000, minSpanMs = 5_000, startAt = Date.now() } = {}) {
    this.windowMs = windowMs;
    this.minSpanMs = minSpanMs;
    this.startedAt = startAt;
    /** @type {{ts:number,tokens:number,tools:number,errors:number}[]} */
    this.samples = [];
    this.totals = { tokens: 0, tools: 0, errors: 0 };
  }

  /** Record deltas observed at `ts` (epoch ms). */
  add(ts, { tokens = 0, tools = 0, errors = 0 } = {}) {
    if (tokens <= 0 && tools <= 0 && errors <= 0) return;
    this.samples.push({ ts, tokens, tools, errors });
    this.prune(ts);
  }

  /** Record a delta of `n` tokens measured between two totals. */
  addTokens(ts, n) {
    if (n > 0) this.add(ts, { tokens: n });
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    // Samples arrive from several files/streams, so they are not strictly
    // sorted by ts: filter the whole array instead of trimming a prefix.
    if (this.samples.length && this.samples[0].ts < cutoff) {
      this.samples = this.samples.filter((s) => s.ts >= cutoff);
    }
  }

  /** Window span in seconds used to normalise sums: the age of the oldest
   *  sample still inside the window, clamped to [minSpan, window]. */
  spanSec(now) {
    const oldest = this.samples.length ? this.samples[0].ts : now;
    const elapsed = Math.max(0, now - oldest);
    return Math.max(this.minSpanMs, Math.min(this.windowMs, elapsed)) / 1000;
  }

  /** Totals of the samples currently inside the window. */
  sum(now) {
    this.prune(now);
    let tokens = 0;
    let tools = 0;
    let errors = 0;
    for (const s of this.samples) {
      tokens += s.tokens;
      tools += s.tools;
      errors += s.errors;
    }
    return { tokens, tools, errors };
  }

  sumTokens(now) {
    this.prune(now);
    let tokens = 0;
    for (const s of this.samples) tokens += s.tokens;
    return tokens;
  }

  tokensPerSec(now) {
    return this.sumTokens(now) / this.spanSec(now);
  }

  toolsPerSec(now) {
    this.prune(now);
    let tools = 0;
    for (const s of this.samples) tools += s.tools;
    return tools / this.spanSec(now);
  }

  tokensPerMin(now) {
    return this.tokensPerSec(now) * 60;
  }

  toolsPerMin(now) {
    return this.toolsPerSec(now) * 60;
  }
}
