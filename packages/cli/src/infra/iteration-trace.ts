import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamEvent } from "./types.js";

interface ToolCallSummary {
  name: string;
  inputPreview: string;
}

interface TraceSummary {
  toolCalls: ToolCallSummary[];
  filesRead: string[];
  filesEdited: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  numTurns: number;
}

/**
 * Extract a human-readable summary from the stream events.
 */
function summarizeEvents(events: StreamEvent[]): TraceSummary {
  const toolCalls: ToolCallSummary[] = [];
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let numTurns = 0;

  for (const event of events) {
    if (event.type === "assistant" && event.message?.content) {
      numTurns++;

      // Accumulate token usage from each assistant message
      if (event.message.usage) {
        totalInputTokens += event.message.usage.input_tokens ?? 0;
        totalOutputTokens += event.message.usage.output_tokens ?? 0;
      }

      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name) {
          const input = block.input ?? {};
          let inputPreview = "";

          // Build a useful preview depending on tool type
          if (block.name === "Read" && input.file_path) {
            inputPreview = String(input.file_path);
            filesRead.add(String(input.file_path));
          } else if (block.name === "Edit" && input.file_path) {
            inputPreview = String(input.file_path);
            filesEdited.add(String(input.file_path));
          } else if (block.name === "Write" && input.file_path) {
            inputPreview = String(input.file_path);
            filesEdited.add(String(input.file_path));
          } else if (block.name === "Bash" && input.command) {
            inputPreview = String(input.command).slice(0, 80);
          } else if (block.name === "Glob" && input.pattern) {
            inputPreview = String(input.pattern);
          } else if (block.name === "Grep" && input.pattern) {
            inputPreview = String(input.pattern);
          } else {
            inputPreview = JSON.stringify(input).slice(0, 80);
          }

          toolCalls.push({ name: block.name, inputPreview });
        }
      }
    }

    // Get totals from the result event
    if (event.type === "result") {
      totalDurationMs = event.duration_ms ?? 0;
      numTurns = event.num_turns ?? numTurns;
      if (event.usage) {
        totalInputTokens = event.usage.input_tokens ?? totalInputTokens;
        totalOutputTokens = event.usage.output_tokens ?? totalOutputTokens;
      }
    }
  }

  return {
    toolCalls,
    filesRead: [...filesRead],
    filesEdited: [...filesEdited],
    totalInputTokens,
    totalOutputTokens,
    totalDurationMs,
    numTurns,
  };
}

/**
 * Format tool call counts for console output.
 * e.g., "12 tools: 4×Read, 3×Edit, 2×Bash, 1×Grep, 2×Glob"
 */
export function formatToolSummary(events: StreamEvent[]): string {
  const summary = summarizeEvents(events);
  const counts = new Map<string, number>();
  for (const tc of summary.toolCalls) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
  }

  if (counts.size === 0) return "0 tools";

  const total = summary.toolCalls.length;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count}×${name}`);

  return `${total} tools: ${parts.join(", ")}`;
}

/**
 * Collect values of sensitive environment variables for redaction.
 * Returns only non-empty values that are long enough to avoid false positives.
 */
function getSensitiveValues(): string[] {
  const keys = [
    "ANTHROPIC_API_KEY",
    "_ANTHROPIC_API_KEY",
    "NIA_API_KEY",
    "CONTEXT7_API_KEY",
    "OPENAI_API_KEY",
  ];
  const values: string[] = [];
  for (const key of keys) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      values.push(val);
    }
  }
  return values;
}

/**
 * Deep-replace sensitive values in a JSON-serializable object.
 * Operates on the serialized JSON string to catch values in any position
 * (tool inputs, tool outputs, assistant text, etc.).
 */
function redactSensitiveValues(json: string): string {
  const secrets = getSensitiveValues();
  let redacted = json;
  for (const secret of secrets) {
    // Use split+join instead of regex to avoid special char issues in keys.
    while (redacted.includes(secret)) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

/**
 * Write a per-iteration trace file with raw events and extracted summary.
 *
 * Files go to `{traceDir}/iteration-{N}.json`.
 * Sensitive environment variable values are redacted from the output.
 */
export async function writeIterationTrace(
  iteration: number,
  events: StreamEvent[],
  traceDir: string,
): Promise<string> {
  await mkdir(traceDir, { recursive: true });

  const summary = summarizeEvents(events);
  const trace = {
    iteration,
    timestamp: new Date().toISOString(),
    summary,
    events,
  };

  const raw = JSON.stringify(trace, null, 2);
  const safe = redactSensitiveValues(raw);

  const filePath = join(traceDir, `iteration-${iteration}.json`);
  await writeFile(filePath, safe);
  return filePath;
}
