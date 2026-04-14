// ── Report data types ─────────────────────────────────────────────────
// Simplified data model for the static HTML report template.
// Produced by parse-target.ts, consumed by report-template.html.

export interface ReportData {
  target: {
    name: string;
    description: string;
    model: string;
    evalQueries: string;
  };

  baseline: {
    cost: number;
    latency: number;
    quality: number;
    qualityBreakdown?: {
      correctness: number;
      relevance: number;
      effectiveness: number;
    };
  };

  currentBest: {
    cost: number;
    latency: number;
    quality: number;
    deltas: { cost: string; latency: string; quality: string };
  };

  /** Ordered iteration entries — drives the journey chart and iteration list */
  iterations: ReportIteration[];

  /** Re-baseline eval markers on the journey chart (amber dashed lines) */
  rebaselineEvents: RebaselineMarker[];

  activeOptimizations: string[];
  learnedPrinciples: string[];

  /** ISO timestamp when the report was generated */
  generatedAt: string;

  /** "optimize" = full run with iterations, "eval" = baseline-only report */
  mode: "optimize" | "eval";

  /** Per-query breakdown from the most recent eval (for eval-mode reports) */
  queryDetails?: QuerySummary[];
}

export interface ReportIteration {
  index: number;
  name: string;
  status: "accepted" | "rejected";
  strategy: string;
  delta: string;
  insight: string;
  /** Absolute metrics after this iteration's eval */
  metrics: {
    cost: number;
    latency: number;
    quality: number;
  } | null;
}

export interface RebaselineMarker {
  afterIterIndex: number;
  cost: number;
  latency: number;
  quality: number;
}

export interface QuerySummary {
  query: string;
  cost: number;
  quality: number;
  latency: number;
  tokens: number;
  steps: number;
}
