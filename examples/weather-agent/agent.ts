import { ToolLoopAgent } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { weatherTool } from './weather-tool.js';

export function createAgent() {
  return new ToolLoopAgent({
    model: anthropic('claude-haiku-4-5-20251001'),
    instructions: 'You are a weather assistant. Answer weather questions using the weather tool. Be concise.',
    tools: { weather: weatherTool },
    prepareStep: ({ stepNumber }) => {
      // Step 1+ is synthesis-only: tool definitions waste ~200 tokens per step
      if (stepNumber >= 1) {
        return {
          activeTools: [],
          toolChoice: 'none',
        };
      }
    },
  });
}
