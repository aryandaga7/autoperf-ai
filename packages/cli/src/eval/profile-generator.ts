import { computeCost, getModelPricing } from "./pricing.js";
import type { EvalRunResult, QueryResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface AggregatedStep {
  stepNumber: number;
  queryCount: number;
  totalQueries: number;
  modelId: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheReadTokens: number;
  avgCacheWriteTokens: number;
  avgCost: number;
  avgLatencyMs: number;
  finishReason: string;
  toolCalls: string[];
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtCost(n: number): string {
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Generate a Markdown optimization profile from eval results.
 *
 * The profile presents FACTS about where cost, latency, and tokens
 * concentrate in the agent pipeline. It does NOT suggest optimizations.
 *
 * Design rationale: Vercel's Turborepo optimization research showed that
 * presenting profiling data as sorted Markdown tables (vs JSON or prose)
 * dramatically improved agent optimization suggestions. This format follows
 * that pattern adapted for AI agent cost/latency profiling.
 */
function generateProfile(result: EvalRunResult): string {
  const sections: string[] = [];

  sections.push("# Optimization Profile\n");

  const aggregatedSteps = aggregateSteps(result.queries);
  sections.push(generatePipelineSummary(result, aggregatedSteps));
  sections.push(generateOptimizationSignals(result, aggregatedSteps));

  if (aggregatedSteps.length > 0) {
    sections.push(generateCostBreakdown(aggregatedSteps, result));
    if (aggregatedSteps.length > 1) {
      sections.push(generateContextGrowth(aggregatedSteps));
    }
    sections.push(generateStepDistribution(result));
  }

  sections.push(generateToolUsage(result, aggregatedSteps));
  sections.push(generateModelUsage(result, aggregatedSteps));
  sections.push(generateQualityBreakdown(result));
  sections.push(generatePerQueryVariance(result));

  return sections.join("\n");
}

// ── Step aggregation ─────────────────────────────────────────────────────────

function aggregateSteps(queries: QueryResult[]): AggregatedStep[] {
  const successful = queries.filter((q) => !q.error);
  if (successful.length === 0) return [];

  const maxSteps = Math.max(...successful.map((q) => q.steps.length));
  const aggregated: AggregatedStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const stepsAtPos = successful
      .filter((q) => q.steps.length > i)
      .map((q) => q.steps[i]);

    if (stepsAtPos.length === 0) continue;

    const n = stepsAtPos.length;

    // Most common model at this step position
    const modelCounts = new Map<string, number>();
    for (const s of stepsAtPos) {
      modelCounts.set(s.modelId, (modelCounts.get(s.modelId) ?? 0) + 1);
    }
    const modelId = [...modelCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0][0];

    // Most common finish reason
    const finishCounts = new Map<string, number>();
    for (const s of stepsAtPos) {
      finishCounts.set(
        s.finishReason,
        (finishCounts.get(s.finishReason) ?? 0) + 1,
      );
    }
    const finishReason = [...finishCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0][0];

    // Distinct tool names called at this step
    const toolNames = new Set<string>();
    for (const s of stepsAtPos) {
      for (const tc of s.toolCalls) toolNames.add(tc);
    }

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const avgInputTokens = avg(stepsAtPos.map((s) => s.inputTokens));
    const avgOutputTokens = avg(stepsAtPos.map((s) => s.outputTokens));
    const avgCacheRead = avg(stepsAtPos.map((s) => s.cacheReadTokens));
    const avgCacheWrite = avg(stepsAtPos.map((s) => s.cacheWriteTokens));
    const avgLatencyMs = avg(stepsAtPos.map((s) => s.stepLatencyMs));

    const avgCost = avg(
      stepsAtPos.map((s) =>
        computeCost(
          s.modelId,
          s.inputTokens,
          s.outputTokens,
          s.cacheReadTokens,
          s.cacheWriteTokens,
        ),
      ),
    );

    aggregated.push({
      stepNumber: i,
      queryCount: n,
      totalQueries: successful.length,
      modelId,
      avgInputTokens,
      avgOutputTokens,
      avgCacheReadTokens: avgCacheRead,
      avgCacheWriteTokens: avgCacheWrite,
      avgCost,
      avgLatencyMs,
      finishReason,
      toolCalls: [...toolNames],
    });
  }

  return aggregated;
}

// ── Section generators ───────────────────────────────────────────────────────

function generatePipelineSummary(
  result: EvalRunResult,
  steps: AggregatedStep[],
): string {
  const { aggregate, queries } = result;
  const successful = queries.filter((q) => !q.error);
  const avgSteps =
    successful.length > 0
      ? successful.reduce((sum, q) => sum + q.steps.length, 0) /
        successful.length
      : 0;

  // Collect all distinct models
  const models = new Set<string>();
  for (const q of successful) {
    for (const s of q.steps) models.add(s.modelId);
  }

  // Collect all distinct tools
  const tools = new Set<string>();
  for (const q of successful) {
    for (const tc of q.toolCallsMade) tools.add(tc);
  }

  // Cache usage
  const totalCacheRead = successful.reduce(
    (sum, q) => sum + q.steps.reduce((s, step) => s + step.cacheReadTokens, 0),
    0,
  );
  const totalCacheWrite = successful.reduce(
    (sum, q) => sum + q.steps.reduce((s, step) => s + step.cacheWriteTokens, 0),
    0,
  );

  // Output cost computation
  let totalOutputCost = 0;
  let totalWeightedRatio = 0;
  let totalOutputTokensForRatio = 0;
  for (const q of successful) {
    for (const step of q.steps) {
      const pricing = getModelPricing(step.modelId);
      if (pricing) {
        totalOutputCost +=
          (step.outputTokens * pricing.outputPer1M) / 1_000_000;
        totalWeightedRatio +=
          step.outputTokens * (pricing.outputPer1M / pricing.inputPer1M);
        totalOutputTokensForRatio += step.outputTokens;
      }
    }
  }

  let lines = `## Pipeline Summary\n`;
  lines += `| Metric | Value |\n`;
  lines += `|--------|-------|\n`;
  lines += `| Steps (avg/query) | ${avgSteps.toFixed(1)} |\n`;
  lines += `| Total cost (${queries.length} queries) | ${fmtCost(aggregate.totalCost)} |\n`;
  lines += `| Avg cost/query | ${fmtCost(aggregate.avgCost)} |\n`;
  lines += `| Avg latency/query | ${fmtLatency(aggregate.avgLatencyMs)} |\n`;
  const qCount = queries.length || 1; // guard against division by zero
  lines += `| Avg tokens/query | ${fmtTokens(aggregate.avgTokensPerQuery)} (${fmtTokens(aggregate.totalInputTokens / qCount)} in / ${fmtTokens(aggregate.totalOutputTokens / qCount)} out) |\n`;

  // Output token cost share
  if (aggregate.totalCost > 0 && totalOutputTokensForRatio > 0) {
    const outputPct = (totalOutputCost / aggregate.totalCost) * 100;
    const avgRatio = totalWeightedRatio / totalOutputTokensForRatio;
    lines += `| Output token cost share | ${outputPct.toFixed(1)}% of total cost at ${avgRatio.toFixed(1)}x input rate |\n`;
  }

  lines += `| Model(s) | ${[...models].join(", ") || "unknown"} |\n`;
  lines += `| Tools | ${[...tools].join(", ") || "none"} |\n`;

  // Tool definition overhead
  if (tools.size > 0) {
    const overheadTokens = tools.size * 200;
    lines += `| Tool definition overhead | ~${fmtTokens(overheadTokens)} tokens/step (${tools.size} tools x ~200 est.) |\n`;
  }

  lines += `| Queries evaluated | ${queries.length} (${successful.length} successful) |\n`;
  lines += `| Avg quality | ${aggregate.avgQuality.toFixed(2)}/5 |\n`;

  if (totalCacheRead > 0 || totalCacheWrite > 0) {
    lines += `| Cache tokens | ${fmtTokens(totalCacheRead)} read / ${fmtTokens(totalCacheWrite)} write |\n`;
  }

  // Cached prefix (step 0)
  if (steps.length > 0) {
    const step0 = steps[0];
    const prefixTokens =
      step0.avgCacheReadTokens > 0
        ? step0.avgCacheReadTokens
        : step0.avgInputTokens;
    lines += `| Cached prefix (step 0) | ~${fmtTokens(prefixTokens)} tokens (system prompt + tool definitions) |\n`;
  }

  return lines;
}

function generateOptimizationSignals(
  result: EvalRunResult,
  steps: AggregatedStep[],
): string {
  const successful = result.queries.filter((q) => !q.error);
  if (successful.length === 0) return "";

  const avgCost =
    successful.reduce((s, q) => s + q.cost, 0) / successful.length;
  const avgStepCount =
    successful.reduce((s, q) => s + q.steps.length, 0) / successful.length;
  const costThreshold = avgCost * 2;
  const stepsThreshold = avgStepCount * 2;

  const signals: string[] = [];
  let signalNum = 0;

  // Signal 1: Outlier query
  let worstOutlier: {
    query: string;
    cost: number;
    costRatio: number;
    costPct: number;
    steps: number;
    quality: number;
  } | null = null;
  for (const q of successful) {
    const isOutlier =
      q.cost > costThreshold ||
      q.steps.length > stepsThreshold ||
      q.quality.overall < 3.0;
    if (!isOutlier) continue;
    const costRatio = q.cost / avgCost;
    if (!worstOutlier || costRatio > worstOutlier.costRatio) {
      worstOutlier = {
        query: truncate(q.query, 30),
        cost: q.cost,
        costRatio,
        costPct:
          result.aggregate.totalCost > 0
            ? (q.cost / result.aggregate.totalCost) * 100
            : 0,
        steps: q.steps.length,
        quality: q.quality.overall,
      };
    }
  }
  if (worstOutlier) {
    signalNum++;
    signals.push(
      `| ${signalNum} | Outlier query | "${worstOutlier.query}" costs ${fmtCost(worstOutlier.cost)} (${worstOutlier.costRatio.toFixed(1)}x avg, ${worstOutlier.costPct.toFixed(0)}% of total) with ${worstOutlier.steps} steps and quality ${worstOutlier.quality.toFixed(1)}/5 | Stop Condition Optimization, Agent Decomposition |`,
    );
  }

  // Signal 2: Output token pricing premium
  let totalOutputCost = 0;
  for (const q of successful) {
    for (const step of q.steps) {
      const pricing = getModelPricing(step.modelId);
      if (pricing) {
        totalOutputCost +=
          (step.outputTokens * pricing.outputPer1M) / 1_000_000;
      }
    }
  }
  if (result.aggregate.totalCost > 0) {
    const outputPct = (totalOutputCost / result.aggregate.totalCost) * 100;
    if (outputPct > 10) {
      // Compute average output/input pricing ratio
      let weightedRatio = 0;
      let totalOut = 0;
      for (const q of successful) {
        for (const step of q.steps) {
          const pricing = getModelPricing(step.modelId);
          if (pricing) {
            weightedRatio +=
              step.outputTokens * (pricing.outputPer1M / pricing.inputPer1M);
            totalOut += step.outputTokens;
          }
        }
      }
      const avgRatio = totalOut > 0 ? weightedRatio / totalOut : 5;
      signalNum++;
      signals.push(
        `| ${signalNum} | Output token pricing premium | Output cost ~${outputPct.toFixed(0)}% of total at ${avgRatio.toFixed(0)}x input rate | Output Token Capping, Claude Effort Levels |`,
      );
    }
  }

  // Signal 3: Tool definition overhead
  const allTools = new Set<string>();
  for (const s of steps) {
    for (const tc of s.toolCalls) allTools.add(tc);
  }
  const totalToolCount = allTools.size;
  if (totalToolCount > 0 && steps.length > 0) {
    const overheadTokens = totalToolCount * 200;
    const avgInputTokens =
      steps.reduce((sum, s) => sum + s.avgInputTokens, 0) / steps.length;
    const overheadPct =
      avgInputTokens > 0 ? (overheadTokens / avgInputTokens) * 100 : 0;
    if (overheadPct > 5) {
      const avgToolsPerStep =
        steps.reduce((sum, s) => sum + s.toolCalls.length, 0) / steps.length;
      const unusedPct =
        totalToolCount > 0
          ? ((totalToolCount - avgToolsPerStep) / totalToolCount) * 100
          : 0;
      signalNum++;
      signals.push(
        `| ${signalNum} | Tool definition overhead | ${totalToolCount} tools x ~200 tokens = ~${fmtTokens(overheadTokens)} tokens/step. Steps 2+ use ${Math.round(avgToolsPerStep)} tools (${unusedPct.toFixed(0)}%+ unused) | Tool Optimization |`,
      );
    }
  }

  // Signal 4: Step distribution skew
  const stepCounts = successful
    .map((q) => q.steps.length)
    .sort((a, b) => a - b);
  const medianSteps = stepCounts[Math.floor(stepCounts.length / 2)];
  const maxStepCount = stepCounts[stepCounts.length - 1];
  if (medianSteps > 0 && maxStepCount > 3 * medianSteps) {
    const belowMedian = stepCounts.filter((s) => s <= medianSteps).length;
    const belowMedianPct = (belowMedian / stepCounts.length) * 100;
    signalNum++;
    signals.push(
      `| ${signalNum} | Step distribution skew | ${belowMedianPct.toFixed(0)}% of queries complete in <=${medianSteps} steps, but max is ${maxStepCount} (${(maxStepCount / medianSteps).toFixed(1)}x median) | Stop Condition Optimization |`,
    );
  }

  if (signals.length === 0) return "";

  let lines = `## Optimization Signals\n\n`;
  lines += `| # | Signal | Evidence | Potential Category |\n`;
  lines += `|---|--------|----------|--------------------|`;
  for (const signal of signals) {
    lines += `\n${signal}`;
  }
  lines += `\n\n> Auto-detected signals from eval data. Each maps to optimization categories in the meta-knowledge file.\n`;

  return lines;
}

function generateCostBreakdown(
  steps: AggregatedStep[],
  result: EvalRunResult,
): string {
  // Sort by cost descending (the "hot functions" equivalent)
  const sorted = [...steps].sort((a, b) => b.avgCost - a.avgCost);
  // Use actual total spend (avgCost × queryCount) for % calculation
  const totalActualCost = steps.reduce(
    (sum, s) => sum + s.avgCost * s.queryCount,
    0,
  );

  let lines = `## Per-Step Cost Breakdown\n`;
  lines += `| Step | Queries | Model | Avg In Tok | Avg Out Tok | In Cost | Out Cost | Avg Cost | % Total | Avg Latency | Finish |\n`;
  lines += `|------|---------|-------|------------|-------------|---------|----------|----------|---------|-------------|--------|\n`;

  for (const s of sorted) {
    const cacheNote =
      s.avgCacheReadTokens > 0
        ? ` (${fmtTokens(s.avgCacheReadTokens)} cached)`
        : "";
    const stepActualCost = s.avgCost * s.queryCount;

    // Compute In Cost and Out Cost
    const pricing = getModelPricing(s.modelId);
    let inCost = 0;
    let outCost = 0;
    if (pricing) {
      const regularInput = s.avgInputTokens - s.avgCacheReadTokens;
      inCost =
        (regularInput * pricing.inputPer1M +
          s.avgCacheReadTokens *
            (pricing.cacheReadPer1M ??
              pricing.cachedInputPer1M ??
              pricing.inputPer1M)) /
        1_000_000;
      outCost = (s.avgOutputTokens * pricing.outputPer1M) / 1_000_000;
    }

    lines += `| ${s.stepNumber} | ${s.queryCount}/${s.totalQueries} | ${shortModel(s.modelId)} | ${fmtTokens(s.avgInputTokens)}${cacheNote} | ${fmtTokens(s.avgOutputTokens)} | ${fmtCost(inCost)} | ${fmtCost(outCost)} | ${fmtCost(s.avgCost)} | ${fmtPct(stepActualCost, totalActualCost)} | ${fmtLatency(s.avgLatencyMs)} | ${s.finishReason} |\n`;
  }

  lines += `\n> Sorted by avg cost descending. "% Total" reflects actual spend (avg cost × query frequency).\n`;

  return lines;
}

function generateContextGrowth(steps: AggregatedStep[]): string {
  // Show in step order (not sorted by cost) to reveal accumulation
  const ordered = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);

  let lines = `## Context Growth\n`;
  lines += `| Step | Avg Input Tokens | Delta | Growth |\n`;
  lines += `|------|-----------------|-------|--------|\n`;

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const tokens = fmtTokens(s.avgInputTokens);

    if (i === 0) {
      lines += `| ${s.stepNumber} | ${tokens} | — | — |\n`;
    } else {
      const prev = ordered[i - 1];
      const delta = s.avgInputTokens - prev.avgInputTokens;
      const deltaStr =
        delta >= 0 ? `+${fmtTokens(delta)}` : `-${fmtTokens(Math.abs(delta))}`;

      let growthStr: string;
      if (prev.avgInputTokens === 0) {
        growthStr = "—";
      } else {
        const growthPct = (delta / prev.avgInputTokens) * 100;
        growthStr =
          growthPct >= 0
            ? `+${growthPct.toFixed(0)}%`
            : `${growthPct.toFixed(0)}%`;
      }

      lines += `| ${s.stepNumber} | ${tokens} | ${deltaStr} | ${growthStr} |\n`;
    }
  }

  lines += `\n> Input tokens per step show how the context window fills across the tool loop.\n`;

  return lines;
}

