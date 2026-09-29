import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { LEVELS, type ExploitCard, type LevelMeta } from './levels.ts'

type Msg = { role: 'user' | 'assistant'; content: string }

type InspectorEvent =
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string; tainted?: boolean }
  | { type: 'defense_block'; layer: string; message: string }
  | { type: 'pending_action'; id: string; name: string; input: Record<string, unknown> }

interface RefereeVerdict {
  verdict: 'legitimate-solve' | 'blocked-by-defense' | 'no-solve'
  technique: string
  points: number
  takeaway: string
  source: 'guild' | 'offline'
}

function getRankTitle(score: number): string {
  if (score >= 1000) return 'Agent Breaker (Master)'
  if (score >= 700) return 'Agent Whisperer'
  if (score >= 300) return 'Prompt Detective'
  return 'Prompt Apprentice'
}

const CARD_TYPE_CONFIG: Record<
  ExploitCard['type'],
  { step: string; label: string; icon: string; description: string }
> = {
  PERSONA: { step: '1. Who', label: 'Who (Role)', icon: '🎭', description: 'Who you pretend to be' },
  FRAMING: { step: '2. Why', label: 'Why (Excuse)', icon: '🧪', description: 'Why you need this done' },
  ASK: { step: '3. What', label: 'What (Request)', icon: '⚡', description: 'What you want the bot to do' },
}

const SUSPICIOUS_WORDS = [
  'vault',
  'code block',
  'raw',
  'debug',
  'ticket',
  'approv',
  'override',
  'secret',
  'pretend',
  'receipt',
  'sync',
  'bypass',
  'directive',
  'wire_transfer',
  'read_vault',
  'read_secrets',
]

