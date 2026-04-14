export { runClaudeCode, CCTimeoutError } from "./claude-code.js";
export {
  buildIterationAgentMcpConfig,
  writeIterationAgentMcpConfig,
} from "./mcp-config.js";
export {
  getLatestCommit,
  revertLastCommit,
  isWorkingDirClean,
  getCurrentBranch,
  getRepoRoot,
  getChangedFiles,
  cleanWorkingDirectory,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  listWorktrees,
  cleanupOrphanedWorktrees,
} from "./git-ops.js";
export type { CommitInfo, WorktreeInfo, WorktreeResult } from "./git-ops.js";
export { EventEmitter } from "./event-emitter.js";
export type { AutoPerfEvent, AutoPerfEventType } from "./event-emitter.js";
export { CostTracker } from "./cost-tracker.js";
export { formatToolSummary, writeIterationTrace } from "./iteration-trace.js";
export { cleanRunState } from "./run-state.js";
export type { CCResult, CCRunResult, StreamEvent } from "./types.js";
export { generateModelRegistry } from "./model-registry.js";
export type { ModelRegistryResult } from "./model-registry.js";
