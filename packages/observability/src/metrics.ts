/**
 * Minimal Prometheus-text metrics registry (PRD §13) — counters and gauges
 * with label validation, renderable at /metrics. Kept dependency-free: the
 * deployment is single-node; relabeling happens in the scraper if needed.
 */
type Labels = Readonly<Record<string, string | number>>;

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const body = entries
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
  return `{${body}}`;
}

function keyOf(name: string, labels: Labels): string {
  return `${name}${formatLabels(labels)}`;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly help = new Map<string, string>();
  private readonly counterNames = new Set<string>();
  private readonly gaugeNames = new Set<string>();

  counter(name: string, help: string): void {
    this.counterNames.add(name);
    this.help.set(name, help);
  }

  gauge(name: string, help: string): void {
    this.gaugeNames.add(name);
    this.help.set(name, help);
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const key = keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(keyOf(name, labels), value);
  }

  /** Observe a duration in seconds into a counter+count pair. */
  observe(name: string, labels: Labels, startMs: number): void {
    this.inc(name, labels);
    this.inc(`${name}_seconds_total`, labels, (Date.now() - startMs) / 1000);
  }

  render(): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    const emit = (name: string, kind: "counter" | "gauge"): void => {
      if (seen.has(name)) {
        return;
      }
      seen.add(name);
      const help = this.help.get(name);
      if (help !== undefined) {
        lines.push(`# HELP ${name} ${help}`);
      }
      lines.push(`# TYPE ${name} ${kind}`);
    };

    for (const [key, value] of this.counters) {
      const name = key.split("{")[0] ?? key;
      emit(name, "counter");
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      const name = key.split("{")[0] ?? key;
      emit(name, "gauge");
      lines.push(`${key} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

const globalForMetrics = globalThis as unknown as { __hoodmintMetrics?: MetricsRegistry };

export function metrics(): MetricsRegistry {
  if (globalForMetrics.__hoodmintMetrics === undefined) {
    const registry = new MetricsRegistry();
    // PRD §13 minimum metric set (names follow the hoodmint_ prefix).
    registry.counter("hoodmint_scans_total", "Discovery scans by provider and outcome");
    registry.counter("hoodmint_scans_seconds_total", "Cumulative scan duration");
    registry.counter("hoodmint_provider_errors_total", "Provider errors by category");
    registry.counter("hoodmint_eligibility_verdicts_total", "Eligibility verdicts by status");
    registry.counter("hoodmint_alerts_total", "Alert deliveries by channel and outcome");
    registry.counter("hoodmint_jobs_retries_total", "Job retries by queue");
    registry.gauge("hoodmint_rate_limit_remaining", "Provider rate-limit remaining");
    registry.gauge("hoodmint_provider_freshness_seconds", "Seconds since provider last success");
    registry.gauge("hoodmint_chain_checkpoint", "Latest synced block per chain");
    registry.gauge("hoodmint_rpc_lag_blocks", "RPC head minus checkpoint");
    registry.gauge("hoodmint_queue_depth", "Queue waiting job count");
    registry.gauge("hoodmint_queue_age_seconds", "Oldest waiting job age");
    registry.gauge("hoodmint_db_pool_active", "Active DB pool connections");
    registry.gauge("hoodmint_sse_clients", "Connected SSE clients");
    globalForMetrics.__hoodmintMetrics = registry;
  }
  return globalForMetrics.__hoodmintMetrics;
}