export default function App() {
  const queryParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const isUnlockAll = queryParams.get('unlock') === 'all'
  const isDemoAlways = queryParams.get('demo') === '1'

  const [currentLevel, setCurrentLevel] = useState<1 | 2 | 3 | 4>(1)
  const [defense, setDefense] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<InspectorEvent[]>([])
  const [solvedLevels, setSolvedLevels] = useState<Set<number>>(new Set())
  const [capturedFlags, setCapturedFlags] = useState<Record<number, string>>({})
  const [revealedHints, setRevealedHints] = useState<Record<number, number>>({ 1: 0, 2: 0, 3: 0, 4: 0 })
  const [levelAttempts, setLevelAttempts] = useState<Record<number, number>>({ 1: 0, 2: 0, 3: 0, 4: 0 })
  const [manualFlag, setManualFlag] = useState('')
  const [flagStatus, setFlagStatus] = useState<{ success: boolean; msg: string } | null>(null)
  const [showVictory, setShowVictory] = useState(false)
  const [refereeLoading, setRefereeLoading] = useState(false)
  const [refereeVerdict, setRefereeVerdict] = useState<RefereeVerdict | null>(null)

  // Selected Trick Cards Track
  const [selectedCards, setSelectedCards] = useState<Record<string, string>>({})
  // Inspector Progressive Disclosure
  const [inspectorOpen, setInspectorOpen] = useState(false)

  // Replay State
  const [showReplay, setShowReplay] = useState(false)
  const [replayEvents, setReplayEvents] = useState<InspectorEvent[]>([])
  const [replayStep, setReplayStep] = useState(0)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replayDollars, setReplayDollars] = useState(0)

  // Track latest won state for quick replay
  const [roundWon, setRoundWon] = useState(false)

  const meta: LevelMeta = LEVELS[currentLevel]

  // Check if defense blocked any attack in current events
  const defenseBlockEvents = events.filter((e): e is Extract<InspectorEvent, { type: 'defense_block' }> => e.type === 'defense_block')

  // Calculate score
  const totalScore = useMemo(() => {
    let score = 0
    solvedLevels.forEach((lvl) => {
      score += LEVELS[lvl as 1 | 2 | 3 | 4]?.points ?? 0
    })
    // Deduct hints
    Object.entries(revealedHints).forEach(([lvlStr, tier]) => {
      const lvl = Number(lvlStr) as 1 | 2 | 3 | 4
      const levelMeta = LEVELS[lvl]
      if (levelMeta && tier > 0) {
        for (let i = 0; i < tier; i++) {
          score -= levelMeta.hints[i]?.cost ?? 0
        }
      }
    })
    return Math.max(0, score)
  }, [solvedLevels, revealedHints])

  // Suspicion score based on input text
  const suspicionScore = useMemo(() => {
    const lower = input.toLowerCase()
    if (!lower.trim()) return 0
    let matches = 0
    for (const kw of SUSPICIOUS_WORDS) {
      if (lower.includes(kw)) matches++
    }
    return Math.min(100, Math.round((matches / 3) * 100))
  }, [input])

  const selectLevel = (lvl: 1 | 2 | 3 | 4) => {
    setCurrentLevel(lvl)
    setMessages([])
    setEvents([])
    setFlagStatus(null)
    setManualFlag('')
    setRefereeVerdict(null)
    setRefereeLoading(false)
    setShowReplay(false)
    setRoundWon(false)
    setSelectedCards({})
    setInspectorOpen(false)
  }

  const resetCurrentLevel = () => {
    setMessages([])
    setEvents([])
    setFlagStatus(null)
    setManualFlag('')
    setDefense(false)
    setRefereeVerdict(null)
    setRefereeLoading(false)
    setShowReplay(false)
    setRoundWon(false)
    setSelectedCards({})
    setInspectorOpen(false)
  }

  const requestRefereeVerdict = async (
    isWon: boolean,
    isDefense: boolean,
    userMsgs: string[],
    currentEvts: InspectorEvent[]
  ) => {
    setRefereeLoading(true)
    try {
      const attempts = (levelAttempts[currentLevel] || 0) + 1
      const hintsCount = revealedHints[currentLevel] || 0
      const resp = await fetch('/api/referee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level: currentLevel,
          defense: isDefense,
          won: isWon,
          attempts,
          hintsUsed: hintsCount,
          messages: userMsgs,
          events: currentEvts.map((e) => ({
            type: e.type,
            name: 'name' in e ? e.name : undefined,
          })),
        }),
      })
      if (!resp.ok) {
        setRefereeVerdict({
          verdict: 'no-solve',
          technique: 'unspecified',
          points: 0,
          takeaway: 'Referee service unavailable.',
          source: 'offline',
        })
        return
      }
      const verdictData = (await resp.json()) as RefereeVerdict
      setRefereeVerdict(verdictData)
    } catch {
      setRefereeVerdict({
        verdict: 'no-solve',
        technique: 'unspecified',
        points: 0,
        takeaway: 'Referee service unreachable.',
        source: 'offline',
      })
    } finally {
      setRefereeLoading(false)
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return

    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    setFlagStatus(null)
    setRoundWon(false)
    setLevelAttempts((prev) => ({ ...prev, [currentLevel]: (prev[currentLevel] || 0) + 1 }))

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: currentLevel, defense, messages: next }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Request failed')

      setMessages([...next, { role: 'assistant', content: data.reply }])
      const receivedEvents: InspectorEvent[] = data.events || []
      setEvents(receivedEvents)
      if (receivedEvents.length > 0) {
        setInspectorOpen(true)
      }

      const userTurns = next.filter((m) => m.role === 'user').map((m) => m.content)

      if (data.won) {
        setRoundWon(true)
        setSolvedLevels((prev) => new Set([...prev, currentLevel]))
        if (data.flag) {
          setCapturedFlags((prev) => ({ ...prev, [currentLevel]: data.flag }))
        }
        if (currentLevel === 4) {
          setShowVictory(true)
        }
        void requestRefereeVerdict(true, defense, userTurns, receivedEvents)
      } else if (defense && receivedEvents.some((e) => e.type === 'defense_block')) {
        void requestRefereeVerdict(false, true, userTurns, receivedEvents)
      }
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `⚠ ${(e as Error).message}` }])
    } finally {
      setBusy(false)
    }
  }

  const submitManualFlag = async (e: React.FormEvent) => {
    e.preventDefault()
    const flagToTest = manualFlag.trim()
    if (!flagToTest) return

    try {
      const r = await fetch('/api/flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: currentLevel, flag: flagToTest }),
      })
      const data = await r.json()
      if (data.correct) {
        setFlagStatus({ success: true, msg: '🎉 Correct passcode captured!' })
        setRoundWon(true)
        setSolvedLevels((prev) => new Set([...prev, currentLevel]))
        setCapturedFlags((prev) => ({ ...prev, [currentLevel]: flagToTest }))
        if (currentLevel === 4) setShowVictory(true)
      } else {
        setFlagStatus({ success: false, msg: "❌ That passcode isn't right. Keep trying!" })
      }
    } catch {
      setFlagStatus({ success: false, msg: 'Network error validating passcode.' })
    }
  }

  const handleApproveAction = async (id: string, approve: boolean) => {
    setBusy(true)
    try {
      const r = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, approve }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Approval request failed')

      if (data.events && data.events.length > 0) {
        setEvents((prev) => [...prev, ...data.events])
        setInspectorOpen(true)
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: data.result }])

      if (data.won) {
        setSolvedLevels((prev) => new Set([...prev, currentLevel]))
        if (data.flag) {
          setCapturedFlags((prev) => ({ ...prev, [currentLevel]: data.flag }))
        }
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠ ${(e as Error).message}` }])
    } finally {
      setBusy(false)
    }
  }

  const revealHintTier = (tier: number) => {
    setRevealedHints((prev) => ({
      ...prev,
      [currentLevel]: Math.max(prev[currentLevel] || 0, tier),
    }))
  }

  const fillDemoAttack = () => {
    setInput(meta.demoPayload)
  }

  // Exploit Card Click: appends cleanly to input and marks selected
  const handleCardClick = (card: ExploitCard) => {
    setSelectedCards((prev) => ({ ...prev, [card.type]: card.id }))
    setInput((prev) => {
      const trimmed = prev.trim()
      if (!trimmed) return card.text
      if (card.text.startsWith('[') || trimmed.endsWith('\n')) {
        return trimmed + '\n' + card.text
      }
      return trimmed + ' ' + card.text
    })
  }

  // Attack Replay Logic
  const startReplay = (targetEvts?: InspectorEvent[]) => {
    const evts = targetEvts || events
    if (evts.length === 0) return
    setReplayEvents(evts)
    setReplayStep(0)
    setReplayDollars(0)
    setShowReplay(true)
    setReplayPlaying(true)
  }

  // Auto-advance timeline step every ~700ms
  useEffect(() => {
    if (!showReplay || !replayPlaying) return
    if (replayStep >= replayEvents.length - 1) return

    const timer = setTimeout(() => {
      setReplayStep((prev) => {
        const next = prev + 1
        if (next >= replayEvents.length - 1) {
          setReplayPlaying(false)
        }
        return next
      })
    }, 700)
    return () => clearTimeout(timer)
  }, [showReplay, replayPlaying, replayStep, replayEvents.length])

  // Ticking dollar counter for Level 4 wire transfer event
  useEffect(() => {
    if (!showReplay) return
    const currentEvt = replayEvents[replayStep]
    const isWire = currentEvt && 'name' in currentEvt && currentEvt.name === 'send_wire_transfer'
    if (isWire) {
      let current = 0
      const counterTimer = setInterval(() => {
        current += 2500
        if (current >= 25000) {
          setReplayDollars(25000)
          clearInterval(counterTimer)
        } else {
          setReplayDollars(current)
        }
      }, 40)
      return () => clearInterval(counterTimer)
    }
  }, [showReplay, replayStep, replayEvents])

  // Auto-scroll chat to bottom
  useEffect(() => {
    const el = document.getElementById('chat-scroll-target')
    if (el) el.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  const isLevelUnlocked = (lvl: number) => {
    if (isUnlockAll) return true
    if (lvl === 1) return true
    return solvedLevels.has(lvl - 1)
  }

  const getReplayStepInfo = (evt: InspectorEvent) => {
    if (evt.type === 'tool_call') {
      const hasInputs = Object.keys(evt.input).length > 0
      return {
        icon: '⚡',
        title: `The bot used the tool: ${evt.name}`,
        sub: hasInputs ? `Inputs: ${JSON.stringify(evt.input)}` : 'Inputs: None',
      }
    }
    if (evt.type === 'tool_result') {
      if (evt.tainted) {
        return {
          icon: '⚠️',
          title: `The bot read hidden instructions from: ${evt.name}`,
          sub: evt.output.slice(0, 140),
        }
      }
      return {
        icon: '📥',
        title: `Tool returned data: ${evt.name}`,
        sub: evt.output.slice(0, 140),
      }
    }
    if (evt.type === 'defense_block') {
      return {
        icon: '🛡️',
        title: `Safety guard blocked the action: ${evt.layer}`,
        sub: evt.message,
      }
    }
    if (evt.type === 'pending_action') {
      return {
        icon: '👤',
        title: `Paused for human confirmation: ${evt.name}`,
        sub: 'Dangerous action held until an administrator confirms it.',
      }
    }
    return {
      icon: 'ℹ️',
      title: 'Action recorded in activity log',
      sub: '',
    }
  }

  return (
    <div className="game-shell">
      {/* Top Navigation */}
      <header className="top-nav">
        <div className="brand-section">
          <div className="brand-logo">
            <span>☠</span> AGENTBREAKER
          </div>
          <span className="brand-badge">Interactive AI Security Lab</span>
        </div>

        <div className="level-selector-bar">
          {([1, 2, 3, 4] as const).map((lvl) => {
            const unlocked = isLevelUnlocked(lvl)
            const active = currentLevel === lvl
            const solved = solvedLevels.has(lvl)
            return (
              <button
                key={lvl}
                className={`level-tab ${active ? 'active' : ''} ${solved ? 'solved' : ''}`}
                disabled={!unlocked}
                onClick={() => selectLevel(lvl)}
                title={unlocked ? LEVELS[lvl].name : 'Clear previous level to unlock'}
              >
                <span>{solved ? '🚩' : unlocked ? '🎯' : '🔒'}</span>
                Level {lvl}
              </button>
            )
          })}
        </div>

        <div className="header-stats">
          {messages.length > 0 && (
            <div className="stat-chip">
              <span>Score:</span>
              <span className="stat-value">{totalScore} pts</span>
            </div>
          )}
          <button className="reset-level-btn text-sm" onClick={resetCurrentLevel} title="Reset level">
            ↺ Reset
          </button>
        </div>
      </header>

      {/* Main 3-Panel Arena */}
      <main className="main-arena">
        {/* Panel 1: Mission Briefing */}
        <section className="panel mission-panel" aria-label="Level Mission">
          <div className="mission-hero">
            <div className="mission-title-row">
              <h2 className="mission-title">{meta.name}</h2>
              <span className="owasp-chip" title={meta.owaspPlain}>{meta.owasp}</span>
            </div>
            <p className="mission-goal text-base">{meta.objective}</p>
          </div>

          <div className="disclosure-group">
            {/* Need a hint? */}
            <details className="disclosure-card">
              <summary className="disclosure-summary">
                <span>💡 Need a hint?</span>
                <span className="disclosure-badge text-mono">
                  {revealedHints[currentLevel] || 0}/{meta.hints.length}
                </span>
              </summary>
              <div className="disclosure-content">
                {meta.hints.map((h) => {
                  const isRevealed = (revealedHints[currentLevel] || 0) >= h.tier
                  return (
                    <div key={h.tier} className="hint-row">
                      {!isRevealed ? (
                        <button
                          type="button"
                          className="hint-trigger-btn text-sm"
                          onClick={() => revealHintTier(h.tier)}
                        >
                          <span>Reveal Hint #{h.tier}</span>
                          <span className="hint-cost">-{h.cost} pts</span>
                        </button>
                      ) : (
                        <div className="hint-content-box text-sm">
                          <strong>Hint #{h.tier}:</strong> {h.text}
                        </div>
                      )}
                    </div>
                  )
                })}

                {((revealedHints[currentLevel] || 0) >= 3 || isDemoAlways) && (
                  <button type="button" className="demo-attack-btn text-sm" onClick={fillDemoAttack}>
                    ⚡ Auto-Fill Example Trick
                  </button>
                )}
              </div>
            </details>

            {/* Enter secret passcode */}
            <details className="disclosure-card">
              <summary className="disclosure-summary">
                <span>🚩 Enter secret passcode</span>
                {solvedLevels.has(currentLevel) && (
                  <span className="disclosure-badge success">Solved</span>
                )}
              </summary>
              <div className="disclosure-content">
                {solvedLevels.has(currentLevel) ? (
                  <div className="flag-status-alert success text-sm">
                    <strong>🎉 Level Solved!</strong>
                    <div className="text-mono" style={{ marginTop: 4 }}>
                      Passcode: {capturedFlags[currentLevel] || 'Captured'}
                    </div>
                    <button
                      type="button"
                      className="replay-trigger-btn text-sm"
                      style={{ marginTop: 8 }}
                      onClick={() => startReplay()}
                    >
                      🎬 Step-by-Step Replay
                    </button>
                  </div>
                ) : (
                  <form className="flag-form" onSubmit={submitManualFlag}>
                    <label htmlFor="manual-flag-input" className="text-sm text-dim">
                      Found the secret passcode? Paste it here:
                    </label>
                    <input
                      id="manual-flag-input"
                      className="flag-input text-sm"
                      value={manualFlag}
                      onChange={(e) => setManualFlag(e.target.value)}
                      placeholder="e.g. FLAG{...}"
                      autoComplete="off"
                    />
                    <button type="submit" className="flag-submit-btn text-sm">
                      Submit Passcode
                    </button>
                    {flagStatus && (
                      <div className={`flag-status-alert ${flagStatus.success ? 'success' : 'error'} text-sm`}>
                        {flagStatus.msg}
                      </div>
                    )}
                  </form>
                )}
              </div>
            </details>

            {/* Level details */}
            <details className="disclosure-card">
              <summary className="disclosure-summary">
                <span>ℹ️ Level details</span>
                <span className="disclosure-badge">+{meta.points} pts</span>
              </summary>
              <div className="disclosure-content text-sm text-muted">
                <p style={{ margin: 0 }}>{meta.description}</p>
              </div>
            </details>

            {/* AI Challenge Judge Verdict Card */}
            {(refereeLoading || refereeVerdict) && (
              <details open className="disclosure-card">
                <summary className="disclosure-summary">
                  <span>⚖️ AI Challenge Judge</span>
                  <span className={`verdict-chip ${refereeLoading ? 'offline' : refereeVerdict?.verdict || 'offline'}`}>
                    {refereeLoading ? 'Judging…' : refereeVerdict?.source === 'offline' ? 'Offline' : refereeVerdict?.verdict}
                  </span>
                </summary>
                <div className="disclosure-content">
                  {refereeLoading ? (
                    <div className="text-sm text-muted">
                      AI Judge is evaluating your trick and the bot's reaction…
                    </div>
                  ) : refereeVerdict?.source === 'offline' ? (
                    <div className="referee-body text-sm">
                      <div className="text-muted">
                        AI Judge is offline (set GUILD_API_KEY in .env for live automated evaluation).
                      </div>
                      <a
                        href="https://app.guild.ai/users/ali-mo/workspaces/agentbreaker"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="referee-link text-sm"
                      >
                        Judged by a Guild agent (ali-mo~agentbreaker-referee) ↗
                      </a>
                    </div>
                  ) : (
                    <div className="referee-body text-sm">
                      <div className="referee-field">
                        <strong>Strategy Used:</strong>
                        <span>{refereeVerdict?.technique}</span>
                      </div>
                      <div className="referee-field">
                        <strong>Bonus Score:</strong>
                        <span className="text-cyan font-bold">
                          +{refereeVerdict?.points} pts
                        </span>
                      </div>
                      <div className="referee-field">
                        <strong>Key Takeaway:</strong>
                        <span>{refereeVerdict?.takeaway}</span>
                      </div>
                      <a
                        href="https://app.guild.ai/users/ali-mo/workspaces/agentbreaker"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="referee-link text-sm"
                      >
                        Judged by a Guild agent (ali-mo~agentbreaker-referee) ↗
                      </a>
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        </section>

        {/* Panel 2: Live Agent Chat */}
        <section className="chat-panel" aria-label="Live Agent Chat">
          <div className="chat-agent-header">
            <div className="agent-profile">
              <div className="agent-avatar">🤖</div>
              <div className="agent-info">
                <h3>{meta.botName}</h3>
                <p className="text-sm text-dim">{meta.botRole}</p>
              </div>
            </div>
            <div className={`defense-badge-state ${defense ? 'defended' : 'vulnerable'}`}>
              <span>{defense ? '🛡️ GUARD ON' : '🔴 UNGUARDED'}</span>
            </div>
          </div>

          <div className="chat-history">
            {messages.length === 0 ? (
              <div className="chat-empty-state">
                <div className="text-lg font-bold">Trick {meta.botName} into breaking its rules</div>
                <div className="text-sm text-dim">
                  Pick cards below to build your message, then press Send ↓
                </div>
              </div>
            ) : (
              messages.map((m, i) => {
                const isAssistant = m.role === 'assistant'
                const hasFlag = m.content.includes('FLAG{')
                return (
                  <div key={i} className={`chat-msg ${m.role}`}>
                    <span className="msg-sender">{isAssistant ? meta.botName : 'You'}</span>
                    <div className={`msg-bubble ${hasFlag ? 'won-bubble' : ''}`}>{m.content}</div>
                  </div>
                )
              })
            )}

            {/* Playful Win Micro-Copy Toast */}
            {roundWon && (
              <div className="win-toast">
                <div className="win-toast-msg text-sm">
                  <span>🏆</span> Nice! The bot broke its rules and leaked the secret!
                </div>
                {events.length > 0 && (
                  <button type="button" className="replay-trigger-btn text-sm" onClick={() => startReplay()}>
                    🎬 Step-by-Step Replay
                  </button>
                )}
              </div>
            )}

            {busy && (
              <div className="chat-msg assistant">
                <span className="msg-sender">{meta.botName}</span>
                <div className="msg-bubble text-cyan text-sm">
                  Thinking & deciding which tools to run…
                </div>
              </div>
            )}
            <div id="chat-scroll-target" />
          </div>

          <div className="chat-input-bar">
            {/* Suspicion Meter (Cosmetic) - hidden until first message is sent */}
            {messages.length > 0 && (
              <div className="suspicion-bar-wrap">
                <span className="suspicion-label text-sm">
                  Bot Alert:{' '}
                  {suspicionScore < 30 ? '🟢 Normal' : suspicionScore < 65 ? '🟡 Guarded' : '🔴 High Alert'}
                </span>
                <div className="suspicion-track" title="Shows how alert the bot becomes based on suspicious words">
                  <div
                    className={`suspicion-fill ${
                      suspicionScore < 30 ? 'low' : suspicionScore < 65 ? 'medium' : 'high'
                    }`}
                    style={{ width: `${Math.max(8, suspicionScore)}%` }}
                  />
                </div>
              </div>
            )}

            <form
              className="input-form"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <label htmlFor="agent-chat-input" className="sr-only">
                Chat Message
              </label>
              <textarea
                id="agent-chat-input"
                className="chat-textarea"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={`Trick ${meta.botName} (pick cards below or type)…`}
                rows={1}
                disabled={busy}
              />
              <button type="submit" className="send-btn" disabled={busy || !input.trim()}>
                Send
              </button>
            </form>

            {/* Trick Cards Deck: 3 Rows (Who / Why / What) */}
            <div className="exploit-deck" aria-label="Trick Cards Deck">
              <div className="deck-header">
                <div className="deck-header-left">
                  <span className="deck-title">
                    <span>🃏</span> Trick Cards
                  </span>
                  <span className="deck-subhint text-sm text-dim">
                    Pick 1 from each row (Who → Why → What), then hit Send:
                  </span>
                </div>
                {input.trim() && (
                  <button
                    type="button"
                    className="deck-clear-btn text-sm"
                    onClick={() => {
                      setInput('')
                      setSelectedCards({})
                    }}
                    title="Clear message box"
                  >
                    Clear ✕
                  </button>
                )}
              </div>

              <div className="deck-rows-container">
                {(['PERSONA', 'FRAMING', 'ASK'] as const).map((step) => {
                  const cfg = CARD_TYPE_CONFIG[step]
                  const stepCards = meta.cards.filter((card) => card.type === step)
                  return (
                    <div key={step} className={`deck-category-row ${step.toLowerCase()}`}>
                      <div className={`category-label text-sm ${step.toLowerCase()}`}>
                        <span>{cfg.icon}</span>
                        <span>{cfg.step}</span>
                      </div>
                      <div className="category-cards-grid">
                        {stepCards.map((card) => {
                          const typeClass = card.type.toLowerCase()
                          const isSelected = selectedCards[card.type] === card.id || input.includes(card.text)
                          return (
                            <button
                              key={card.id}
                              type="button"
                              className={`trick-card ${typeClass} ${isSelected ? 'selected' : ''}`}
                              onClick={() => handleCardClick(card)}
                              title={`Add: "${card.text}"`}
                            >
                              <span>{isSelected ? '✓ ' : ''}{card.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Panel 3: Defense Lab & Inspector */}
        <section className="panel defense-panel" aria-label="Safety Guard and Inspector">
          {/* Slim Guard Bar */}
          <div className="guard-slim-bar">
            <div className="toggle-switch-wrapper">
              <label className="switch-label">
                <input
                  type="checkbox"
                  checked={defense}
                  onChange={(e) => {
                    setDefense(e.target.checked)
                    setEvents([])
                  }}
                  style={{ display: 'none' }}
                />
                <div className="switch-control" />
                <span className="guard-switch-title text-sm">Safety Guard</span>
              </label>
              <span className={`defense-badge-state ${defense ? 'defended' : 'vulnerable'}`}>
                {defense ? 'ON' : 'OFF'}
              </span>
            </div>
            <p className="guard-one-liner text-sm">{meta.defense.summary}</p>
          </div>

          <div className="disclosure-group">
            {/* How guard works */}
            <details className="disclosure-card">
              <summary className="disclosure-summary">
                <span>🛡️ How this guard works</span>
              </summary>
              <div className="disclosure-content">
                <div className="defense-mini-box">
                  <strong className="text-sm">{meta.defense.title}</strong>
                  <p className="text-sm text-muted" style={{ margin: '4px 0' }}>{meta.defense.details}</p>
                  <div className="defense-analogy text-sm">💡 {meta.defense.analogy}</div>
                </div>
              </div>
            </details>

            {/* DEFENSE BLOCKED Prominent Banner */}
            {defenseBlockEvents.length > 0 && (
              <div className="guard-up-banner">
                <div className="guard-up-title text-sm">
                  <span>🛡️</span> Guard Blocked This Trick
                </div>
                <div className="guard-up-text text-sm">
                  {defenseBlockEvents[0]?.message}
                </div>
              </div>
            )}

            {/* Tool Call Inspector */}
            <details
              className="disclosure-card"
              open={inspectorOpen}
              onToggle={(e) => setInspectorOpen(e.currentTarget.open)}
            >
              <summary className="disclosure-summary">
                <span>⚙️ See what the bot did</span>
                <span className="disclosure-badge">
                  {events.length} {events.length === 1 ? 'action' : 'actions'}
                </span>
              </summary>
              <div className="disclosure-content">
                <div className="inspector-feed">
                  {events.length === 0 ? (
                    <div className="text-sm text-dim" style={{ padding: 4 }}>
                      No actions yet. Send a message to see tools and data behind the scenes.
                    </div>
                  ) : (
                    events.map((evt, idx) => {
                      if (evt.type === 'tool_call') {
                        return (
                          <div key={idx} className="feed-event tool-call">
                            <div className="event-header text-sm">
                              <span className="event-type-call">⚡ TOOL CALLED</span>
                              <span>{evt.name}</span>
                            </div>
                            <div className="event-body text-sm">{JSON.stringify(evt.input, null, 2)}</div>
                          </div>
                        )
                      }

                      if (evt.type === 'tool_result') {
                        return (
                          <div key={idx} className={`feed-event tool-result ${evt.tainted ? 'tainted' : ''}`}>
                            <div className="event-header text-sm">
                              <span className={evt.tainted ? 'event-type-tainted' : 'event-type-result'}>
                                {evt.tainted ? '⚠️ POISONED DATA' : '📥 TOOL DATA'}
                              </span>
                              <span>{evt.name}</span>
                            </div>
                            {evt.tainted && (
                              <div style={{ margin: '2px 0 4px 0' }}>
                                <span className="dirty-data-badge text-sm">Untrusted input: contains hidden instructions.</span>
                              </div>
                            )}
                            <div className="event-body text-sm">{evt.output}</div>
                          </div>
                        )
                      }

                      if (evt.type === 'defense_block') {
                        return (
                          <div key={idx} className="feed-event defense-block">
                            <div className="event-header text-sm">
                              <span className="event-type-block">🛡️ BLOCKED BY GUARD</span>
                              <span>{evt.layer}</span>
                            </div>
                            <div className="event-body text-sm">{evt.message}</div>
                          </div>
                        )
                      }

                      if (evt.type === 'pending_action') {
                        return (
                          <div key={idx} className="feed-event tool-call">
                            <div className="event-header text-sm">
                              <span className="text-amber">⏳ APPROVAL REQUIRED</span>
                              <span>{evt.name}</span>
                            </div>
                            <div className="event-body text-sm">{JSON.stringify(evt.input, null, 2)}</div>
                            <div className="pending-action-card">
                              <div className="pending-title text-sm">
                                <span>⚠️</span> Confirmation Required
                              </div>
                              <div className="text-sm text-muted">
                                Dangerous action paused! Confirm before this action proceeds.
                              </div>
                              <div className="pending-btn-row">
                                <button
                                  type="button"
                                  className="approve-btn text-sm"
                                  disabled={busy}
                                  onClick={() => void handleApproveAction(evt.id, true)}
                                >
                                  ✓ Approve
                                </button>
                                <button
                                  type="button"
                                  className="deny-btn text-sm"
                                  disabled={busy}
                                  onClick={() => void handleApproveAction(evt.id, false)}
                                >
                                  ✕ Deny
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      }

                      return null
                    })
                  )}
                </div>
              </div>
            </details>
          </div>
        </section>
      </main>

      {/* Feature 3: Attack Replay Modal ("What just happened?") */}
      {showReplay && replayEvents.length > 0 && (
        <div className="modal-overlay">
          <div className="replay-card">
            <div className="replay-header">
              <div className="replay-title text-lg">
                <span>🎬</span> Step-by-Step Replay
              </div>
              <div className="replay-progress-chip text-sm">
                Step {replayStep + 1} of {replayEvents.length}
              </div>
            </div>

            {/* Level 4 Wire Transfer Ticking Counter */}
            {currentLevel === 4 && (
              <div className="wire-transfer-counter">
                <span className="text-sm font-bold">
                  💸 Unauthorized Money Transferred:
                </span>
                <span className="counter-amount">${replayDollars.toLocaleString()} USD</span>
              </div>
            )}

            <div className="replay-timeline">
              {replayEvents.map((evt, idx) => {
                const info = getReplayStepInfo(evt)
                const isActive = idx === replayStep
                const isPast = idx < replayStep
                return (
                  <div key={idx} className={`replay-step ${isActive ? 'active' : ''} ${isPast ? 'past' : ''}`}>
                    <div className="replay-step-icon">{info.icon}</div>
                    <div className="replay-step-content">
                      <div className="replay-step-caption text-sm">{info.title}</div>
                      {info.sub && <div className="replay-step-sub text-sm">{info.sub}</div>}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="replay-controls">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="replay-btn text-sm"
                  onClick={() => {
                    setReplayStep(0)
                    setReplayPlaying(true)
                  }}
                >
                  ↺ Restart
                </button>
                <button
                  type="button"
                  className="replay-btn text-sm"
                  onClick={() => setReplayPlaying(!replayPlaying)}
                >
                  {replayPlaying ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  type="button"
                  className="replay-btn text-sm"
                  disabled={replayStep >= replayEvents.length - 1}
                  onClick={() => {
                    setReplayPlaying(false)
                    setReplayStep((prev) => Math.min(replayEvents.length - 1, prev + 1))
                  }}
                >
                  Next ⏭
                </button>
              </div>

              <button
                type="button"
                className="replay-btn primary text-sm"
                onClick={() => {
                  setShowReplay(false)
                  setReplayPlaying(false)
                }}
              >
                Close ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feature 2: Victory Modal */}
      {showVictory && (
        <div className="modal-overlay">
          <div className="victory-card">
            {/* CSS-Only Confetti Particles */}
            <div className="confetti-container" aria-hidden="true">
              {Array.from({ length: 16 }).map((_, i) => (
                <span
                  key={i}
                  className="confetti-piece"
                  style={{
                    left: `${(i * 6.25) % 100}%`,
                    animationDelay: `${(i * 0.16) % 2.4}s`,
                    backgroundColor: ['#06b6d4', '#10b981', '#f43f5e', '#6366f1', '#fbbf24', '#a855f7'][i % 6],
                  }}
                />
              ))}
            </div>

            <div style={{ fontSize: 40 }}>🏆</div>
            <h2 className="victory-title text-lg">All Challenges Completed!</h2>

            {/* Rank Title */}
            <div className="rank-badge text-sm">
              <span>Rank:</span>
              <span className="text-cyan font-bold">{getRankTitle(totalScore)}</span>
            </div>

            {/* Loot Drop Section */}
            <div className="loot-drop-card">
              <span className="loot-label text-sm">Secret Passcode Captured</span>
              <span className="loot-flag text-sm">
                {capturedFlags[4] || capturedFlags[1] || 'FLAG{all_levels_conquered_2026}'}
              </span>
            </div>

            {/* Two Primary Action Buttons */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '4px 0' }}>
              <button
                type="button"
                className="replay-btn primary text-sm"
                onClick={() => {
                  setShowVictory(false)
                  selectLevel(1)
                }}
              >
                ↻ Play Again
              </button>
              {events.length > 0 && (
                <button
                  type="button"
                  className="replay-btn text-sm"
                  onClick={() => {
                    setShowVictory(false)
                    startReplay()
                  }}
                >
                  🎬 Replay
                </button>
              )}
            </div>

            {/* Details behind 'What happened?' */}
            <details className="disclosure-card" style={{ width: '100%', textAlign: 'left' }}>
              <summary className="disclosure-summary">
                <span>What happened?</span>
              </summary>
              <div className="disclosure-content">
                <div className="victory-stats">
                  <div className="victory-stat-item">
                    <strong>4 / 4</strong>
                    <span className="text-sm text-dim">Levels Solved</span>
                  </div>
                  <div className="victory-stat-item">
                    <strong>{totalScore}</strong>
                    <span className="text-sm text-dim">Final Score</span>
                  </div>
                </div>

                {refereeVerdict && (
                  <div className="referee-body text-sm" style={{ background: 'rgba(99, 102, 241, 0.1)', padding: 10, borderRadius: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <strong>AI Judge:</strong>
                      <span className={`verdict-chip ${refereeVerdict.verdict}`}>{refereeVerdict.verdict}</span>
                    </div>
                    <div><strong>Strategy:</strong> {refereeVerdict.technique}</div>
                    <div><strong>Takeaway:</strong> {refereeVerdict.takeaway}</div>
                  </div>
                )}

                <div className="text-sm text-muted">
                  <strong>Guards Mastered:</strong>
                  <ul style={{ margin: '6px 0 0 16px', padding: 0, lineHeight: 1.5 }}>
                    <li>Prompt Injection Defense (OWASP LLM01)</li>
                    <li>Document Quarantine (OWASP LLM02)</li>
                    <li>Plugin Sanitizer (OWASP LLM07)</li>
                    <li>Human Confirmation Gates (OWASP LLM06)</li>
                  </ul>
                </div>
              </div>
            </details>

            <button type="button" className="close-modal-btn text-sm" onClick={() => setShowVictory(false)}>
              Back to Challenges
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
