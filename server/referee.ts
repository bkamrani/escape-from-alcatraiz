import type { Request, Response } from 'express'

export interface RefereeVerdict {
  verdict: 'legitimate-solve' | 'blocked-by-defense' | 'no-solve'
  technique: string
  points: number
  takeaway: string
  source: 'guild' | 'offline'
}

interface RateLimitRecord {
  count: number
  resetAt: number
}

const rateLimitMap = new Map<string, RateLimitRecord>()
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const MAX_CALLS_PER_WINDOW = 10
const MAX_RATE_LIMIT_ENTRIES = 500

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    for (const [k, v] of rateLimitMap.entries()) {
      if (now > v.resetAt) rateLimitMap.delete(k)
    }
  }

  const record = rateLimitMap.get(ip)
  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  if (record.count >= MAX_CALLS_PER_WINDOW) {
    return true
  }

  record.count++
  return false
}

const GUILD_WORKSPACE_ID = '01a0ee36-2050-3bb9-0000-c56708b8b5c4'
// Published agent ali-mo~agentbreaker-referee. The sessions API routes on the UUID (`agent_id`).
const GUILD_AGENT_ID = '01a0ee36-60e3-726e-0000-981dc7cf8cca'
const GUILD_API_URL = 'https://app.guild.ai/api'

export function parseRefereeReply(rawText: string): RefereeVerdict {
  const verdictMatch = rawText.match(/VERDICT:\s*([a-zA-Z-]+)/i)
  const techniqueMatch = rawText.match(/TECHNIQUE:\s*([^\n]+)/i)
  const pointsMatch = rawText.match(/POINTS:\s*(\d+)/i)
  const takeawayMatch = rawText.match(/TAKEAWAY:\s*([^\n]+(?:\n[^\n]+)?)/i)

  let verdict: 'legitimate-solve' | 'blocked-by-defense' | 'no-solve' = 'no-solve'
  const v = (verdictMatch ? verdictMatch[1] : '').toLowerCase().trim()
  if (v === 'legitimate-solve' || v === 'blocked-by-defense' || v === 'no-solve') {
    verdict = v
  }

  const rawTechnique = (techniqueMatch ? techniqueMatch[1] : 'unspecified').trim()
  const technique = rawTechnique.slice(0, 100)

  let points = 0
  if (pointsMatch) {
    const parsedPts = parseInt(pointsMatch[1], 10)
    points = Math.max(0, Math.min(100, isNaN(parsedPts) ? 0 : parsedPts))
  }

  const rawTakeaway = (takeawayMatch ? takeawayMatch[1] : 'No takeaway provided.').trim()
  const takeaway = rawTakeaway.slice(0, 300)

  return {
    verdict,
    technique,
    points,
    takeaway,
    source: 'guild',
  }
}

