# AI Agent Pipeline Optimization — Meta-Knowledge

You are optimizing an AI SDK agent pipeline. This file describes 14 categories of optimization that exist in the AI agent ecosystem. Systematically evaluate each category against the optimization profile before choosing what to optimize.

Your job: for EACH category below, read its diagnostic block, check the relevant profile data, and assess whether it applies. Then choose the highest-impact applicable category to research and implement. Each category has a **Diagnostic** block that tells you exactly what to check. Use Context7 for SDK documentation queries and Nia for provider-specific docs and exact pattern search. Search the web for techniques from other frameworks (LangChain, Google ADK, Claude Agent SDK) that may apply.

---

## Model ID Registry

**CRITICAL**: Use ONLY model IDs from this registry when modifying agent code. Do NOT invent, guess, or extrapolate model IDs — hallucinated model IDs cause 100% eval failure and waste the entire iteration budget.

### Anthropic (via `@ai-sdk/anthropic`)

| Model ID                     | Alias               | Input $/1M | Output $/1M | Cache Read $/1M | Cache Write $/1M | Notes                                                                                             |
| ---------------------------- | ------------------- | ---------- | ----------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `claude-haiku-4-5-20251001`  | `claude-haiku-4-5`  | $1.00      | $5.00       | $0.10           | $1.25            | Cheapest. No effort parameter. Manual extended thinking only (opt-in with `budget_tokens`).       |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` | $3.00      | $15.00      | $0.30           | $3.75            | Balanced. Manual extended thinking (`budget_tokens`). No effort.                                  |
| `claude-sonnet-4-6`          | —                   | $3.00      | $15.00      | $0.30           | $3.75            | Latest Sonnet. Supports adaptive thinking + `effort` parameter.                                   |
| `claude-sonnet-4-20250514`   | `claude-sonnet-4-0` | $3.00      | $15.00      | $0.30           | $3.75            | Prior generation Sonnet. Manual extended thinking. No effort.                                     |
| `claude-opus-4-6`            | —                   | $5.00      | $25.00      | $0.50           | $6.25            | Latest Opus. Supports adaptive thinking + `effort` parameter. Same pricing as Opus 4.5.           |
| `claude-opus-4-5-20251101`   | `claude-opus-4-5`   | $5.00      | $25.00      | $0.50           | $6.25            | Prior generation Opus. Same pricing as Opus 4.6. Supports `effort` (`low`/`medium`/`high`/`max`). |

Use the exact model ID string (or its alias) when calling `anthropic()` or `anthropic.chatModel()`. Example: `anthropic("claude-haiku-4-5-20251001")` or `anthropic("claude-haiku-4-5")`.

> **Cache Write has two tiers**: The prices above use the standard 5-minute TTL. A 1-hour TTL tier is also available at 2.0× base input price (e.g., Haiku: $2.00/1M, Sonnet: $6.00/1M). Most agent workloads use the 5-minute tier.

### OpenAI (via `@ai-sdk/openai`)

Requires: `OPENAI_API_KEY` env var + `@ai-sdk/openai` installed in target agent.

| Model ID       | Input $/1M | Output $/1M | Cached Input $/1M | Context | Notes                                                             |
| -------------- | ---------- | ----------- | ----------------- | ------- | ----------------------------------------------------------------- |
| `gpt-5.4`      | $2.50      | $15.00      | $0.25 (90%)       | 1.05M   | Frontier. Strong tool-calling, improved Toolathlon scores.        |
| `gpt-5.4-mini` | $0.75      | $4.50       | $0.075 (90%)      | 400K    | Mid-tier workhorse. 2x faster than GPT-5 mini. Full tool support. |
| `gpt-5.4-nano` | $0.20      | $1.25       | $0.02 (90%)       | 400K    | Budget. Designed for sub-agents, classification, extraction.      |

Caching is automatic for prompts ≥1024 tokens — no setup needed. Usage: `openai("gpt-5.4-mini")`.

### Google (via `@ai-sdk/google`)

Requires: `GOOGLE_GENERATIVE_AI_API_KEY` env var + `@ai-sdk/google` installed in target agent.

| Model ID                | Input $/1M | Output $/1M | Cached Input $/1M | Context | Notes                                                                                                                 |
| ----------------------- | ---------- | ----------- | ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `gemini-2.5-pro`        | $1.25      | $10.00      | $0.125 (90%)      | 1M      | Strong reasoning. >200K context: $2.50/$15.00/$0.25. Approaching deprecation (Jun 2026 Gemini API / Oct 2026 Vertex). |
| `gemini-2.5-flash`      | $0.30      | $2.50       | $0.03 (90%)       | 1M      | Good cost/capability balance. 1M flat-rate context.                                                                   |
| `gemini-2.5-flash-lite` | $0.10      | $0.40       | $0.01 (90%)       | 1M      | Ultra-cheap. 1M context at the lowest price available.                                                                |

Implicit caching is automatic — no setup needed. Usage: `google("gemini-2.5-flash")`.

### Cross-Provider Notes

- When using `prepareStep` to route between providers, the `model` field accepts any `LanguageModel` from any provider — cross-provider swapping is a first-class AI SDK capability.
- Anthropic prompt caching requires explicit `cacheControl` breakpoints. OpenAI and Google caching is automatic. When routing a step to a non-Anthropic model, existing Anthropic cache markers are safely ignored.
- Check the **available-models** file (generated at startup) for which providers are usable in the current environment.
- **Output structure risk**: Different providers/models produce different output lengths, formats, and tool-call patterns. A cheaper model that produces longer outputs or triggers more tool-call steps can increase total query cost despite lower per-token pricing. Measure total cost per query, not just per-token rates.
- **prepareStep capabilities** (verified from SDK source): `prepareStep` can return `{ model, toolChoice, activeTools, system, messages, providerOptions, experimental_context }`. It CANNOT return `maxOutputTokens`. Per-step effort is possible via `providerOptions: { anthropic: { effort: 'low' } }`. Per-step output capping requires `wrapLanguageModel` middleware.

---

## Optimization Categories

### Model Routing

Different steps in an agent pipeline may have different complexity requirements. Simple steps (tool calls, classification, extraction) may not need frontier models. The cost difference between model tiers can be 10-50x — and cross-provider routing unlocks even larger savings (e.g., Gemini 2.5 Flash-Lite at $0.10/1M input vs Sonnet at $3.00/1M).

- AI SDK concepts: `prepareStep` callback, model override per step, `ToolLoopAgent` configuration. The `model` field in `prepareStep` accepts any `LanguageModel` from any provider — cross-provider swapping is native.
- Cross-provider routing: Use `prepareStep` to route simple steps (tool calls, extraction) to budget models like `gemini-2.5-flash-lite` or `gpt-5.4-nano`, while keeping synthesis/reasoning on the current model. Check the available-models file for which providers are usable.
- Cross-framework: Google ADK `before_model_callback` can swap models per call; Claude Agent SDK effort levels reduce token usage for routine tasks

**Diagnostic:** Check the Per-Step Cost Breakdown — Model column and Avg Cost column. If multiple steps use the same expensive model but have different finish types (tool-calls vs stop), the model is over-provisioned for routine steps. Compare the cost ratio between tool-calling steps and synthesis steps. Also check the Model ID Registry for cheaper alternatives — cross-provider routing (via `prepareStep`) can unlock 3-10x savings over same-provider downgrades.

### Context Management

Multi-step agents accumulate messages across steps. By step N, the model may be processing thousands of redundant tokens. The AI SDK offers multiple approaches to manage this.

- AI SDK concepts: `pruneMessages()`, `prepareStep` message modification, sliding window patterns, tool result summarization
- Cross-framework: Google ADK `include_contents='none'` for explicit history control; ADK samples use aggressive content cleaning (strip code blocks, truncate long text to character limits)

**Diagnostic:** Check the Context Growth table's Delta column across consecutive steps. If input tokens grow monotonically (positive Delta at every step) without plateauing, stale content is accumulating. Cross-reference with the Tool Usage table: tools called at early steps produce results that persist in context at every subsequent step. If total input tokens at the final step exceed 2x the step-0 input, investigate `pruneMessages()` or `prepareStep` message transformation. Note: aggressive pruning can conflict with prompt caching — only compress content AFTER cache breakpoints.

### Prompt Caching

Repeated content (system prompts, tool definitions, conversation history) across steps can be cached at the provider level. Reduces input token costs by up to 90% and latency by ~75%.

- AI SDK concepts: `providerOptions.anthropic.cacheControl` on messages, cache metadata via `providerMetadata`
- Cross-framework: LangChain has `AnthropicPromptCachingMiddleware` (automatic); Claude Agent SDK does prompt caching automatically with zero config
- Important: provider-specific minimum token thresholds apply (Anthropic: 1024+ tokens for 5min TTL, 2048+ for extended). Most effective when system prompt or tool definitions are large. Up to 4 cache breakpoints per request.
- **Conflict warning**: Context compression (pruning, summarization) CONFLICTS with prompt caching. Modifying cached content invalidates the cache. Correct order: activate caching first, then only compress content AFTER the cache breakpoint (arXiv 2601.06007).

**Diagnostic:** Check the Per-Step Cost Breakdown for cached vs non-cached token counts (look for "cached" annotations in the Avg In Tok column). Calculate the cache hit ratio: cached tokens / total input tokens. If the ratio is below 30%, there may be room to add cache breakpoints. For Anthropic: explicit `cacheControl` markers required (up to 4 breakpoints, min 1024 tokens, 5-min TTL). For OpenAI and Google: caching is automatic for >=1024 token prefixes — no action needed. If Anthropic caching is already active, check whether cache write costs offset read savings (cache write is 1.25x input price).

### Response & Result Caching

Identical or near-identical LLM calls can be cached to avoid redundant inference. Semantic caching (similarity-based) can eliminate ~31% of redundant API calls in typical workloads.

- AI SDK concepts: `wrapLanguageModel` middleware, `LanguageModelMiddleware` with `wrapGenerate` and `wrapStream`
- Cross-framework: Google ADK `before_model_callback` can check cache and return responses to skip LLM calls entirely

**Diagnostic:** Check the Per-Query Variance table for queries that call similar tool sequences. If multiple queries invoke the same tools in the same order, their early steps may produce similar LLM calls. Semantic caching (via `wrapLanguageModel` middleware) can eliminate ~31% of redundant API calls in typical workloads. Impact scales with query overlap — limited at small query counts (n<=15), more significant in production.

### Tool Optimization

Tool availability and selection can be controlled per-step. Sending all tools on every step wastes context tokens on tool definitions the model won't use. Forcing tool choice can eliminate unnecessary reasoning steps.

- AI SDK concepts: `activeTools` (via `prepareStep`), `toolChoice` (required/auto/none/specific), phased tool availability via `prepareStep`
- Related: tool definition compression (reducing schema verbosity) can save significant tokens — tool definitions of 2000 tokens can often be compressed to 200

**Diagnostic:** Check the Tool Definition Overhead row in Pipeline Summary for estimated overhead per step. Check the Tool Usage table's Steps column — each tool appears only at specific steps. If the agent sends 10+ tool definitions but individual steps use 2-3, unused definitions waste ~150-250 tokens per tool at every step. Calculate waste: (total tools - avg tools used per step) x ~200 tokens x avg step count. Note: restricting tools per step via `activeTools` in `prepareStep` may invalidate Anthropic prompt caching if tool definitions are part of the cached prefix. Investigate whether the caching structure can be modified to unlock activeTools.

### Stop Condition Optimization

Agent loops can terminate based on custom conditions beyond simple step counts. Cost-aware stopping, tool-triggered completion, and adaptive termination can prevent wasted iterations.

- AI SDK concepts: `stopWhen`, `stepCountIs()`, `hasToolCall()`, custom `StopCondition` functions with access to `steps` array (including per-step `usage` data)

**Diagnostic:** Check the Optimization Signals section for outlier query signals and the Per-Query Variance table for queries with ⚠ flags. Key pattern: queries flagged ⚠ COST + ⚠ QUALITY (high cost, low quality) indicate that more steps are actively hurting — earlier stopping saves cost AND may improve quality by preventing context degradation. Investigate cost-aware synthesis forcing via `prepareStep` returning `toolChoice: 'none'` when cumulative query cost exceeds a budget, or `stopWhen` with `stepCountIs(N)` to cap runaway queries. Check whether high-step queries would produce acceptable answers at half their current step count.

### Agent Decomposition

Complex agents can be split into specialized subagents. Each subagent starts with a fresh context, preventing the main agent's context from growing by the full subtask transcript. The parent receives only a concise summary.

- AI SDK concepts: `ToolLoopAgent` subagent pattern, delegation via tools, `abortSignal` propagation
- Cross-framework: Claude Agent SDK explicitly recommends subagents for context efficiency — parent only gets tool result, not full transcript

**Diagnostic:** Check Per-Query Variance for queries with both high step counts (>5) and high total tokens (>50K). If context grows past 20K tokens by the final step (visible in Context Growth table), the agent carries stale context from early steps through later ones. Splitting into subagents gives each a fresh context — the parent receives only a concise summary. Highest impact on queries where >60% of final-step input tokens are from prior steps. High implementation complexity — prefer simpler alternatives (stop conditions, pruning) first.

### Structured Output Optimization

Output schemas affect token usage. Complex nested schemas with many optional fields consume more tokens than simple, focused schemas. The model spends tokens reasoning about schema structure.

- AI SDK concepts: `Output.object()` with Zod schemas, `maxOutputTokens` to cap response length

**Diagnostic:** Check if the agent uses `Output.object()` with Zod schemas for structured responses. If output schemas have deeply nested structures, many optional fields, or union types, the model spends extra tokens reasoning about schema conformance. Not applicable if the agent outputs free-form text. Low priority for most agents — token overhead from schema reasoning is typically small relative to tool-calling costs.

### Prompt Engineering

System prompt content and length directly affect cost (input tokens) and quality. Verbose, instruction-heavy prompts can be net-negative — they waste tokens AND may degrade output quality by adding conflicting instructions.

- AI SDK concepts: `system` parameter, message content structure
- Evidence: Internal testing found that replacing a 519-word prompt with a 34-word version reduced cost by 56% and _improved_ quality by 31%

**Diagnostic:** Check Pipeline Summary for the cached prefix row — this approximates the static prefix (system prompt + tool definitions). If the static prefix exceeds 3,000 tokens, investigate whether the system prompt can be compressed. Evidence from testing: a 519-to-34 word prompt reduction yielded -56% cost and +31% quality. Cross-reference with quality scores: if quality is already high (>4.0), aggressive prompt reduction is lower risk. If quality is mixed, prompt changes may affect it unpredictably — test carefully.

### Output Token Capping

Output tokens cost 4-8x more than input tokens. Capping output length with `maxOutputTokens` is trivial to implement and yields 30-50% savings. Almost nobody does it. Especially effective for tool-calling steps where the response is short and structured.

- AI SDK concepts: `maxOutputTokens` parameter on `generateText`/`streamText`

**Diagnostic:** Check the Per-Step Cost Breakdown's Out Cost column and Avg Out Tok column. Compare tool-calling steps (Finish: tool-calls) vs synthesis steps (Finish: stop). If tool-calling steps average >100 output tokens, the model may generate unnecessary reasoning before dispatching tools. Output tokens cost 3-5x more than input tokens. Setting `maxOutputTokens` eliminates waste on long-tail responses. Note: `maxOutputTokens` cannot be set per-step via `prepareStep` — it requires `wrapLanguageModel` middleware or a global setting on the agent.

### Claude Effort Levels

Only **Opus 4.6**, **Sonnet 4.6**, and **Opus 4.5** support the `effort` parameter (`'low'`|`'medium'`|`'high'`|`'max'`). **Haiku 4.5 does NOT support effort** — it supports manual extended thinking (opt-in with `budget_tokens`) but generates zero thinking tokens by default. Setting `effort` on Haiku has no effect. For supported models, low effort reduces thinking tokens by 30-50% on routine tasks (tool calls, classification). Effort can be set per-step via `prepareStep` returning `providerOptions: { anthropic: { effort: 'low' } }` — trivial to implement.

- AI SDK concepts: `providerOptions.anthropic.effort`, applicable per-step via `prepareStep` `providerOptions`. Only on supported models (see pricing table Notes column for support status).

**Diagnostic:** Check the Model Usage table for which Anthropic models are used and at which steps. **Only Opus 4.6, Sonnet 4.6, and Opus 4.5 support effort.** If one of these models is used for tool-calling or routine steps, investigate `effort='low'` via `prepareStep` `providerOptions` to reduce thinking tokens by 30-50%. If the pipeline uses Haiku for tool steps and a supported model for synthesis, effort tuning only applies to the synthesis steps. The profile does not currently separate thinking vs response output tokens — if this data is unavailable, test empirically with a small eval.

### Observation Masking

Multi-step agents accumulate tool results (observations) that are re-sent in every subsequent step. Simple placeholder replacement (e.g., replacing verbose tool output with `[result: 42 records]`) outperforms expensive LLM summarization in 4/5 settings. LLM summarization obscures stopping signals, causing agents to run 13-15% longer.

- AI SDK concepts: `prepareStep` message transformation, selectively replace tool result content before re-sending
- Cross-framework: JetBrains validated masking > summarization in production

**Diagnostic:** Check the Context Growth table for large positive Deltas at steps where data-heavy tools are called (cross-reference with Tool Usage table). If tools like file readers or data fetchers are called at early steps and their responses persist in later-step context, stale verbose content inflates input tokens. Investigate targeted masking in `prepareStep`: replace stale tool response content with truncated summaries while preserving metadata. Key lesson: aggressive whole-response masking causes tool re-invocation; targeted field-level masking (preserving metadata like filenames and record counts) is safer. Check optimization.md for prior masking experiments.

### Tool Response Format Optimization

Tool responses often include verbose data the model doesn't need. Redesigning tool output format (structured, minimal, relevant fields only) can reduce per-result tokens by 65%. Tool `toModelOutput` can transform raw tool results into concise model-facing format.

- AI SDK concepts: Tool `toModelOutput` callback, result transformation in tool definition
- Evidence: Anthropic SWE-bench team spent more time on tool optimization than prompt engineering

**Diagnostic:** Check the Tool Usage table for frequently-called tools (high Total Calls). If these tools return verbose structured data (full JSON objects with nested arrays), investigate `toModelOutput` callbacks on tool definitions to transform raw results into concise model-facing format. The profile does not show tool response sizes — examine the agent code for tool output schemas. Estimated savings: tools returning >1000 chars per call can often be reduced to <300 chars. Note: if the agent uses a framework like `createGithubAgent` that encapsulates tools, `toModelOutput` may not be accessible without refactoring.

### Streaming Strategy

Choice between `streamText` and `generateText` affects overhead. Streaming adds per-chunk overhead that matters for short responses. Non-streaming is more efficient when the full response is needed before proceeding.

- AI SDK concepts: `streamText`, `generateText`, `maxOutputTokens`

**Diagnostic:** Check whether the agent uses `streamText` or `generateText`. For tool-calling steps with short responses (<200 output tokens), `generateText` avoids per-chunk streaming overhead. For synthesis steps with long responses (>500 output tokens), `streamText` enables progressive display but adds overhead. This primarily affects latency and UX, not cost. Low priority for cost optimization — investigate only after higher-impact categories.

---

## Research Strategy

You have two documentation MCP tools. Use both — they have complementary strengths.

**Context7** — best for querying known SDK docs and discovering new libraries:

- `resolve-library-id` to find libraries, then `query-docs` to search them
- Pre-indexed: Vercel AI SDK (`/vercel/ai`), LangChain (`/websites/langchain`), Google ADK (`/google/adk-python`), Claude Agent SDK (`/websites/platform_claude_en_agent-sdk`)
- Use when: you know which framework to query, or want to discover if an SDK has an API for something

**Nia** — best for custom/provider docs, exact pattern search, and deep research:

- `search` for semantic search across indexed docs
- `nia_grep` for exact regex pattern matching (no Context7 equivalent)
- `nia_research` for complex multi-step research questions
- `index` to index new doc sites/repos
- Indexed sources: Anthropic API docs, OpenAI API docs, Vercel AI Gateway docs, React Flow docs (must be indexed via `index` tool)
- Use when: you need provider-specific details (caching thresholds, pricing), exact code patterns, or deep research

**Research workflow:**

1. **Query Context7** for the AI SDK concepts listed above. Use the concept names as search terms (e.g., "prepareStep model routing ToolLoopAgent"). Also query competitor framework docs for cross-framework patterns.
2. **Query Nia** for provider-specific details (prompt caching thresholds, pricing, rate limits) and for exact pattern search across indexed docs.
3. **Search the web** for techniques not covered by either MCP. Useful queries:
   - "[optimization type] AI agent" for general techniques
   - "[framework name] [optimization type]" for cross-framework patterns
   - "reduce LLM [cost/latency/tokens] [specific pattern]" for targeted solutions
4. **Read prior iteration reasoning docs** if optimization.md mentions relevant prior work.
