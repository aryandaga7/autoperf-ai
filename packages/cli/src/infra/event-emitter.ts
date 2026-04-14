import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// ── Event types ─────────────────────────────────────────────────────

/**
 * The 8 lifecycle event types for an autoperf optimization run.
 *
 * Run-level events (no iterationNumber):
 *   optimization:started   — run begins, includes target agent path + config
 *   baseline:completed     — baseline eval done, includes aggregate metrics
 *   optimization:completed — full run done, includes final vs baseline delta
 *
 * Iteration-level events (have iterationNumber):
 *   iteration:started      — iteration N begins, includes worktree ID + prompt summary
 *   eval:completed         — eval run finished, includes aggregate metrics + data path
 *   comparison:completed   — statistical comparison done, includes effect sizes + p-values
 *   decision:made          — accept/reject with reasoning
 *   iteration:completed    — iteration N done, includes metrics delta + cost
 */
export type AutoPerfEventType =
  | "optimization:started"
  | "baseline:completed"
  | "iteration:started"
  | "eval:completed"
  | "comparison:completed"
  | "decision:made"
  | "iteration:completed"
  | "optimization:completed";

export interface AutoPerfEvent {
  type: AutoPerfEventType;
  timestamp: string;
  /** Present on iteration-level events. */
  iterationNumber?: number;
  /** Event payload — varies by event type. */
  data: Record<string, unknown>;
}

// ── Event emitter ───────────────────────────────────────────────────

const EVENT_FILE = "autoperf-events.jsonl";

/**
 * Append-only NDJSON event emitter.
 *
 * Writes one JSON line per event to `{outputDir}/autoperf-events.jsonl`.
 * The dashboard tails this file via SSE for live updates.
 *
 * Usage:
 *   const emitter = new EventEmitter("/path/to/run-output");
 *   await emitter.emit({ type: "optimization:started", data: { target: "..." } });
 */
export class EventEmitter {
  private filePath: string;
  private initialized = false;

  constructor(outputDir: string) {
    this.filePath = join(outputDir, EVENT_FILE);
  }

  /** Get the path to the JSONL event file. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Emit a single event. Timestamp is added automatically.
   * Creates the output directory on first call.
   */
  async emit(event: Omit<AutoPerfEvent, "timestamp">): Promise<void> {
    if (!this.initialized) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.initialized = true;
    }

    const line = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    });

    await appendFile(this.filePath, line + "\n");
  }
}