function generateStepDistribution(result: EvalRunResult): string {
  const successful = result.queries.filter((q) => !q.error);
  if (successful.length === 0) return "";

  const stepCounts = successful.map((q) => q.steps.length);
  const sortedCounts = [...stepCounts].sort((a, b) => a - b);
  const medianSteps = sortedCounts[Math.floor(sortedCounts.length / 2)];

  // Frequency distribution
  const freq = new Map<number, number>();
  for (const sc of stepCounts) {
    freq.set(sc, (freq.get(sc) ?? 0) + 1);
  }
  const sortedFreq = [...freq.entries()].sort((a, b) => a[0] - b[0]);

  let lines = `## Step Distribution\n`;
  lines += `| Steps | Queries | % |\n`;
  lines += `|-------|---------|---|\n`;

  for (const [steps, count] of sortedFreq) {
    lines += `| ${steps} | ${count} | ${fmtPct(count, successful.length)} |\n`;
  }

  const belowMedian = stepCounts.filter((s) => s <= medianSteps).length;
  const belowMedianPct = ((belowMedian / successful.length) * 100).toFixed(0);
  const maxStepsRef = Math.ceil(medianSteps * 2);
  const affectedQueries = stepCounts.filter((s) => s > maxStepsRef).length;
  const affectedPct = ((affectedQueries / successful.length) * 100).toFixed(0);

  lines += `\n> ${belowMedianPct}% of queries complete in <=${medianSteps} steps. maxSteps=${maxStepsRef} would affect ${affectedQueries} queries (${affectedPct}%).\n`;

  return lines;
}

