import { execa } from "execa";
import type { CCResult, CCRunResult, StreamEvent } from "./types.js";

const DEFAULT_CC_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — circuit breaker for true hangs

export class CCTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Claude Code timed out after ${(timeoutMs / 1000 / 60).toFixed(0)} minutes`,
    );
    this.name = "CCTimeoutError";
  }
}

/**
 * Parse NDJSON stdout from `--output-format stream-json` into typed events.
 * Skips malformed lines (e.g., if CC crashes mid-write).
 */
function parseStreamEvents(stdout: string): StreamEvent[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StreamEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is StreamEvent => e !== null);
}

/**
 * Extract the final result event from the stream and convert to CCResult.
 * Falls back to constructing an error result if no result event is found.
 */
function extractResult(events: StreamEvent[]): CCResult {
  const resultEvent = events.find((e) => e.type === "result");
  if (resultEvent) {
    return {
      type: resultEvent.type,
      subtype: resultEvent.subtype ?? "success",
      is_error: resultEvent.is_error ?? false,
      result: resultEvent.result ?? null,
      duration_ms: resultEvent.duration_ms ?? 0,
      duration_api_ms: resultEvent.duration_api_ms ?? 0,
      num_turns: resultEvent.num_turns ?? 0,
      session_id: resultEvent.session_id ?? "",
      total_cost_usd: resultEvent.total_cost_usd ?? 0,
      usage: {
        input_tokens: resultEvent.usage?.input_tokens ?? 0,
        output_tokens: resultEvent.usage?.output_tokens ?? 0,
        cache_creation_input_tokens:
          resultEvent.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens:
          resultEvent.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }

  // No result event — CC probably crashed. Build a minimal error result.
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    result: null,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    session_id: "",
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export async function runClaudeCode(opts: {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  systemPrompt?: string;
  mcpConfigPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CCRunResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_CC_TIMEOUT_MS;

  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--effort", opts.effort);
  }
  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }
  // Strip ANTHROPIC_API_KEY so CC uses the user's own auth (Max subscription
  // or API key configured via `claude auth login`) instead of API billing.
  // Preserve the key as _ANTHROPIC_API_KEY so child Bash commands
  // (e.g., test-run.ts) can still access it for target agent runs.
  //
  // CRITICAL: extendEnv must be false. Execa defaults to extendEnv:true
  // which merges { ...process.env, ...env } — re-injecting the key we
  // deleted from the copy. With extendEnv:false, only our env object is used.
  const env = { ...process.env };
  if (env.ANTHROPIC_API_KEY) {
    env._ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY;
  }

  const result = await execa("npx", ["@anthropic-ai/claude-code", ...args], {
    input: opts.prompt,
    cwd: opts.cwd,
    env,
    extendEnv: false,
    timeout,
    reject: false,
    cancelSignal: opts.signal,
  });

  // Check timeout first — execa sets timedOut on the result object
  if (result.timedOut) {
    throw new CCTimeoutError(timeout);
  }

  if (result.isCanceled) {
    throw new Error("Claude Code subprocess was cancelled (SIGINT)");
  }

  // Parse the NDJSON stream
  const events = parseStreamEvents(result.stdout);
  const parsed = extractResult(events);

  // If no events at all and non-zero exit, something went very wrong
  if (events.length === 0 && result.exitCode !== 0) {
    throw new Error(
      `Claude Code exited with code ${result.exitCode}: ${result.stderr}`,
    );
  }

  if (parsed.is_error) {
    throw new Error(`Claude Code error: ${parsed.result ?? "unknown error"}`);
  }

  // Handle max_turns / null result: include subtype for better diagnostics
  if (parsed.result === null || parsed.result === undefined) {
    const reason =
      parsed.subtype === "error_max_turns"
        ? "hit max turns limit — increase --cc-max-turns"
        : "null result (agent stopped without producing output)";
    throw new Error(`Claude Code: ${reason}`);
  }

  return { result: parsed, events };
}
