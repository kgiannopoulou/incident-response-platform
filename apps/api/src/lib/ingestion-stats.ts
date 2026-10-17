// In-memory latency / throughput record of POST /alerts, for the System page
// and the load test. Per API process: each instance reports what it served.
//
// A fixed-size ring buffer, so memory is bounded however busy ingestion gets;
// percentiles are computed over the samples still inside the window. At the
// default 5,000 samples that is exact up to ~16 alerts/s over 5 minutes and a
// recent-sample estimate above it (the window then reports what it covers).

export type IngestionSample = { at: number; ms: number; status: number; decision: string | null };

export type IngestionSummary = {
  windowSeconds: number;
  // Seconds actually covered by the samples (shorter when the buffer wrapped).
  coveredSeconds: number;
  count: number;
  perSecond: number;
  errors: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number } | null;
  decisions: Record<string, number>;
  sinceStart: { count: number; errors: number; startedAt: string };
};

export class IngestionStats {
  private readonly samples: (IngestionSample | undefined)[];
  private next = 0;
  private total = 0;
  private totalErrors = 0;
  private readonly startedAt = new Date();

  constructor(private readonly capacity = 5_000, private readonly clock: () => number = Date.now) {
    this.samples = new Array(capacity);
  }

  record(ms: number, status: number, decision: string | null = null) {
    this.samples[this.next] = { at: this.clock(), ms, status, decision };
    this.next = (this.next + 1) % this.capacity;
    this.total++;
    if (status >= 500) this.totalErrors++;
  }

  summary(windowSeconds = 300): IngestionSummary {
    const now = this.clock();
    const from = now - windowSeconds * 1000;
    const inWindow = this.samples.filter((s): s is IngestionSample => s !== undefined && s.at >= from);
    const latencies = inWindow.map((s) => s.ms).sort((a, b) => a - b);
    const decisions: Record<string, number> = {};
    for (const s of inWindow) if (s.decision) decisions[s.decision] = (decisions[s.decision] ?? 0) + 1;
    const oldest = inWindow.reduce((min, s) => Math.min(min, s.at), now);
    const covered = inWindow.length ? Math.max(1, (now - oldest) / 1000) : windowSeconds;
    return {
      windowSeconds,
      coveredSeconds: Math.round(covered),
      count: inWindow.length,
      perSecond: round(inWindow.length / covered),
      errors: inWindow.filter((s) => s.status >= 500).length,
      latencyMs: latencies.length
        ? {
            p50: round(percentile(latencies, 50)),
            p95: round(percentile(latencies, 95)),
            p99: round(percentile(latencies, 99)),
            max: round(latencies[latencies.length - 1]),
          }
        : null,
      decisions,
      sinceStart: { count: this.total, errors: this.totalErrors, startedAt: this.startedAt.toISOString() },
    };
  }
}

// Nearest-rank percentile over an ascending array.
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