function generateToolUsage(
  result: EvalRunResult,
  steps: AggregatedStep[],
): string {
  const successful = result.queries.filter((q) => !q.error);
  if (successful.length === 0) return "";

  // Aggregate tool calls across all queries
  const toolStats = new Map<
    string,
    { totalCalls: number; totalLatencyMs: number; stepsUsed: Set<number> }
  >();

  for (const q of successful) {
    for (const step of q.steps) {
      if (step.toolCalls.length === 0) continue;
      // Split step latency evenly across tools called in this step
      const latencyPerTool = step.stepLatencyMs / step.toolCalls.length;
      for (const toolName of step.toolCalls) {
        const existing = toolStats.get(toolName) ?? {
          totalCalls: 0,
          totalLatencyMs: 0,
          stepsUsed: new Set<number>(),
        };
        existing.totalCalls++;
        existing.totalLatencyMs += latencyPerTool;
        existing.stepsUsed.add(step.stepNumber);
        toolStats.set(toolName, existing);
      }
    }
  }

  if (toolStats.size === 0) {
    return `## Tool Usage\n\nNo tool calls observed.\n`;
  }

  // Sort by total calls descending
  const sorted = [...toolStats.entries()].sort(
    (a, b) => b[1].totalCalls - a[1].totalCalls,
  );

  let lines = `## Tool Usage\n`;
  lines += `| Tool | Total Calls | Avg Calls/Query | Avg Latency/Call | Steps |\n`;
  lines += `|------|-------------|-----------------|------------------|-------|\n`;

  for (const [name, stats] of sorted) {
    const avgCalls = stats.totalCalls / successful.length;
    const avgLatency = stats.totalLatencyMs / stats.totalCalls;
    const stepsStr = [...stats.stepsUsed].sort((a, b) => a - b).join(", ");

    lines += `| ${name} | ${stats.totalCalls} | ${avgCalls.toFixed(1)} | ${fmtLatency(avgLatency)} | [${stepsStr}] |\n`;
  }

  // Tool overhead annotation
  const totalTools = toolStats.size;
  const avgToolsPerStep =
    steps.length > 0
      ? steps.reduce((sum, s) => sum + s.toolCalls.length, 0) / steps.length
      : 0;

  if (totalTools > 5 && avgToolsPerStep < totalTools * 0.5) {
    const unusedPerStep = totalTools - Math.round(avgToolsPerStep);
    const overheadTokens = unusedPerStep * 200;
    lines += `\n> Tool overhead: ${totalTools} tool definitions add ~${totalTools * 200} tokens to every step's input. `;
    lines += `Steps average ${Math.round(avgToolsPerStep)} tools used — ~${unusedPerStep} definitions (~${fmtTokens(overheadTokens)} tokens) are unused per step.\n`;
  }

  return lines;
}

