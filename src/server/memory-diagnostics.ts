import { getHeapStatistics } from 'node:v8';

const lastSamples = new Map<string, number>();

/** Opt-in aggregate diagnostics. Never log conversation content, paths, IDs, or credentials. */
export function recordMemoryDiagnostic(phase: string, metrics: Record<string, number> = {}): void {
  if (process.env.LOOM_MEMORY_DIAGNOSTICS !== '1') return;
  if (process.stderr.destroyed || process.stderr.writableLength > 64 * 1024) return;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(phase)) return;
  const timestamp = Date.now();
  if (timestamp - (lastSamples.get(phase) ?? 0) < 1_000) return;
  // Call sites use fixed phase names; keep diagnostics bounded even if one does not.
  if (!lastSamples.has(phase) && lastSamples.size >= 64) return;
  lastSamples.set(phase, timestamp);
  try {
    const memory = process.memoryUsage();
    const values = Object.fromEntries(
      Object.entries(metrics).filter(
        ([key, value]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && Number.isFinite(value),
      ),
    );
    process.stderr.write(
      `${JSON.stringify({
        event: 'loom_memory',
        timestamp: new Date(timestamp).toISOString(),
        phase,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        heapLimit: getHeapStatistics().heap_size_limit,
        metrics: values,
      })}\n`,
    );
  } catch {
    // Diagnostics must not turn a recoverable task or disconnected client into a failure.
  }
}
