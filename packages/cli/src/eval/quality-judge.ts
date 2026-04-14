import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type {
  EvalQuery,
  QualityScore,
  JudgeConfig,
  RubricType,
} from "./types.js";
import { resolveJudgeModel } from "./provider-detect.js";

// ── Rubric definitions ─────────────────────────────────────────────────────

interface RubricDefinition {
  dimensionName: string;
  dimensionDescription: string;
  correctnessRubric: string;
  relevanceRubric: string;
  domainRubric: string;
}

const RUBRICS: Record<RubricType, RubricDefinition> = {
  "research-report": {
    dimensionName: "thoroughness",
    dimensionDescription:
      "How thorough is the research? Considers depth of investigation, number and diversity of sources, coverage of subtopics, and evidence quality.",
    correctnessRubric: `Correctness — factual accuracy and source support:
  5: All claims are factually accurate, well-supported by cited sources, no errors
  4: Mostly accurate with minor imprecision that does not mislead the reader
  3: Core claims are correct but has notable gaps or one meaningful factual error
  2: Partially correct but has significant errors, unsupported claims, or major omissions
  1: Fundamentally wrong, contains dangerous misinformation, or does not address the query`,
    relevanceRubric: `Relevance — how directly the report addresses the research question:
  5: Directly and comprehensively addresses the query, stays focused throughout
  4: Addresses the query well with minor tangents or one underdeveloped area
  3: Addresses the query but drifts into unrelated areas or misses an important angle
  2: Partially addresses the query but spends most content on tangential topics
  1: Does not address the query or misunderstands it entirely`,
    domainRubric: `Thoroughness — depth and breadth of research:
  5: Multiple diverse sources cited, subtopics well-covered, evidence cross-referenced, comprehensive analysis
  4: Good source diversity with most subtopics covered, some cross-referencing
  3: Adequate sources but narrow perspective, or breadth without depth
  2: Few sources, superficial coverage, relies heavily on a single perspective
  1: No sources cited, single-source summary, or trivially shallow`,
  },

  "code-review": {
    dimensionName: "actionability",
    dimensionDescription:
      "How actionable are the insights? Considers specificity of feedback, coverage of changed files, clarity of recommendations, and concrete suggestions.",
    correctnessRubric: `Correctness — accuracy of code analysis:
  5: All code references are accurate, file paths and line numbers correct, analysis is technically sound
  4: Mostly accurate analysis with minor imprecision in technical details
  3: Core analysis is correct but misreads one significant aspect of the code
  2: Contains significant technical errors or misunderstands the code's purpose
  1: Fundamentally misanalyzes the code, wrong files referenced, or nonsensical claims`,
    relevanceRubric: `Relevance — how directly the review addresses the query:
  5: Directly answers what was asked, focuses on the right PRs/issues/files
  4: Addresses the query well with minor tangential information
  3: Addresses the query but includes substantial irrelevant content
  2: Partially addresses the query, misses the core intent
  1: Does not address the query or reviews the wrong code`,
    domainRubric: `Actionability — specificity and usefulness of insights:
  5: Specific, concrete recommendations with file/line references, clear next steps, covers all changed areas
  4: Good specific feedback covering most areas, clear recommendations
  3: Some specific feedback but also vague observations, partial coverage
  2: Mostly vague observations ("looks good", "could be better") without specifics
  1: No actionable feedback, only generic comments, or no code actually analyzed`,
  },

  generic: {
    dimensionName: "effectiveness",
    dimensionDescription:
      "How effectively does the response serve the user intent? Considers appropriate depth, format, and completeness for the question type.",
    correctnessRubric: `Correctness — factual accuracy:
  5: All claims are factually accurate, directly addresses the query, no errors
  4: Mostly accurate, minor imprecision that does not mislead
  3: Core answer is correct but has notable gaps or one meaningful error
  2: Partially correct but has significant errors or omissions
  1: Fundamentally wrong, does not answer the query, or contains dangerous misinformation`,
    relevanceRubric: `Relevance — how directly the response addresses the question:
  5: Directly and completely addresses the query with appropriate focus
  4: Addresses the query well with minor tangents
  3: Addresses the query but drifts or misses an important angle
  2: Partially addresses the query, mostly tangential
  1: Does not address the query or misunderstands it entirely`,
    domainRubric: `Effectiveness — how well the response serves the user's intent:
  5: Perfectly calibrated depth, format, and completeness for this question type
  4: Good depth and format with minor room for improvement
  3: Adequate but could be better calibrated (too shallow, too verbose, or wrong format)
  2: Poorly calibrated — significantly too shallow or too verbose for the question
  1: Completely miscalibrated or fails to provide any useful information`,
  },
};