function generateModelUsage(
  result: EvalRunResult,
  steps: AggregatedStep[],
): string {
  // Aggregate cost by model
  const modelCosts = new Map<
    string,
    { cost: number; steps: Set<number>; stepCount: number }
  >();

  const successful = result.queries.filter((q) => !q.error);
  for (const q of successful) {
    for (const step of q.steps) {
      const cost = computeCost(
        step.modelId,
        step.inputTokens,
        step.outputTokens,
        step.cacheReadTokens,
        step.cacheWriteTokens,
      );
      const existing = modelCosts.get(step.modelId) ?? {
        cost: 0,
        steps: new Set<number>(),
        stepCount: 0,
      };
      existing.cost += cost;
      existing.steps.add(step.stepNumber);
      existing.stepCount++;
      modelCosts.set(step.modelId, existing);
    }
  }

  if (modelCosts.size === 0) return "";

  const totalCost = [...modelCosts.values()].reduce(
    (sum, m) => sum + m.cost,
    0,
  );
  const sorted = [...modelCosts.entries()].sort(
    (a, b) => b[1].cost - a[1].cost,
  );

  let lines = `## Model Usage\n`;
  lines += `| Model | Steps | Total Cost | % Total |\n`;
  lines += `|-------|-------|------------|--------|\n`;

  for (const [model, stats] of sorted) {
    const stepsStr = [...stats.steps].sort((a, b) => a - b).join(", ");
    lines += `| ${shortModel(model)} | [${stepsStr}] | ${fmtCost(stats.cost)} | ${fmtPct(stats.cost, totalCost)} |\n`;
  }

  // Step type annotations — show what each step does
  if (steps.length > 0) {
    lines += `\nStep types:\n`;
    const ordered = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
    for (const s of ordered) {
      const tools =
        s.toolCalls.length > 0 ? s.toolCalls.join(", ") : "no tools";
      lines += `- Step ${s.stepNumber}: ${s.finishReason} (${tools})\n`;
    }
  }

  return lines;
}

