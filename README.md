<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme-hero-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme-hero-light.svg">
    <img alt="AutoPerf" src="assets/readme-hero-dark.svg" height="48">
  </picture>

  <h3>Autonomous agent optimization, powered by Claude Code</h3>

  <p>
    <a href="https://www.npmjs.com/package/autoperf-ai"><img src="https://img.shields.io/npm/v/autoperf-ai.svg" alt="npm version"></a>&nbsp;
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>&nbsp;
    <a href="https://github.com/aryandaga7/autoperf-ai/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aryandaga7/autoperf-ai/ci.yml?branch=main" alt="CI"></a>
  </p>
</div>

---

AutoPerf evaluates your AI agent's cost, quality, and latency, then spawns autonomous Claude Code agents in isolated git worktrees that research optimization strategies, implement changes, and accept or reject based on statistical comparison.

Instead of building a custom agent from scratch, you give Claude Code the right environment — MCP servers, a meta-knowledge library, SDK-aware plugins, performance profiles — and let it figure out what works. The innovation is the environment, not a new agent architecture.

## The Approach

Most agent optimization tools build custom AI systems. AutoPerf takes a different path: curate the right _environment_ for Claude Code and let it operate autonomously.

Each iteration agent runs in an isolated git worktree with:

- **[Context7](https://context7.com)** — live documentation for [Vercel AI SDK](https://github.com/vercel/ai), [Google ADK](https://github.com/google/adk-python), [LangChain](https://www.langchain.com/), and [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk). Current docs, not stale training data.
- **[Nia](https://trynia.ai)** — semantic search and deep research across indexed Anthropic, OpenAI, and Vercel AI SDK documentation
- **Meta-knowledge library** — 14 optimization strategies with evidence levels and expected impact: model routing, prompt caching, context management, observation masking, effort levels, tool optimization, stop conditions, structured output, and more
- **TypeScript LSP + Vercel skills** — type checking, import verification, and AI SDK pattern guidance catch hallucinated APIs before the code runs
- **Performance profiles** — structured per-step cost breakdowns with auto-detected optimization signals from the previous eval

The iteration agent has better context for this task than a human engineer. It reads a structured profile — not eyeballed token counts — queries live SDK docs, and systematically evaluates strategy categories against measured data. It works in complete isolation with zero risk to your main branch.

This follows the auto-research pattern. Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) proved that an AI agent with an editable asset, a scalar metric, and a feedback loop can optimize code autonomously. [GEPA](https://arxiv.org/abs/2507.19457) (ICLR 2026 Oral) showed LLM agents reasoning about execution traces outperform reinforcement learning. AutoPerf adds what these don't: statistical rigor. Every change is validated with significance tests, effect size measures, and hard quality gates.

On a GitHub code review agent built with Vercel AI SDK — 15 iterations, 10 rejected, 5 accepted. **-52% cost. -50% latency. Quality preserved.** The system rejected two-thirds of its own attempts. That's the point.

The default setup targets Vercel AI SDK agents, but the MCP servers, plugins, and meta-knowledge can be swapped for any framework.

## How It Works

```
autoperf eval     →  Measure baseline (cost, quality, latency per query)
autoperf optimize →  Autonomous optimization loop:
```

1. **Eval** — Runs your agent against a query set, scores quality via LLM-as-judge, measures cost and latency per step
2. **Spawn** — Creates a git worktree and launches an autonomous Claude Code iteration agent
3. **Research** — The iteration agent reads performance profiles, meta-knowledge, and live documentation to decide what to optimize
4. **Implement** — Makes the change, commits, writes reasoning
5. **Compare** — Re-evaluates and runs statistical comparison (significance tests, effect size, confidence intervals, quality gates)
6. **Accept/Reject** — Passes? Fast-forward merge. Fails? Delete worktree. Main branch untouched.
7. **Repeat** until budget exhausted or diminishing returns

A visual report is auto-generated after each run — opens in your browser, no server needed.

[![Demo](https://img.youtube.com/vi/W7GTINnu1h8/maxresdefault.jpg)](https://youtu.be/W7GTINnu1h8)

<img src="assets/dashboard.png" alt="AutoPerf Dashboard — cost journey, iteration history, and metric tracking" width="100%">

## Quick Start

### Prerequisites

- **Node.js 20+**
- **`ANTHROPIC_API_KEY`** — for eval judging (or `OPENAI_API_KEY` with `--judge-model gpt-5.4-mini`)
- **Claude Code auth** — for `optimize` and `setup` only. `eval` works without it.

### 1. Evaluate your agent

```bash
npx autoperf-ai eval \
  --target ./my-agent \
  --queries ./my-agent/queries.json
```

Your agent directory needs `ai` and your provider SDK installed, and an `agent.ts` that exports `createAgent()`:

```typescript
import { ToolLoopAgent, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

export function createAgent() {
  return new ToolLoopAgent({
    model: anthropic("claude-sonnet-4-6"),
    tools: {
      weather: tool({
        description: "Get current weather",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => `72°F in ${city}`,
      }),
    },
  });
}
```

AutoPerf calls `createAgent().generate({ prompt })` and measures cost, quality, and latency. Any AI SDK pattern works — `ToolLoopAgent`, `generateText` wrapper, or custom implementation. See [`examples/weather-agent/`](examples/weather-agent/) for a complete example.

### 2. Optimize

```bash
npx autoperf-ai optimize \
  --target ./my-agent \
  --queries ./my-agent/queries.json \
  --iterations 10
```

Requires [Claude Code](https://github.com/anthropics/claude-code) auth. Run `npx @anthropic-ai/claude-code auth login` once.

### Queries

```json
[
  {
    "query": "What's the weather in SF?",
    "expectedBehavior": "Calls weather tool, reports conditions",
    "shouldCallTool": true,
    "expectedTools": ["weather"]
  }
]
```

See [`examples/weather-agent/`](examples/weather-agent/) for a working example.

## Commands

| Command             | What it does                     | Requires CC? |
| ------------------- | -------------------------------- | ------------ |
| `autoperf eval`     | Measure baseline performance     | No           |
| `autoperf optimize` | Run autonomous optimization loop | Yes          |
| `autoperf report`   | Generate visual HTML report      | No           |
| `autoperf setup`    | Install CC plugins + MCP servers | Yes          |

### Key flags

| Flag               | Command                | Default             | Description                                  |
| ------------------ | ---------------------- | ------------------- | -------------------------------------------- |
| `--target`         | eval, optimize, report | _required_          | Path to agent directory with `agent.ts`      |
| `--queries`        | eval, optimize         | _required_          | Path to `queries.json`                       |
| `--iterations`     | optimize               | `10`                | Max optimization iterations                  |
| `--model`          | optimize               | `opus`              | Orchestrator model                           |
| `--continue`       | optimize               | —                   | Resume from existing state                   |
| `--fresh`          | optimize               | —                   | Delete `.autoperf/{target}/` and start clean |
| `--concurrency`    | eval                   | `3`                 | Parallel eval runs                           |
| `--runs-per-query` | eval                   | `1`                 | Repeat each query N times (reduces noise)    |
| `--judge-model`    | eval                   | `claude-sonnet-4-6` | Judge model. Requires provider's API key     |
| `--no-report`      | eval, optimize         | —                   | Suppress automatic HTML report generation    |
| `--no-open`        | report                 | —                   | Generate report without opening browser      |

## Safety

Optimization happens in isolated git worktrees. Your main branch is never modified until a change passes statistical validation — significance tests, effect size thresholds, and hard quality gates. Rejected iterations delete the worktree entirely. The optimize command passes `--dangerously-skip-permissions` to Claude Code for autonomous operation — the worktree isolation ensures your codebase stays safe, but review accepted changes before pushing.

## Contributing

```bash
git clone https://github.com/aryandaga7/autoperf-ai.git
cd autoperf-ai && npm install
npm run build -w packages/cli
node packages/cli/bin/autoperf.js --help
```

## License

[MIT](LICENSE)