// ── Structured output schema ───────────────────────────────────────────────

// Note: Anthropic structured output doesn't support min/max on numbers,
// so we enforce the 1-5 range via the description and post-validation.
// The reasoning field appears FIRST to force chain-of-thought before scoring.
const scoreSchema = z.object({
  reasoning: z
    .string()
    .describe(
      "Detailed chain-of-thought analysis. Evaluate the response against each dimension: quote specific strengths and weaknesses before assigning scores. 100-200 words.",
    ),
  correctness: z
    .number()
    .describe(
      "Score from 1 (worst) to 5 (best) based on the correctness rubric",
    ),
  relevance: z
    .number()
    .describe("Score from 1 (worst) to 5 (best) based on the relevance rubric"),
  domainScore: z
    .number()
    .describe(
      "Score from 1 (worst) to 5 (best) based on the domain-specific dimension rubric",
    ),
});

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildJudgePrompt(
  rubric: RubricDefinition,
  customCriteria?: string,
): string {
  let prompt = `You are a strict evaluation judge scoring an AI agent's response. Your job is to assess quality against explicit rubrics.

## Scoring Dimensions

### 1. ${rubric.correctnessRubric}

### 2. ${rubric.relevanceRubric}

### 3. ${rubric.domainRubric}

## Instructions

1. First, carefully analyze the response against EACH dimension. Quote specific parts of the response that demonstrate strengths or weaknesses.
2. Then assign integer scores (1-5) for each dimension based strictly on the rubric levels above.
3. Be calibrated: a score of 3 means adequate, not bad. Reserve 1-2 for genuinely poor responses. Reserve 4-5 for genuinely strong ones.
4. Judge the response on its own merits against the rubric — do not compare to hypothetical ideal responses.`;

  if (customCriteria) {
    prompt += `\n\n## Additional Criteria\n${customCriteria}`;
  }

  return prompt;
}

// ── Tool call correctness ─────────────────────────────────────────────────

interface ToolCheckResult {
  correct: boolean;
  reason: string;
}

/**
 * Check tool call correctness against expectations.
 *
 * Priority:
 * 1. expectedTools (exact tool name matching)
 * 2. shouldCallTool (coarse boolean fallback)
 * 3. Neither defined → no check (returns undefined)
 */
function checkToolCallCorrectness(
  evalQuery: EvalQuery,
  toolCallsMade: string[],
): ToolCheckResult | undefined {
  const actualToolSet = new Set(toolCallsMade);

  // Priority 1: Exact tool matching
  if (evalQuery.expectedTools !== undefined) {
    const expectedToolSet = new Set(evalQuery.expectedTools);

    // Check that every expected tool was called
    const missing: string[] = [];
    for (const expected of expectedToolSet) {
      if (!actualToolSet.has(expected)) {
        missing.push(expected);
      }
    }

    // Check if tools were called when none were expected
    if (expectedToolSet.size === 0 && actualToolSet.size > 0) {
      return {
        correct: false,
        reason: `Expected no tool calls but agent called: [${toolCallsMade.join(", ")}]`,
      };
    }

    if (missing.length > 0) {
      return {
        correct: false,
        reason: `Missing expected tools: [${missing.join(", ")}]. Agent called: [${toolCallsMade.join(", ") || "none"}]`,
      };
    }

    return {
      correct: true,
      reason: `All expected tools called: [${[...expectedToolSet].join(", ")}]`,
    };
  }

  // Priority 2: Coarse boolean check
  if (evalQuery.shouldCallTool !== undefined) {
    const didCallTools = toolCallsMade.length > 0;

    if (evalQuery.shouldCallTool && !didCallTools) {
      return {
        correct: false,
        reason: "Expected tool usage but no tools were called",
      };
    }

    if (!evalQuery.shouldCallTool && didCallTools) {
      return {
        correct: false,
        reason: `Expected no tool usage but agent called: [${toolCallsMade.join(", ")}]`,
      };
    }

    return {
      correct: true,
      reason: evalQuery.shouldCallTool
        ? `Correctly used tools: [${toolCallsMade.join(", ")}]`
        : "Correctly avoided tool usage",
    };
  }

  // No tool expectations defined
  return undefined;
}