function generateQualityBreakdown(result: EvalRunResult): string {
  const successful = result.queries.filter((q) => !q.error);
  if (successful.length === 0) return "";

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const correctness = avg(successful.map((q) => q.quality.correctness));
  const relevance = avg(successful.map((q) => q.quality.relevance));
  const domainScore = avg(successful.map((q) => q.quality.domainScore));
  const overall = avg(successful.map((q) => q.quality.overall));

  // Use the domain dimension name from the first successful query
  const dimensionName = successful[0].quality.domainDimension ?? "domain";
  const dimLabel =
    dimensionName.charAt(0).toUpperCase() + dimensionName.slice(1);

  // Binary gate stats
  const passCount = successful.filter((q) => q.quality.binaryPass).length;
  const failCount = successful.length - passCount;

  let lines = `## Quality Breakdown\n`;
  lines += `| Dimension | Avg Score |\n`;
  lines += `|-----------|----------|\n`;
  lines += `| Correctness | ${correctness.toFixed(2)}/5 |\n`;
  lines += `| Relevance | ${relevance.toFixed(2)}/5 |\n`;
  lines += `| ${dimLabel} | ${domainScore.toFixed(2)}/5 |\n`;
  lines += `| **Overall** | **${overall.toFixed(2)}/5** |\n`;
  lines += `| Binary gate | ${passCount} pass / ${failCount} fail |\n`;

  return lines;
}

