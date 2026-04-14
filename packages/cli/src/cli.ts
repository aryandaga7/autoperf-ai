import { createRequire } from "node:module";
import { Command } from "commander";
import { registerSetupCommand } from "./commands/setup.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerOptimizeCommand } from "./commands/optimize.js";
import { registerReportCommand } from "./commands/report.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("autoperf")
  .description("Autonomous AI agent performance optimizer")
  .version(version);

// Register commands in recommended workflow order
registerSetupCommand(program);
registerEvalCommand(program);
registerOptimizeCommand(program);
registerReportCommand(program);

program.addHelpText(
  "after",
  `
Getting started:
  $ autoperf setup     Configure Claude Code plugins and MCP tools
  $ autoperf eval      Measure your agent's baseline performance
  $ autoperf optimize  Let AI optimize your agent autonomously
  $ autoperf report    Generate a visual HTML report from results
`,
);

// Show help when invoked with no arguments
program.action(() => {
  program.help();
});

program.parse();
