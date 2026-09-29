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
  if (score >= 1000) return 'Agent Breaker'
  if (score >= 700) return 'Agent Whisperer'
  if (score >= 300) return 'Prompt Poker'
  return 'Script Kiddie'
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
        setFlagStatus({ success: true, msg: '🚩 Correct flag captured!' })
        setRoundWon(true)
        setSolvedLevels((prev) => new Set([...prev, currentLevel]))
        setCapturedFlags((prev) => ({ ...prev, [currentLevel]: flagToTest }))
        if (currentLevel === 4) setShowVictory(true)
      } else {
        setFlagStatus({ success: false, msg: '❌ Incorrect flag. Keep probing!' })
      }
    } catch {
      setFlagStatus({ success: false, msg: 'Network error validating flag.' })
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

      if (data.events) {
        setEvents((prev) => [...prev, ...data.events])
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

  // Exploit Card Click: appends cleanly to input
  const handleCardClick = (card: ExploitCard) => {
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
      return {
        icon: '⚡',
        title: `The assistant reached for: ${evt.name}`,
        sub: `Parameters: ${JSON.stringify(evt.input)}`,
      }
    }
    if (evt.type === 'tool_result') {
      if (evt.tainted) {
        return {
          icon: '⚠️',
          title: `It trusted poisoned data from: ${evt.name}`,
          sub: evt.output.slice(0, 140),
        }
      }
      return {
        icon: '📥',
        title: `Tool responded with clean data: ${evt.name}`,
        sub: evt.output.slice(0, 140),
      }
    }
    if (evt.type === 'defense_block') {
      return {
        icon: '🛡️',
        title: `A safety guard stepped in: ${evt.layer}`,
        sub: evt.message,
      }
    }
    if (evt.type === 'pending_action') {
      return {
        icon: '👤',
        title: `A human was asked to approve: ${evt.name}`,
        sub: 'High-risk action held in queue until administrator confirmation.',
      }
    }
    return {
      icon: 'ℹ️',
      title: 'Action recorded in audit log',
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
          <span className="brand-badge">CTF · AI Security Lab</span>
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
          <div className="stat-chip">
            <span>Score:</span>
            <span className="stat-value">{totalScore} pts</span>
          </div>
          <button className="hint-trigger-btn" onClick={resetCurrentLevel} title="Reset current chat and events">
            ↺ Reset Level
          </button>
        </div>
      </header>

      {/* Main 3-Panel Arena */}
      <main className="main-arena">
        {/* Panel 1: Mission Briefing */}
        <section className="panel mission-panel" aria-label="Mission Briefing">
          <div className="panel-header">
            <span className="panel-title">🎯 Mission Briefing</span>
            <span className="points-badge">Level {currentLevel} of 4</span>
          </div>

          <div className="mission-card">
            <h2 className="level-title-large">{meta.name}</h2>
            <div style={{ fontSize: 12, color: 'var(--accent-cyan)', marginBottom: 8, fontWeight: 600 }}>
              {meta.subtitle}
            </div>

            <div className="badge-row">
              <span className="owasp-badge" title={meta.owaspPlain}>
                {meta.owasp}
              </span>
              <span className="points-badge">+{meta.points} Pts</span>
            </div>

            <div className="objective-box">
              <strong>Your Mission:</strong>
              {meta.objective}
            </div>

            <p className="description-text">{meta.description}</p>
          </div>

          {/* Tiered Hints */}
          <div className="hints-card">
            <div className="panel-title" style={{ fontSize: 12 }}>
              💡 Tactical Intel (Hints)
            </div>

            {meta.hints.map((h) => {
              const isRevealed = (revealedHints[currentLevel] || 0) >= h.tier
              return (
                <div key={h.tier} className="hint-row">
                  {!isRevealed ? (
                    <button className="hint-trigger-btn" onClick={() => revealHintTier(h.tier)}>
                      <span>Reveal Hint #{h.tier}</span>
                      <span style={{ color: '#fbbf24' }}>-{h.cost} pts</span>
                    </button>
                  ) : (
                    <div className="hint-content-box">
                      <strong>Hint #{h.tier}:</strong> {h.text}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Demo Attack Button */}
            {((revealedHints[currentLevel] || 0) >= 3 || isDemoAlways) && (
              <button className="demo-attack-btn" onClick={fillDemoAttack}>
                ⚡ Insert 1-Click Demo Attack
              </button>
            )}
          </div>

          {/* Flag Submission */}
          <div className="flag-card">
            <div className="panel-title" style={{ fontSize: 12, marginBottom: 8 }}>
              🚩 Capture The Flag
            </div>

            {solvedLevels.has(currentLevel) ? (
              <div className="flag-status-alert success">
                <strong>Level Solved!</strong>
                <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                  Flag: {capturedFlags[currentLevel] || 'Captured'}
                </div>
                <button
                  type="button"
                  className="replay-trigger-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => startReplay()}
                >
                  🎬 Replay the Heist
                </button>
              </div>
            ) : (
              <form className="flag-form" onSubmit={submitManualFlag}>
                <label htmlFor="manual-flag-input" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  Submit extracted flag:
                </label>
                <input
                  id="manual-flag-input"
                  className="flag-input"
                  value={manualFlag}
                  onChange={(e) => setManualFlag(e.target.value)}
                  placeholder="FLAG{...}"
                  autoComplete="off"
                />
                <button type="submit" className="flag-submit-btn">
                  Verify Flag
                </button>
                {flagStatus && (
                  <div className={`flag-status-alert ${flagStatus.success ? 'success' : 'error'}`}>{flagStatus.msg}</div>
                )}
              </form>
            )}
          </div>

          {/* Referee Verdict Card */}
          {(refereeLoading || refereeVerdict) && (
            <div className="referee-card">
              <div className="referee-header">
                <span className="referee-title">⚖️ Guild Referee</span>
                {refereeLoading ? (
                  <span className="verdict-chip offline">Judging…</span>
                ) : (
                  <span className={`verdict-chip ${refereeVerdict?.verdict || 'offline'}`}>
                    {refereeVerdict?.source === 'offline' ? 'Referee Offline' : refereeVerdict?.verdict}
                  </span>
                )}
              </div>

              {refereeLoading ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  Evaluating play transcript against OWASP criteria with Guild agent…
                </div>
              ) : refereeVerdict?.source === 'offline' ? (
                <div className="referee-body">
                  <div style={{ color: 'var(--text-muted)' }}>
                    Referee agent is offline (set GUILD_API_KEY in .env to enable live judging).
                  </div>
                  <a
                    href="https://app.guild.ai/users/ali-mo/workspaces/agentbreaker"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="referee-link"
                  >
                    Judged by a Guild agent (ali-mo~agentbreaker-referee) ↗
                  </a>
                </div>
              ) : (
                <div className="referee-body">
                  <div className="referee-field">
                    <strong>Technique:</strong>
                    <span>{refereeVerdict?.technique}</span>
                  </div>
                  <div className="referee-field">
                    <strong>Score:</strong>
                    <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>
                      +{refereeVerdict?.points} pts
                    </span>
                  </div>
                  <div className="referee-field">
                    <strong>Takeaway:</strong>
                    <span>{refereeVerdict?.takeaway}</span>
                  </div>
                  <a
                    href="https://app.guild.ai/users/ali-mo/workspaces/agentbreaker"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="referee-link"
                  >
                    Judged by a Guild agent (ali-mo~agentbreaker-referee) ↗
                  </a>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Panel 2: Live Agent Chat */}
        <section className="chat-panel" aria-label="Live Agent Chat">
          <div className="chat-agent-header">
            <div className="agent-profile">
              <div className="agent-avatar">🤖</div>
              <div className="agent-info">
                <h3>{meta.botName}</h3>
                <p>{meta.botRole}</p>
              </div>
            </div>
            <div className={`defense-badge-state ${defense ? 'defended' : 'vulnerable'}`}>
              <span>{defense ? '🛡️ GUARD UP' : '🔴 VULNERABLE'}</span>
            </div>
          </div>

          <div className="chat-history">
            {messages.length === 0 ? (
              <div className="chat-empty-state">
                <div style={{ fontSize: 32 }}>⚡</div>
                <div>Connection established with {meta.botName}.</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  Stack trick cards below to compose your attack, or type a custom prompt.
                </div>
              </div>
            ) : (
              messages.map((m, i) => {
                const isAssistant = m.role === 'assistant'
                const hasFlag = m.content.includes('FLAG{')
                return (
                  <div key={i} className={`chat-msg ${m.role}`}>
                    <span className="msg-sender">{isAssistant ? meta.botName : 'Attacker (You)'}</span>
                    <div className={`msg-bubble ${hasFlag ? 'won-bubble' : ''}`}>{m.content}</div>
                  </div>
                )
              })
            )}

            {/* Playful Win Micro-Copy Toast */}
            {roundWon && (
              <div className="win-toast">
                <div className="win-toast-msg">
                  <span>🏆</span> Nice. The bot just betrayed its owner!
                </div>
                {events.length > 0 && (
                  <button type="button" className="replay-trigger-btn" onClick={() => startReplay()}>
                    🎬 Replay the Heist
                  </button>
                )}
              </div>
            )}

            {busy && (
              <div className="chat-msg assistant">
                <span className="msg-sender">{meta.botName}</span>
                <div className="msg-bubble" style={{ color: 'var(--accent-cyan)' }}>
                  Thinking & evaluating tool invocations…
                </div>
              </div>
            )}
            <div id="chat-scroll-target" />
          </div>

          <div className="chat-input-bar">
            {/* Suspicion Meter (Cosmetic) */}
            <div className="suspicion-bar-wrap">
              <span className="suspicion-label">
                Bot Suspicion:{' '}
                {suspicionScore < 30 ? '🟢 Normal' : suspicionScore < 65 ? '🟡 Guarded' : '🔴 High Alert'}
              </span>
              <div className="suspicion-track" title="Real-time heuristic analysis of your prompt keywords">
                <div
                  className={`suspicion-fill ${
                    suspicionScore < 30 ? 'low' : suspicionScore < 65 ? 'medium' : 'high'
                  }`}
                  style={{ width: `${Math.max(8, suspicionScore)}%` }}
                />
              </div>
            </div>

            <form
              className="input-form"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <label htmlFor="agent-chat-input" className="sr-only" style={{ display: 'none' }}>
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
                placeholder={`Attack ${meta.botName} (stack cards below or type)…`}
                rows={1}
                disabled={busy}
              />
              <button type="submit" className="send-btn" disabled={busy || !input.trim()}>
                Send
              </button>
            </form>

            {/* Feature 1: Exploit Card Deck */}
            <div className="exploit-deck" aria-label="Exploit Card Deck">
              <div className="deck-header">
                <span className="deck-title">
                  <span>🃏</span> Exploit Deck
                </span>
                <span className="deck-subhint">Stack a card from each color, then hit Send:</span>
                {input.trim() && (
                  <button
                    type="button"
                    className="deck-clear-btn"
                    onClick={() => setInput('')}
                    title="Clear text in the input"
                  >
                    Clear Input ✕
                  </button>
                )}
              </div>

              <div className="deck-cards-row">
                {meta.cards.map((card) => {
                  const typeClass = card.type.toLowerCase()
                  const icon = card.type === 'PERSONA' ? '🎭' : card.type === 'FRAMING' ? '🧪' : '⚡'
                  return (
                    <button
                      key={card.id}
                      type="button"
                      className={`trick-card ${typeClass}`}
                      onClick={() => handleCardClick(card)}
                      title={`Add: "${card.text}"`}
                    >
                      <span>{icon}</span>
                      <span className="card-type-chip">{card.type}</span>
                      <span>{card.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Panel 3: Defense Lab & Inspector */}
        <section className="panel defense-panel" aria-label="Defense Lab and Tool Inspector">
          <div className="panel-header">
            <span className="panel-title">🛡️ Safety Guard & Inspector</span>
          </div>

          {/* Defense Toggle */}
          <div className="defense-toggle-card">
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
                <span>Safety Guard</span>
              </label>
              <span className={`defense-badge-state ${defense ? 'defended' : 'vulnerable'}`}>
                {defense ? 'GUARD UP' : 'OFF'}
              </span>
            </div>

            <div className="defense-explanation-box">
              <strong>{meta.defense.title}</strong>
              <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>
                <strong>What the guard does: </strong>
                {meta.defense.summary}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--panel-border)', paddingTop: 6 }}>
                <strong>Why the trick stops: </strong>
                {meta.defense.details}
              </div>
              <div style={{ fontSize: 11, color: '#38bdf8', marginTop: 6, fontStyle: 'italic' }}>
                💡 {meta.defense.analogy}
              </div>
            </div>
          </div>

          {/* DEFENSE BLOCKED Prominent Banner */}
          {defenseBlockEvents.length > 0 && (
            <div className="guard-up-banner">
              <div className="guard-up-title">
                <span>🛡️</span> GUARD UP! The same trick bounced off.
              </div>
              <div className="guard-up-text">
                {defenseBlockEvents[0]?.message}
              </div>
            </div>
          )}

          {/* Tool Call Inspector */}
          <div className="inspector-card">
            <div className="panel-title" style={{ fontSize: 12 }}>
              ⚙️ Tool Call Inspector ({events.length})
            </div>

            <div className="inspector-feed">
              {events.length === 0 ? (
                <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 8 }}>
                  No tools invoked in the last round. Send a prompt to observe agentic tool calls in real time.
                </div>
              ) : (
                events.map((evt, idx) => {
                  if (evt.type === 'tool_call') {
                    return (
                      <div key={idx} className="feed-event tool-call">
                        <div className="event-header">
                          <span className="event-type-call">⚡ TOOL CALL</span>
                          <span>{evt.name}</span>
                        </div>
                        <div className="event-body">{JSON.stringify(evt.input, null, 2)}</div>
                      </div>
                    )
                  }

                  if (evt.type === 'tool_result') {
                    return (
                      <div key={idx} className={`feed-event tool-result ${evt.tainted ? 'tainted' : ''}`}>
                        <div className="event-header">
                          <span className={evt.tainted ? 'event-type-tainted' : 'event-type-result'}>
                            {evt.tainted ? '⚠️ TAINTED RESULT' : '📥 TOOL RESULT'}
                          </span>
                          <span>{evt.name}</span>
                        </div>
                        {evt.tainted && (
                          <div style={{ margin: '2px 0 4px 0' }}>
                            <span className="dirty-data-badge">Dirty data: the assistant trusted this.</span>
                          </div>
                        )}
                        <div className="event-body">{evt.output}</div>
                      </div>
                    )
                  }

                  if (evt.type === 'defense_block') {
                    return (
                      <div key={idx} className="feed-event defense-block">
                        <div className="event-header">
                          <span className="event-type-block">🛡️ DEFENSE BLOCK</span>
                          <span>{evt.layer}</span>
                        </div>
                        <div className="event-body">{evt.message}</div>
                      </div>
                    )
                  }

                  if (evt.type === 'pending_action') {
                    return (
                      <div key={idx} className="feed-event tool-call">
                        <div className="event-header">
                          <span style={{ color: '#fbbf24' }}>⏳ PENDING ACTION</span>
                          <span>{evt.name}</span>
                        </div>
                        <div className="event-body">{JSON.stringify(evt.input, null, 2)}</div>
                        <div className="pending-action-card">
                          <div className="pending-title">
                            <span>⚠️</span> Human Confirmation Required
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            High-risk operation intercepted. Explicit dual-custody authorization required to execute.
                          </div>
                          <div className="pending-btn-row">
                            <button
                              type="button"
                              className="approve-btn"
                              disabled={busy}
                              onClick={() => void handleApproveAction(evt.id, true)}
                            >
                              ✓ Approve & Execute
                            </button>
                            <button
                              type="button"
                              className="deny-btn"
                              disabled={busy}
                              onClick={() => void handleApproveAction(evt.id, false)}
                            >
                              ✕ Deny & Abort
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
        </section>
      </main>

      {/* Feature 3: Attack Replay Modal ("What just happened?") */}
      {showReplay && replayEvents.length > 0 && (
        <div className="modal-overlay">
          <div className="replay-card">
            <div className="replay-header">
              <div className="replay-title">
                <span>🎬</span> Attack Replay: The Heist Step-by-Step
              </div>
              <div className="replay-progress-chip">
                Step {replayStep + 1} of {replayEvents.length}
              </div>
            </div>

            {/* Level 4 Wire Transfer Ticking Counter */}
            {currentLevel === 4 && (
              <div className="wire-transfer-counter">
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-main)' }}>
                  💸 Unauthorized Funds Exfiltrated:
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
                      <div className="replay-step-caption">{info.title}</div>
                      {info.sub && <div className="replay-step-sub">{info.sub}</div>}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="replay-controls">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="replay-btn"
                  onClick={() => {
                    setReplayStep(0)
                    setReplayPlaying(true)
                  }}
                >
                  ↺ Restart
                </button>
                <button
                  type="button"
                  className="replay-btn"
                  onClick={() => setReplayPlaying(!replayPlaying)}
                >
                  {replayPlaying ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  type="button"
                  className="replay-btn"
                  disabled={replayStep >= replayEvents.length - 1}
                  onClick={() => {
                    setReplayPlaying(false)
                    setReplayStep((prev) => Math.min(replayEvents.length - 1, prev + 1))
                  }}
                >
                  Next Step ⏭
                </button>
              </div>

              <button
                type="button"
                className="replay-btn primary"
                onClick={() => {
                  setShowReplay(false)
                  setReplayPlaying(false)
                }}
              >
                Close Replay ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feature 2: Victory Modal with Loot Drop, Rank Title & CSS Confetti */}
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

            <div style={{ fontSize: 44 }}>🏆</div>
            <h2 className="victory-title">CTF CHALLENGE COMPLETED!</h2>

            {/* Rank Title Based on Score */}
            <div className="rank-badge">
              <span>🎖️ Rank Achieved:</span>
              <span style={{ color: 'var(--accent-cyan)' }}>{getRankTitle(totalScore)}</span>
            </div>

            <p className="victory-subtitle">AI Security Engineer Certification Ready</p>

            <div className="victory-stats">
              <div className="victory-stat-item">
                <strong>4 / 4</strong>
                <span>Levels Solved</span>
              </div>
              <div className="victory-stat-item">
                <strong>{totalScore}</strong>
                <span>Final Score</span>
              </div>
            </div>

            {/* Loot Drop Section */}
            <div className="loot-drop-card">
              <span className="loot-label">🎁 Trophy Loot Drop Captured:</span>
              <span className="loot-flag">{capturedFlags[4] || capturedFlags[1] || 'FLAG{all_levels_conquered_2026}'}</span>
            </div>

            {/* Replay Option */}
            {events.length > 0 && (
              <button
                type="button"
                className="replay-btn primary"
                style={{ alignSelf: 'center' }}
                onClick={() => {
                  setShowVictory(false)
                  startReplay()
                }}
              >
                🎬 Replay the Heist
              </button>
            )}

            {refereeVerdict && (
              <div
                style={{
                  background: 'rgba(99, 102, 241, 0.1)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  borderRadius: 8,
                  padding: 12,
                  textAlign: 'left',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <strong>⚖️ Guild Referee Evaluation:</strong>
                  <span className={`verdict-chip ${refereeVerdict.verdict}`}>{refereeVerdict.verdict}</span>
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong>Technique:</strong> {refereeVerdict.technique}
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong>Takeaway:</strong> {refereeVerdict.takeaway}
                </div>
                <a
                  href="https://app.guild.ai/users/ali-mo/workspaces/agentbreaker"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="referee-link"
                >
                  Judged by a Guild agent (ali-mo~agentbreaker-referee) ↗
                </a>
              </div>
            )}

            <div style={{ textAlign: 'left', fontSize: 12, color: 'var(--text-muted)' }}>
              <strong>Safety Guards Mastered:</strong>
              <ul style={{ margin: '8px 0 0 16px', padding: 0, lineHeight: 1.6 }}>
                <li>OWASP LLM01: Prompt Injection & Output Filtering</li>
                <li>OWASP LLM02: Dual-LLM Quarantine & Data Delimiters</li>
                <li>OWASP LLM07: MCP Manifest Sanitizer & Schema Sandbox</li>
                <li>OWASP LLM06: Human-in-the-Loop Confirmation Gates</li>
              </ul>
            </div>

            <button type="button" className="close-modal-btn" onClick={() => setShowVictory(false)}>
              Back to Arena
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