// ── Tool output extraction ────────────────────────────────────────────────

const TOOL_OUTPUT_MAX_CHARS = 8000;

function buildToolOutputContent(
  toolCallsWithArgs: Array<{ toolName: string; input: string }>,
): string {
  if (toolCallsWithArgs.length === 0) return "";

  let totalChars = 0;
  const sections: string[] = [];

  for (const tc of toolCallsWithArgs) {
    let content = tc.input;
    if (totalChars + content.length > TOOL_OUTPUT_MAX_CHARS) {
      const remaining = TOOL_OUTPUT_MAX_CHARS - totalChars;
      if (remaining > 100) {
        content = content.slice(0, remaining) + "\n[...truncated]";
        sections.push(`[${tc.toolName}]:\n${content}`);
      } else {
        sections.push(
          `[${tc.toolName}]: [truncated — total tool output exceeds ${TOOL_OUTPUT_MAX_CHARS} chars]`,
        );
      }
      break;
    }
    sections.push(`[${tc.toolName}]:\n${content}`);
    totalChars += content.length;
  }

  return sections.join("\n\n");
}

// ── Binary quality gate ────────────────────────────────────────────────────

interface GateResult {
  pass: boolean;
  reason?: string;
}

function applyQualityGate(
  response: string,
  correctness: number,
  relevance: number,
  domainScore: number,
  overall: number,
  toolCheck: ToolCheckResult | undefined,
  config: JudgeConfig,
  toolOutputContent?: string,
): GateResult {
  const passingThreshold = config.passingThreshold ?? 3.0;
  const dimensionMinimum = config.dimensionMinimum ?? 2.0;

  // Gate 1: Structural failure — response is empty or trivially short
  // Skip if agent delivered substantial output via tool calls
  const hasSubstantialToolOutput = (toolOutputContent?.length ?? 0) > 50;
  if ((!response || response.trim().length < 50) && !hasSubstantialToolOutput) {
    return {
      pass: false,
      reason:
        "Structural failure: response is empty or < 50 characters and no substantial tool output",
    };
  }

  // Gate 2: Tool call correctness — wrong tool usage is an automatic fail
  if (toolCheck && !toolCheck.correct) {
    return {
      pass: false,
      reason: `Tool call failure: ${toolCheck.reason}`,
    };
  }

  // Gate 3: Catastrophic quality — overall score below threshold
  if (overall < passingThreshold) {
    return {
      pass: false,
      reason: `Overall score ${overall.toFixed(2)} below threshold ${passingThreshold}`,
    };
  }

  // Gate 4: Dimension collapse — any single dimension below floor
  const dimensions = [
    { name: "correctness", score: correctness },
    { name: "relevance", score: relevance },
    { name: "domainScore", score: domainScore },
  ];
  for (const dim of dimensions) {
    if (dim.score < dimensionMinimum) {
      return {
        pass: false,
        reason: `${dim.name} score ${dim.score} below dimension minimum ${dimensionMinimum}`,
      };
    }
  }

  return { pass: true };
}

// ── Clamp helper ───────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ── Cached judge model ────────────────────────────────────────────────────

let cachedModel: { model: LanguageModel; modelId: string } | null = null;

/**
 * Resolve and cache the judge model. The model is resolved once per process
 * and reused across all judge calls to avoid repeated dynamic imports.
 */
async function getJudgeModel(
  judgeModelId?: string,
): Promise<{ model: LanguageModel; modelId: string }> {
  if (cachedModel && (!judgeModelId || cachedModel.modelId === judgeModelId)) {
    return cachedModel;
  }

  const result = await resolveJudgeModel(judgeModelId);
  cachedModel = { model: result.model, modelId: result.modelId };
  return cachedModel;
}

// ── Main judge function ────────────────────────────────────────────────────

