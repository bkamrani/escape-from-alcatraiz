import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import { FLAG, filterOutput, level1Config, runVault } from './level1.ts'

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
  const { messages, defense } = req.body as { messages?: Msg[]; defense?: boolean }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
    res.status(400).json({ error: 'invalid messages' })
    return
  }
  const history: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 4000),
  }))
  const cfg = level1Config(!!defense)
  const toolLog: string[] = []

  try {
    for (let i = 0; i < 4; i++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 512,
        system: cfg.system,
        tools: cfg.tools,
        messages: history,
      })
      const uses = resp.content.filter((b) => b.type === 'tool_use')
      if (resp.stop_reason !== 'tool_use' || uses.length === 0) {
        const raw = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        const reply = filterOutput(raw, !!defense)
        res.json({ reply, toolLog, won: reply.includes(FLAG) })
        return
      }
      history.push({ role: 'assistant', content: resp.content })
      history.push({
        role: 'user',
        content: uses.map((u) => {
          toolLog.push(u.name)
          return { type: 'tool_result' as const, tool_use_id: u.id, content: runVault() }
        }),
      })
    }
    res.json({ reply: '(tool loop limit reached)', toolLog, won: false })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'upstream error' })
  }
})

const port = Number(process.env.PORT ?? 3001)
app.listen(port, () => console.log(`api on :${port}`))