async function callGuildRestApi(report: string, apiKey: string): Promise<RefereeVerdict | null> {
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), 75000)

  try {
    const createResp = await fetch(`${GUILD_API_URL}/workspaces/${GUILD_WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: GUILD_AGENT_ID,
        initial_prompt: report,
        session_type: 'chat',
      }),
      signal: abortController.signal,
    })

    if (!createResp.ok) {
      console.warn(`Guild session creation failed: status ${createResp.status}`)
      return null
    }

    const sessionData = (await createResp.json()) as { id?: string }
    const sessionId = sessionData.id
    if (!sessionId) return null

    const maxPolls = 34
    for (let poll = 0; poll < maxPolls; poll++) {
      await new Promise((res) => setTimeout(res, 2000))
      if (abortController.signal.aborted) break

      const eventsResp = await fetch(`${GUILD_API_URL}/sessions/${sessionId}/events?limit=100&offset=0`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: abortController.signal,
      })

      if (!eventsResp.ok) continue

      const eventsData = (await eventsResp.json()) as { items?: Array<{ type?: string; content?: unknown }> }
      const items = Array.isArray(eventsData.items) ? eventsData.items : []

      for (const item of items) {
        let text = ''
        if (typeof item.content === 'string') {
          text = item.content
        } else if (typeof item.content === 'object' && item.content !== null) {
          const c = item.content as Record<string, unknown>
          if (typeof c.text === 'string') text = c.text
          else if (typeof c.data === 'string') text = c.data
        }

        if (text && text.includes('VERDICT:')) {
          return parseRefereeReply(text)
        }
      }
    }

    return null
  } catch (err) {
    console.warn('Guild REST call failed or timed out:', (err as Error).message)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function handleReferee(req: Request, res: Response): Promise<void> {
  const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1'
  if (isRateLimited(clientIp)) {
    res.status(429).json({ error: 'Rate limit exceeded: max 10 referee calls per minute.' })
    return
  }

  const { level, defense, won, attempts, hintsUsed, messages, events } = req.body as {
    level?: unknown
    defense?: unknown
    won?: unknown
    attempts?: unknown
    hintsUsed?: unknown
    messages?: unknown
    events?: unknown
  }

  // Explicit type validations
  const validLevel = typeof level === 'number' && [1, 2, 3, 4].includes(level)
  if (!validLevel) {
    res.status(400).json({ error: 'invalid level: must be 1, 2, 3, or 4' })
    return
  }

  if (typeof defense !== 'boolean' || typeof won !== 'boolean') {
    res.status(400).json({ error: 'invalid defense or won: boolean required' })
    return
  }

  const parsedAttempts = typeof attempts === 'number' && attempts >= 1 && attempts <= 100 ? attempts : 1
  const parsedHints = typeof hintsUsed === 'number' && hintsUsed >= 0 && hintsUsed <= 3 ? hintsUsed : 0

  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'invalid messages: expected string array' })
    return
  }

  // Sanitize player user turns: max 10 messages, max 500 chars each, strip secret patterns
  const sanitizedMessages: string[] = []
  for (const m of messages.slice(0, 10)) {
    if (typeof m === 'string') {
      const cleaned = m.slice(0, 500).replace(/FLAG\{[^}]*\}/gi, '[REDACTED_FLAG]')
      sanitizedMessages.push(cleaned)
    }
  }

  // Sanitize events: types and names only
  const sanitizedEvents: Array<{ type: string; name?: string }> = []
  if (Array.isArray(events)) {
    for (const e of events.slice(0, 20)) {
      if (typeof e === 'object' && e !== null) {
        const item = e as Record<string, unknown>
        const typeStr = typeof item.type === 'string' ? item.type.slice(0, 50) : 'unknown'
        const nameStr = typeof item.name === 'string' ? item.name.slice(0, 50) : undefined
        sanitizedEvents.push({ type: typeStr, name: nameStr })
      }
    }
  }

  // Build plain-text report (cap total length at 4000 characters)
  const reportLines = [
    `LEVEL: ${level}`,
    `DEFENSE: ${defense ? 'ON' : 'OFF'}`,
    `OUTCOME: ${won ? 'SOLVED' : 'BLOCKED/FAILED'}`,
    `ATTEMPTS: ${parsedAttempts}`,
    `HINTS_USED: ${parsedHints}`,
    'PLAYER_MESSAGES:',
    ...sanitizedMessages.map((m, idx) => `[Turn ${idx + 1}]: ${m}`),
    'EVENT_STREAM:',
    ...sanitizedEvents.map((e) => `- ${e.type}${e.name ? ` (${e.name})` : ''}`),
  ]

  const fullReport = reportLines.join('\n').slice(0, 4000)

  // Call Guild REST API if GUILD_API_KEY is configured
  const apiKey = process.env.GUILD_API_KEY
  if (!apiKey) {
    res.json({ source: 'offline' })
    return
  }

  try {
    const verdict = await callGuildRestApi(fullReport, apiKey)
    if (verdict) {
      res.json(verdict)
      return
    }
  } catch (err) {
    console.warn('Referee execution error:', (err as Error).message)
  }

  // Graceful offline fallback
  res.json({ source: 'offline' })
}