function generatePerQueryVariance(result: EvalRunResult): string {
  if (result.queries.length === 0) return "";

  const successful = result.queries.filter((q) => !q.error);
  const avgCost =
    successful.length > 0
      ? successful.reduce((s, q) => s + q.cost, 0) / successful.length
      : 0;
  const avgStepCount =
    successful.length > 0
      ? successful.reduce((s, q) => s + q.steps.length, 0) / successful.length
      : 0;
  const costThreshold = avgCost * 2;
  const stepsThreshold = avgStepCount * 2;
  const qualityThreshold = 3.0;

  // Sort by cost descending
  const sorted = [...result.queries].sort((a, b) => b.cost - a.cost);

  // Count flagged queries for summary
  let flaggedCount = 0;
  const compoundOutliers: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i];
    const flags: string[] = [];
    if (q.cost > costThreshold) flags.push("COST");
    if (q.steps.length > stepsThreshold) flags.push("STEPS");
    if (q.quality.overall < qualityThreshold) flags.push("QUALITY");
    if (flags.length > 0) flaggedCount++;
    if (flags.includes("COST") && flags.includes("QUALITY")) {
      const pct =
        result.aggregate.totalCost > 0
          ? ((q.cost / result.aggregate.totalCost) * 100).toFixed(0)
          : "0";
      compoundOutliers.push(
        `- Query ${i + 1}: ⚠ COST + ⚠ QUALITY — ${pct}% of total cost with quality ${q.quality.overall.toFixed(1)}/5. High cost with low quality suggests more steps aren't improving output.`,
      );
    }
  }

  let lines = `## Per-Query Variance\n\n`;
  lines += `**Outliers**: ${flaggedCount} of ${result.queries.length} queries flagged (thresholds: cost >${fmtCost(costThreshold)}, steps >${Math.round(stepsThreshold)}, quality <${qualityThreshold.toFixed(1)}).\n`;
  for (const co of compoundOutliers) {
    lines += `${co}\n`;
  }
  lines += `\n`;

  lines += `| # | Query | Steps | Tokens | Cost | Quality | Latency | Flags |\n`;
  lines += `|---|-------|-------|--------|------|---------|---------|-------|\n`;

  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i];
    const queryText = truncate(q.query, 40);
    const errMark = q.error ? " ⚠" : "";
    const flags: string[] = [];
    if (q.cost > costThreshold) flags.push("⚠ COST");
    if (q.steps.length > stepsThreshold) flags.push("⚠ STEPS");
    if (q.quality.overall < qualityThreshold) flags.push("⚠ QUALITY");
    const flagStr = flags.join(" ");
    lines += `| ${i + 1} | ${queryText} | ${q.steps.length} | ${fmtTokens(q.totalTokens)} | ${fmtCost(q.cost)} | ${q.quality.overall.toFixed(1)}/5 | ${fmtLatency(q.totalLatencyMs)} | ${flagStr}${errMark} |\n`;
  }

  lines += `\n> Sorted by cost descending. Shows execution variance across query types.\n`;

  return lines;
}

// ── Utility ──────────────────────────────────────────────────────────────────

/** Shorten model IDs for table readability */
function shortModel(modelId: string): string {
  return modelId
    .replace("claude-", "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "") // OpenAI YYYY-MM-DD
    .replace(/-\d{8}$/, ""); // Anthropic YYYYMMDD
}

// ── Export ────────────────────────────────────────────────────────────────────

export { generateProfile };
