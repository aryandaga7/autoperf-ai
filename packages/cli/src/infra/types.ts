/** Parsed JSON output from the final `type: "result"` event in stream-json */
export interface CCResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string | null;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

/**
 * A single NDJSON event from `--output-format stream-json`.
 *
 * We only type the fields we actually use. The full event may contain
 * additional properties (hook info, rate limits, etc.) which we preserve
 * in the raw trace but don't parse.
 */
export interface StreamEvent {
  type: string;
  subtype?: string;
  /** Present on assistant events — contains content blocks (text, tool_use, thinking) */
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  /** Present on the final result event */
  is_error?: boolean;
  result?: string | null;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Return value from runClaudeCode — the final result plus the full event stream */
export interface CCRunResult {
  result: CCResult;
  events: StreamEvent[];
}
