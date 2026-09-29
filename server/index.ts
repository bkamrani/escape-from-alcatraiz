import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import { getLevel, pendingActions, prunePendingActions, type InspectorEvent, type ToolContext } from './levels/index.ts'
import { handleReferee } from './referee.ts'

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
// Reads ANTHROPIC_API_KEY from env, server-side only. Keys not scoped to a workspace
// also need ANTHROPIC_WORKSPACE_ID.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
const client = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '32kb' }))

type Msg = { role: 'user' | 'assistant'; content: string }

app.post('/api/chat', async (req, res) => {
  const { level, defense, messages } = req.body as {
    level?: unknown
    defense?: unknown
    messages?: unknown
  }

  const targetLevel = (typeof level === 'number' ? level : 1) as 1 | 2 | 3 | 4
  const levelDef = getLevel(targetLevel)
  if (!levelDef) {
    res.status(400).json({ error: 'invalid level: must be 1, 2, 3, or 4' })
    return
  }

  const isDefense = Boolean(defense)

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
    res.status(400).json({ error: 'invalid messages: expected array between 1 and 30 items' })
    return
  }

  const validRoles = new Set(['user', 'assistant'])
  for (const m of messages) {
    if (typeof m !== 'object' || m === null || !validRoles.has((m as Msg).role) || typeof (m as Msg).content !== 'string') {
      res.status(400).json({ error: 'invalid message structure: role must be user or assistant, content must be string' })
      return
    }
  }

  const typedMessages = messages as Msg[]
  const history: Anthropic.MessageParam[] = typedMessages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 4000),
  }))

  const cfg = await levelDef.config(isDefense)
  const events: InspectorEvent[] = []
  const toolCtx: ToolContext = {
    defense: isDefense,
    events,
    client,
    model: MODEL,
  }

  try {
    for (let i = 0; i < 4; i++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 512,
        system: cfg.system,
        tools: cfg.tools,
        messages: history,
      })

      const uses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (resp.stop_reason !== 'tool_use' || uses.length === 0) {
        let reply = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        if (cfg.filterOutput) {
          reply = cfg.filterOutput(reply, isDefense)
        }
        const won = levelDef.checkWon(reply, events, isDefense)
        res.json({
          reply,
          events,
          won,
          flag: won ? levelDef.flag : undefined,
        })
        return
      }

      history.push({ role: 'assistant', content: resp.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const u of uses) {
        const inputObj = (typeof u.input === 'object' && u.input !== null ? u.input : {}) as Record<string, unknown>
        events.push({
          type: 'tool_call',
          name: u.name,
          input: inputObj,
        })

        const runRes = await levelDef.runTool(u.name, inputObj, toolCtx)
        events.push({
          type: 'tool_result',
          name: u.name,
          output: runRes.output,
          tainted: runRes.tainted,
        })

        toolResults.push({
          type: 'tool_result',
          tool_use_id: u.id,
          content: runRes.output,
        })
      }

      history.push({
        role: 'user',
        content: toolResults,
      })
    }

    res.json({ reply: '(tool loop limit reached)', events, won: false })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'upstream error' })
  }
})

app.post('/api/approve', (req, res) => {
  const { id, approve } = req.body as { id?: unknown; approve?: unknown }
  if (typeof id !== 'string' || typeof approve !== 'boolean') {
    res.status(400).json({ error: 'invalid payload: expected id (string) and approve (boolean)' })
    return
  }

  prunePendingActions()
  const action = pendingActions.get(id)
  if (!action) {
    res.status(404).json({ error: 'pending action not found or expired' })
    return
  }

  pendingActions.delete(id)
  const events: InspectorEvent[] = []

  if (!approve) {
    events.push({
      type: 'defense_block',
      layer: 'Human-in-the-Loop Confirmation Gate',
      message: `Action "${action.name}" denied by human operator. Execution aborted.`,
    })
    res.json({
      executed: false,
      result: `Action "${action.name}" explicitly denied by administrator.`,
      won: false,
      events,
    })
    return
  }

  events.push({
    type: 'tool_result',
    name: action.name,
    output: `[ADMIN APPROVED]: Action "${action.name}" authorized and executed.`,
  })

  let outputText = ''
  if (action.name === 'send_wire_transfer') {
    const to = String(action.input.to ?? 'account')
    const amount = Number(action.input.amount ?? 0)
    outputText = `Wire transfer of $${amount.toLocaleString()} to ${to} completed with human dual-custody sign-off.`
  } else if (action.name === 'delete_user_account') {
    const uid = String(action.input.user_id ?? 'user')
    outputText = `Account ${uid} deleted with human administrator authorization.`
  } else {
    outputText = `Action ${action.name} executed successfully.`
  }

  res.json({
    executed: true,
    result: outputText,
    // A human approving a held action is the defense working, not an exploit: never award the flag here.
    won: false,
    events,
  })
})

app.post('/api/flag', (req, res) => {
  const { level, flag } = req.body as { level?: unknown; flag?: unknown }
  const targetLevel = (typeof level === 'number' ? level : 0) as 1 | 2 | 3 | 4
  const levelDef = getLevel(targetLevel)
  if (!levelDef) {
    res.status(400).json({ error: 'invalid level' })
    return
  }
  if (typeof flag !== 'string' || flag.length > 200) {
    res.status(400).json({ error: 'invalid flag' })
    return
  }
  const correct = flag.trim() === levelDef.flag
  res.json({ correct })
})

app.post('/api/referee', handleReferee)

const port = Number(process.env.PORT ?? 3001)
app.listen(port, () => console.log(`api on :${port}`))
