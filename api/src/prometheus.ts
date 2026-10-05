/**
 * Minimal Prometheus text exposition parser for the Judge's /metrics
 * (judge/src/metrics.ts: judge_evaluate_duration_seconds histogram, judge_decisions_total counter).
 */

export type Sample = { name: string; labels: Record<string, string>; value: number };

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parsePrometheus(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m?.[1] || m[4] === undefined) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[3] ?? "").matchAll(LABEL)) if (l[1] !== undefined && l[2] !== undefined) labels[l[1]] = l[2];
    const value = m[4] === "+Inf" ? Infinity : Number(m[4]);
    if (!Number.isNaN(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

/** Quantile from cumulative histogram buckets (le -> count), linear inside the bucket, like histogram_quantile. */
export function histogramQuantile(q: number, buckets: Map<number, number>): number | null {
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted[sorted.length - 1]?.[1] ?? 0;
  if (total === 0) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, count] of sorted) {
    if (count >= rank) {
      if (le === Infinity) return prevLe;
      const inBucket = count - prevCount;
      return inBucket === 0 ? le : prevLe + ((le - prevLe) * (rank - prevCount)) / inBucket;
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

export type JudgeScrape = {
  /** Cumulative evaluate latency buckets over definitive outcomes (seconds -> count). */
  buckets: Map<number, number>;
  samples: number;
  pass: number;
  fail: number;
  byReason: Record<string, number>;
};

export function judgeScrape(samples: readonly Sample[]): JudgeScrape {
  const buckets = new Map<number, number>();
  let count = 0;
  let pass = 0;
  let fail = 0;
  const byReason: Record<string, number> = {};
  for (const s of samples) {
    if (s.name === "judge_evaluate_duration_seconds_bucket" && ["PASS", "FAIL", "PENDING"].includes(s.labels.outcome ?? "")) {
      const le = s.labels.le === "+Inf" ? Infinity : Number(s.labels.le);
      buckets.set(le, (buckets.get(le) ?? 0) + s.value);
    } else if (s.name === "judge_evaluate_duration_seconds_count" && ["PASS", "FAIL", "PENDING"].includes(s.labels.outcome ?? "")) {
      count += s.value;
    } else if (s.name === "judge_decisions_total") {
      if (s.labels.decision === "PASS") pass += s.value;
      if (s.labels.decision === "FAIL") fail += s.value;
      const r = s.labels.reason;
      if (r) byReason[r] = (byReason[r] ?? 0) + s.value;
    }
  }
  return { buckets, samples: count, pass, fail, byReason };
}