export async function judgeQuality(
  query: string,
  response: string,
  evalQuery: EvalQuery,
  toolCallsMade: string[],
  toolCallsWithArgs: Array<{ toolName: string; input: string }>,
  config?: JudgeConfig,
): Promise<QualityScore> {
  const resolvedConfig: JudgeConfig = {
    rubricType: config?.rubricType ?? "generic",
    passingThreshold: config?.passingThreshold ?? 3.0,
    dimensionMinimum: config?.dimensionMinimum ?? 2.0,
    customCriteria: config?.customCriteria,
    judgeModel: config?.judgeModel,
  };

  // ── Deterministic signal: tool call correctness ──────────────────
  const toolCheck = checkToolCallCorrectness(evalQuery, toolCallsMade);

  // ── Build tool output content for judge ─────────────────────────
  const toolOutputContent = buildToolOutputContent(toolCallsWithArgs);

  // ── LLM judge ────────────────────────────────────────────────────
  const rubric = RUBRICS[resolvedConfig.rubricType];
  const systemPrompt = buildJudgePrompt(rubric, resolvedConfig.customCriteria);

  // Build user prompt with query context
  let userPrompt = `Query: "${query}"

Expected behavior: ${evalQuery.expectedBehavior}`;

  if (evalQuery.expectedTools !== undefined) {
    userPrompt += `\nExpected tools: [${evalQuery.expectedTools.join(", ")}]`;
    userPrompt += `\nActual tools called: [${toolCallsMade.join(", ") || "none"}]`;
  } else if (evalQuery.shouldCallTool !== undefined) {
    userPrompt += `\nExpected tool usage: ${evalQuery.shouldCallTool ? "yes" : "no"}`;
    userPrompt += `\nActual tools called: [${toolCallsMade.join(", ") || "none"}]`;
  }

  userPrompt += `

Agent text response:
${response}`;

  if (toolOutputContent) {
    userPrompt += `

Tool output delivered by agent:
(This content was delivered via tool calls, e.g. as a PR review posted to GitHub. If the text response is minimal but the tool output contains the real deliverable, score based on the tool output quality.)

${toolOutputContent}`;
  }

  userPrompt += `

Analyze this response against each rubric dimension, then score it.`;

  const { model } = await getJudgeModel(resolvedConfig.judgeModel);

  const { output } = await generateText({
    model,
    output: Output.object({ schema: scoreSchema }),
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0,
  });

  if (!output) {
    // Judge failed — apply structural gate on the raw response
    const gate = applyQualityGate(
      response,
      0,
      0,
      0,
      0,
      toolCheck,
      resolvedConfig,
      toolOutputContent,
    );
    return {
      correctness: 0,
      relevance: 0,
      domainScore: 0,
      domainDimension: rubric.dimensionName,
      overall: 0,
      reasoning: "Judge failed to produce structured output",
      binaryPass: gate.pass,
      gateReason: gate.reason,
      toolCallCorrect: toolCheck?.correct,
    };
  }

  // Clamp scores to valid range
  const correctness = clamp(output.correctness, 1, 5);
  const relevance = clamp(output.relevance, 1, 5);
  const domainScore = clamp(output.domainScore, 1, 5);
  let overall = (correctness + relevance + domainScore) / 3;

  // Apply tool call penalty: -1.0 for wrong tool usage
  if (toolCheck && !toolCheck.correct) {
    overall = Math.max(0, overall - 1.0);
  }

  // Build composite reasoning
  let reasoning = output.reasoning;
  if (toolCheck) {
    reasoning += toolCheck.correct
      ? `\n\n[Tool check: PASS] ${toolCheck.reason}`
      : `\n\n[Tool check: FAIL] ${toolCheck.reason} (-1.0 penalty applied)`;
  }

  // Apply quality gate
  const gate = applyQualityGate(
    response,
    correctness,
    relevance,
    domainScore,
    overall,
    toolCheck,
    resolvedConfig,
    toolOutputContent,
  );

  return {
    correctness,
    relevance,
    domainScore,
    domainDimension: rubric.dimensionName,
    overall,
    reasoning,
    binaryPass: gate.pass,
    gateReason: gate.reason,
    toolCallCorrect: toolCheck?.correct,
  };
}
