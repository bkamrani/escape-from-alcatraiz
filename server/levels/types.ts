import type Anthropic from '@anthropic-ai/sdk'

export type ToolCallEvent = {
  type: 'tool_call'
  name: string
  input: Record<string, unknown>
}

export type ToolResultEvent = {
  type: 'tool_result'
  name: string
  output: string
  tainted?: boolean
}

export type DefenseBlockEvent = {
  type: 'defense_block'
  layer: string
  message: string
}

export type PendingActionEvent = {
  type: 'pending_action'
  id: string
  name: string
  input: Record<string, unknown>
}

export type InspectorEvent =
  | ToolCallEvent
  | ToolResultEvent
  | DefenseBlockEvent
  | PendingActionEvent

export interface ToolContext {
  defense: boolean
  events: InspectorEvent[]
  client: Anthropic
  model: string
}

export interface LevelConfig {
  system: string
  tools: Anthropic.Tool[]
  filterOutput?: (text: string, defense: boolean) => string
}

export interface LevelDef {
  id: 1 | 2 | 3 | 4
  name: string
  flag: string
  config: (defense: boolean) => LevelConfig | Promise<LevelConfig>
  runTool: (
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<{ output: string; tainted?: boolean; won?: boolean }> | { output: string; tainted?: boolean; won?: boolean }
  checkWon: (reply: string, events: InspectorEvent[], defense: boolean) => boolean
}
