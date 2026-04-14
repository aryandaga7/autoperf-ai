import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ReportData,
  ReportIteration,
  RebaselineMarker,
  QuerySummary,
} from "./types.js";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a .autoperf/{target}/ directory into a ReportData object.
 * Runs all sub-parsers and merges results into a flat report structure.
 */
export async function parseTargetDirectory(
  absoluteDir: string,
  mode: "optimize" | "eval" = "optimize",
): Promise<ReportData> {
  const [optMd, detailsMap, events] = await Promise.all([
    parseOptimizationMd(absoluteDir),
    parseDetailsJson(absoluteDir),
    parseEventsJsonl(absoluteDir),
  ]);

  // Build baseline from details JSON (primary) or optimization.md (fallback)
  const baselineDetails = findBaselineDetails(detailsMap);
  const baseline = baselineDetails
    ? buildBaselineFromDetails(baselineDetails)
    : {
        cost: optMd.baseline?.totalCost ?? 0,
        latency: optMd.baseline?.avgLatencyMs ?? 0,
        quality: optMd.baseline?.avgQuality ?? 0,
        qualityBreakdown: optMd.baseline?.qualityBreakdown,
      };

  // Build iterations with absolute metrics from details JSON
  const iterations = buildReportIterations(
    optMd.iterations,
    detailsMap,
    baseline,
  );

  // Current best — prefer optimization.md "Current Best" section, fall back to last accepted
  const lastAccepted = [...iterations]
    .reverse()
    .find((i) => i.status === "accepted");
  const currentBest = {
    cost:
      optMd.currentBest?.totalCost ??
      lastAccepted?.metrics?.cost ??
      baseline.cost,
    latency:
      optMd.currentBest?.avgLatencyMs ??
      lastAccepted?.metrics?.latency ??
      baseline.latency,
    quality:
      optMd.currentBest?.avgQuality ??
      lastAccepted?.metrics?.quality ??
      baseline.quality,
    deltas: optMd.currentBest?.deltas ?? { cost: "", latency: "", quality: "" },
  };

  // Re-baseline events
  const rebaselineEvents = buildRebaselineMarkers(events, iterations);

  // Query details for eval-mode reports — use the most recent details JSON
  let queryDetails: QuerySummary[] | undefined;
  if (mode === "eval") {
    const latestDetails = findLatestDetails(detailsMap);
    if (latestDetails) {
      queryDetails = latestDetails.queries.map((q) => ({
        query: q.query,
        cost: q.cost,
        quality: q.quality.overall,
        latency: q.totalLatencyMs,
        tokens: q.totalTokens,
        steps: q.steps.length,
      }));
    }
  }

  return {
    target: {
      name: optMd.targetName,
      description: optMd.targetDescription,
      model: optMd.model,
      evalQueries: optMd.evalQueries,
    },
    baseline,
    currentBest,
    iterations,
    rebaselineEvents,
    activeOptimizations: optMd.activeOptimizations,
    learnedPrinciples: optMd.learnedPrinciples,
    generatedAt: new Date().toISOString(),
    mode,
    queryDetails,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// OPTIMIZATION.MD PARSER (ported from dashboard)
// ═══════════════════════════════════════════════════════════════════════

interface ParsedBaselineMetrics {
  totalCost: number;
  avgLatencyMs: number;
  avgQuality: number;
  qualityBreakdown?: {
    correctness: number;
    relevance: number;
    effectiveness: number;
  };
}

interface ParsedCurrentBest {
  totalCost: number;
  avgLatencyMs: number;
  avgQuality: number;
  deltas: { cost: string; latency: string; quality: string };
}

interface ParsedIterationEntry {
  index: number;
  name: string;
  status: "accepted" | "rejected";
  strategy: string;
  delta: string;
  insight: string;
}

interface OptimizationMdResult {
  targetName: string;
  targetPath: string;
  targetDescription: string;
  evalQueries: string;
  model: string;
  baseline: ParsedBaselineMetrics | null;
  currentBest: ParsedCurrentBest | null;
  iterations: ParsedIterationEntry[];
  activeOptimizations: string[];
  learnedPrinciples: string[];
}

async function parseOptimizationMd(
  targetDir: string,
): Promise<OptimizationMdResult> {
  const filePath = join(targetDir, "optimization.md");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return emptyResult();
  }

  return {
    ...parseTarget(content),
    baseline: parseBaseline(content),
    currentBest: parseCurrentBest(content),
    iterations: parseIterations(content),
    activeOptimizations: parseBulletList(content, "Active Optimizations"),
    learnedPrinciples: parseBulletList(content, "Learned Principles"),
  };
}

// ── Section helpers ────────────────────────────────────────────────

function getSection(content: string, heading: string): string | null {
  const headingRe = new RegExp(`^## ${escapeRegex(heading)}[^\\n]*$`, "m");
  const headingMatch = headingRe.exec(content);
  if (!headingMatch) return null;

  const start = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(start);
  const nextMatch = /^## /m.exec(rest.slice(1));
  const sectionContent = nextMatch ? rest.slice(0, nextMatch.index + 1) : rest;
  return sectionContent.trim() || null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Target ─────────────────────────────────────────────────────────

function parseTarget(content: string): {
  targetName: string;
  targetPath: string;
  targetDescription: string;
  evalQueries: string;
  model: string;
} {
  const section = getSection(content, "Target");
  const h1 = content.match(/^# (.+)/m);

  if (!section) {
    return {
      targetName: h1 ? h1[1].trim() : "Unknown Agent",
      targetPath: "",
      targetDescription: "",
      evalQueries: "",
      model: "",
    };
  }

  const field = (label: string): string => {
    const re = new RegExp(`(?:^[-*]\\s+)?\\*\\*${label}\\*\\*:\\s*(.+)`, "im");
    const m = section.match(re);
    return m ? m[1].trim() : "";
  };

  return {
    targetName: h1 ? h1[1].trim() : field("Agent"),
    targetPath: field("Agent"),
    targetDescription: "",
    evalQueries: field("Eval queries"),
    model: field("Model"),
  };
}

// ── Baseline ───────────────────────────────────────────────────────

function parseBaseline(content: string): ParsedBaselineMetrics | null {
  // Try both section names
  const section =
    getSection(content, "Original Baseline (Quality Reference)") ??
    getSection(content, "Baseline");
  if (!section) return null;

  const hasTable = section.split("\n").some((l) => l.trim().startsWith("|"));
  return hasTable
    ? parseBaselineFromTable(section)
    : parseBaselineFromBullets(section);
}

function parseBaselineFromTable(section: string): ParsedBaselineMetrics {
  const rows = parseMarkdownTable(section);
  const get = (key: string): string =>
    rows.find((r) => r[0].toLowerCase().includes(key.toLowerCase()))?.[1] ?? "";

  const qualityStr = get("quality");
  const qualityMatch = qualityStr.match(/([\d.]+)\/5/);
  const breakdownMatch = qualityStr.match(
    /correctness\s+([\d.]+).*?relevance\s+([\d.]+).*?effectiveness\s+([\d.]+)/i,
  );

  return {
    totalCost: parseDollar(get("Total cost") || get("cost")),
    avgLatencyMs: parseMs(get("latency")),
    avgQuality: qualityMatch ? parseFloat(qualityMatch[1]) : 0,
    qualityBreakdown: breakdownMatch
      ? {
          correctness: parseFloat(breakdownMatch[1]),
          relevance: parseFloat(breakdownMatch[2]),
          effectiveness: parseFloat(breakdownMatch[3]),
        }
      : undefined,
  };
}

function parseBaselineFromBullets(section: string): ParsedBaselineMetrics {
  const bulletField = (label: string): string => {
    const re = new RegExp(
      `^-\\s+\\*\\*${escapeRegex(label)}\\*\\*:\\s*(.+)$`,
      "mi",
    );
    const m = section.match(re);
    return m ? m[1].trim() : "";
  };

  const costStr = bulletField("Avg cost/query") || bulletField("Total cost");
  const latencyStr =
    bulletField("Avg latency/query") || bulletField("Avg latency");
  const qualityStr = bulletField("Avg quality");

  const qualityMatch = qualityStr.match(/([\d.]+)\/5/);
  const breakdownMatch = qualityStr.match(
    /correctness\s+([\d.]+)[\s|,]+.*?relevance\s+([\d.]+)[\s|,]+.*?effectiveness\s+([\d.]+)/i,
  );

  return {
    totalCost: parseDollar(costStr),
    avgLatencyMs: parseMs(latencyStr),
    avgQuality: qualityMatch ? parseFloat(qualityMatch[1]) : 0,
    qualityBreakdown: breakdownMatch
      ? {
          correctness: parseFloat(breakdownMatch[1]),
          relevance: parseFloat(breakdownMatch[2]),
          effectiveness: parseFloat(breakdownMatch[3]),
        }
      : undefined,
  };
}

// ── Current Best ───────────────────────────────────────────────────

function parseCurrentBest(content: string): ParsedCurrentBest | null {
  const section =
    getSection(content, "Current Cost/Latency Reference") ??
    getSection(content, "Current Best");
  if (!section) return null;

  const hasTable = section.split("\n").some((l) => l.trim().startsWith("|"));
  return hasTable
    ? parseCurrentBestFromTable(section)
    : parseCurrentBestFromBullets(section);
}

function parseCurrentBestFromTable(section: string): ParsedCurrentBest {
  const rows = parseMarkdownTable(section);
  const get = (key: string): string =>
    rows.find((r) => r[0].toLowerCase().includes(key.toLowerCase()))?.[1] ?? "";
  const getDelta = (key: string): string =>
    rows.find((r) => r[0].toLowerCase().includes(key.toLowerCase()))?.[2] ?? "";

  return {
    totalCost: parseDollar(get("Total cost") || get("cost")),
    avgLatencyMs: parseMs(get("latency")),
    avgQuality:
      parseFloat((get("quality").match(/([\d.]+)\/5/) ?? [])[1] ?? "0") || 0,
    deltas: {
      cost: getDelta("cost"),
      latency: getDelta("latency"),
      quality: getDelta("quality"),
    },
  };
}

function parseCurrentBestFromBullets(section: string): ParsedCurrentBest {
  const bulletField = (label: string): string => {
    const re = new RegExp(
      `^-\\s+\\*\\*${escapeRegex(label)}\\*\\*:\\s*(.+)$`,
      "mi",
    );
    const m = section.match(re);
    return m ? m[1].trim() : "";
  };

  const costStr = bulletField("Avg cost/query") || bulletField("Total cost");
  const latencyStr =
    bulletField("Avg latency/query") || bulletField("Avg latency");
  const qualityStr = bulletField("Avg quality");

  const extractDelta = (s: string): string => {
    const m = s.match(/\(([−+-][\d.]+%)[^)]*\)/);
    return m ? m[1].replace("−", "-") : "";
  };

  return {
    totalCost: parseDollar(costStr),
    avgLatencyMs: parseMs(latencyStr),
    avgQuality:
      parseFloat((qualityStr.match(/([\d.]+)\/5/) ?? [])[1] ?? "0") || 0,
    deltas: {
      cost: extractDelta(costStr),
      latency: extractDelta(latencyStr),
      quality: extractDelta(qualityStr),
    },
  };
}

// ── Iteration Log ──────────────────────────────────────────────────

function parseIterations(content: string): ParsedIterationEntry[] {
  const section = getSection(content, "Iteration Log");
  if (!section) return [];

  const entries: ParsedIterationEntry[] = [];
  const iterRe =
    /### Iteration (\d+)\s*—\s*(.+?)\s*\((ACCEPT|REJECT)\)\s*\n([\s\S]*?)(?=### Iteration|\s*$)/gi;

  let match;
  while ((match = iterRe.exec(section)) !== null) {
    const body = match[4].trim();
    const field = (label: string): string => {
      const re = new RegExp(`^${label}:\\s*(.+)$`, "mi");
      const m = body.match(re);
      return m ? m[1].trim() : "";
    };

    entries.push({
      index: parseInt(match[1], 10),
      name: match[2].trim(),
      status: match[3].toLowerCase() === "accept" ? "accepted" : "rejected",
      strategy: field("Strategy"),
      delta: field("Delta"),
      insight: field("Insight"),
    });
  }

  return entries;
}

// ── Bullet lists ───────────────────────────────────────────────────

function parseBulletList(content: string, heading: string): string[] {
  const section = getSection(content, heading);
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

// ── Markdown table parser ──────────────────────────────────────────

function parseMarkdownTable(text: string): string[][] {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return [];
  const dataLines = lines.filter((l) => !l.match(/^\|[\s-:|]+\|$/));
  return dataLines.map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
}

// ── Number parsers ─────────────────────────────────────────────────

function parseDollar(s: string): number {
  const m = s.match(/\$?([\d,.]+)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

function parseMs(s: string): number {
  const msMatch = s.match(/([\d,]+)\s*ms/i);
  if (msMatch) return parseFloat(msMatch[1].replace(/,/g, ""));
  const sMatch = s.match(/([\d,.]+)\s*s/i);
  if (sMatch) return parseFloat(sMatch[1].replace(/,/g, "")) * 1000;
  return parseFloat(s.replace(/,/g, "")) || 0;
}

function emptyResult(): OptimizationMdResult {
  return {
    targetName: "Unknown Agent",
    targetPath: "",
    targetDescription: "",
    evalQueries: "",
    model: "",
    baseline: null,
    currentBest: null,
    iterations: [],
    activeOptimizations: [],
    learnedPrinciples: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DETAILS JSON PARSER (ported from dashboard)
// ═══════════════════════════════════════════════════════════════════════

interface DetailsJson {
  agentPath: string;
  timestamp: string;
  queries: Array<{
    query: string;
    cost: number;
    totalTokens: number;
    totalLatencyMs: number;
    steps: Array<{ stepNumber: number }>;
    quality: { overall: number };
  }>;
}

const DETAILS_JSON_RE = /^(iter-\d+-)?eval-.+-details\.json$/;

async function parseDetailsJson(
  targetDir: string,
): Promise<Record<string, DetailsJson>> {
  const profileDir = join(targetDir, "profiles");
  const result: Record<string, DetailsJson> = {};

  let files: string[];
  try {
    files = await readdir(profileDir);
  } catch {
    return result;
  }

  const jsonFiles = files.filter((f) => DETAILS_JSON_RE.test(f)).sort();

  const parsed = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const content = await readFile(join(profileDir, file), "utf-8");
        const data = JSON.parse(content) as DetailsJson;
        const key = file.replace("-details.json", "");
        return { key, data };
      } catch {
        return null;
      }
    }),
  );

  for (const entry of parsed) {
    if (entry) result[entry.key] = entry.data;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// EVENTS JSONL PARSER (ported from dashboard)
// ═══════════════════════════════════════════════════════════════════════

interface ParsedEvent {
  type: string;
  timestamp: string;
  iterationNumber?: number;
  data: Record<string, unknown>;
}

async function parseEventsJsonl(targetDir: string): Promise<ParsedEvent[]> {
  const filePath = join(targetDir, "autoperf-events.jsonl");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const events: ParsedEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      events.push({
        type: parsed.type ?? "unknown",
        timestamp: parsed.timestamp ?? "",
        iterationNumber: parsed.iterationNumber,
        data: parsed.data ?? {},
      });
    } catch {
      // skip malformed
    }
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

// ═══════════════════════════════════════════════════════════════════════
// DATA BUILDERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the baseline details JSON — the earliest non-iter-prefixed entry.
 */
function findBaselineDetails(
  detailsMap: Record<string, DetailsJson>,
): DetailsJson | null {
  const keys = Object.keys(detailsMap).sort();
  const baselineKey = keys.find((k) => !k.startsWith("iter-"));
  return baselineKey ? detailsMap[baselineKey] : null;
}

/**
 * Find the most recent details JSON entry.
 */
function findLatestDetails(
  detailsMap: Record<string, DetailsJson>,
): DetailsJson | null {
  const keys = Object.keys(detailsMap).sort();
  return keys.length > 0 ? detailsMap[keys[keys.length - 1]] : null;
}

function buildBaselineFromDetails(
  details: DetailsJson,
): ReportData["baseline"] {
  const queries = details.queries;
  if (queries.length === 0) {
    return { cost: 0, latency: 0, quality: 0 };
  }

  return {
    cost: queries.reduce((sum, q) => sum + q.cost, 0),
    latency:
      queries.reduce((sum, q) => sum + q.totalLatencyMs, 0) / queries.length,
    quality:
      queries.reduce((sum, q) => sum + q.quality.overall, 0) / queries.length,
  };
}

/**
 * Map details JSON files to iteration keys using iter-N- prefix.
 * Falls back to positional mapping when no prefix is found.
 */
function mapDetailsToIterations(
  detailsMap: Record<string, DetailsJson>,
  iterations: ParsedIterationEntry[],
): Record<string, DetailsJson> {
  const result: Record<string, DetailsJson> = {};
  const keys = Object.keys(detailsMap).sort();
  const iterPrefixRe = /^iter-(\d+)-/;

  const hasExplicit = keys.some((k) => iterPrefixRe.test(k));

  if (hasExplicit) {
    for (const key of keys) {
      const m = key.match(iterPrefixRe);
      if (m) {
        result[`iter-${parseInt(m[1], 10)}`] = detailsMap[key];
      } else if (!result["baseline"]) {
        result["baseline"] = detailsMap[key];
      }
    }
  } else {
    const nonIterKeys = keys.filter((k) => !iterPrefixRe.test(k));
    if (nonIterKeys.length > 0) {
      result["baseline"] = detailsMap[nonIterKeys[0]];
    }
    for (let i = 1; i < nonIterKeys.length && i - 1 < iterations.length; i++) {
      result[`iter-${iterations[i - 1].index}`] = detailsMap[nonIterKeys[i]];
    }
  }

  return result;
}

/**
 * Build report iterations with absolute metrics from details JSON.
 */
function buildReportIterations(
  entries: ParsedIterationEntry[],
  detailsMap: Record<string, DetailsJson>,
  baseline: ReportData["baseline"],
): ReportIteration[] {
  const mapped = mapDetailsToIterations(detailsMap, entries);

  // Track running "current best" for computing metrics from deltas when no details JSON
  let currentCost = baseline.cost;
  let currentLatency = baseline.latency;
  let currentQuality = baseline.quality;

  return entries.map((entry) => {
    const iterKey = `iter-${entry.index}`;
    const details = mapped[iterKey];

    let metrics: ReportIteration["metrics"] = null;

    if (details && details.queries.length > 0) {
      const q = details.queries;
      metrics = {
        cost: q.reduce((s, x) => s + x.cost, 0),
        latency: q.reduce((s, x) => s + x.totalLatencyMs, 0) / q.length,
        quality: q.reduce((s, x) => s + x.quality.overall, 0) / q.length,
      };
    } else {
      // Approximate from delta string
      const deltas = parseDeltaPercents(entry.delta);
      metrics = {
        cost: currentCost * (1 + (deltas.cost ?? 0)),
        latency: currentLatency * (1 + (deltas.latency ?? 0)),
        quality: currentQuality * (1 + (deltas.quality ?? 0)),
      };
    }

    // Update running best on accept
    if (entry.status === "accepted" && metrics) {
      currentCost = metrics.cost;
      currentLatency = metrics.latency;
      currentQuality = metrics.quality;
    }

    return {
      index: entry.index,
      name: entry.name,
      status: entry.status,
      strategy: entry.strategy,
      delta: entry.delta,
      insight: entry.insight,
      metrics,
    };
  });
}

/**
 * Extract percentage deltas from a delta string like "cost -72.3%, latency -40.1%"
 */
function parseDeltaPercents(delta: string): Record<string, number> {
  const result: Record<string, number> = {};
  const normalized = delta.replace(/\u2212/g, "-");
  const re = /(\w+)\s+([+-]?[\d.]+)%/gi;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    result[m[1].toLowerCase()] = parseFloat(m[2]) / 100;
  }
  return result;
}

/**
 * Build re-baseline markers from events.
 * A re-baseline is a non-iteration eval:completed event that occurs between iterations.
 */
function buildRebaselineMarkers(
  events: ParsedEvent[],
  iterations: ReportIteration[],
): RebaselineMarker[] {
  const markers: RebaselineMarker[] = [];

  // Find eval:completed events that aren't tied to an iteration
  const iterRe = /iter-(\d+)/;
  const evalEvents = events.filter((e) => {
    if (e.type !== "eval:completed") return false;
    const agentPath = e.data.agentPath as string | undefined;
    return !agentPath?.match(iterRe);
  });

  // Skip the first non-iteration eval (that's the original baseline)
  for (let i = 1; i < evalEvents.length; i++) {
    const ev = evalEvents[i];
    const evTime = new Date(ev.timestamp).getTime();

    // Find which iteration this falls after
    let afterIterIndex = 0;
    for (const iter of iterations) {
      // Use event ordering: if the eval timestamp is after iteration events
      const iterEvents = events.filter(
        (e) =>
          e.type === "eval:completed" &&
          (e.data.agentPath as string)?.includes(`iter-${iter.index}`),
      );
      if (
        iterEvents.length > 0 &&
        new Date(iterEvents[0].timestamp).getTime() < evTime
      ) {
        afterIterIndex = iter.index;
      }
    }

    markers.push({
      afterIterIndex,
      cost: (ev.data.totalCost as number) ?? 0,
      latency: (ev.data.avgLatencyMs as number) ?? 0,
      quality: (ev.data.avgQuality as number) ?? 0,
    });
  }

  return markers;
}
