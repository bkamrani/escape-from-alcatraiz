import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { LEVELS, type LevelMeta } from './levels.ts'

type Msg = { role: 'user' | 'assistant'; content: string }

type InspectorEvent =
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string; tainted?: boolean }
  | { type: 'defense_block'; layer: string; message: string }
  | { type: 'pending_action'; id: string; name: string; input: Record<string, unknown> }

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
  const [manualFlag, setManualFlag] = useState('')
  const [flagStatus, setFlagStatus] = useState<{ success: boolean; msg: string } | null>(null)
  const [showVictory, setShowVictory] = useState(false)

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

  const selectLevel = (lvl: 1 | 2 | 3 | 4) => {
    setCurrentLevel(lvl)
    setMessages([])
    setEvents([])
    setFlagStatus(null)
    setManualFlag('')
  }

  const resetCurrentLevel = () => {
    setMessages([])
    setEvents([])
    setFlagStatus(null)
    setManualFlag('')
    setDefense(false)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return

    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    setFlagStatus(null)

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: currentLevel, defense, messages: next }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Request failed')

      setMessages([...next, { role: 'assistant', content: data.reply }])
      setEvents(data.events || [])

      if (data.won) {
        setSolvedLevels((prev) => new Set([...prev, currentLevel]))
        if (data.flag) {
          setCapturedFlags((prev) => ({ ...prev, [currentLevel]: data.flag }))
        }
        if (currentLevel === 4) {
          setShowVictory(true)
        }
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

  return (
    <div className="game-shell">
      {/* Top Navigation */}
      <header className="top-nav">
        <div className="brand-section">
          <div className="brand-logo">
            <span>☠</span> AGENTBREAKER
          </div>
          <span className="brand-badge">CTF · OWASP LLM Top 10</span>
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
            <div className="badge-row">
              <span className="owasp-badge">{meta.owasp}</span>
              <span className="points-badge">{meta.points} Pts</span>
            </div>

            <div className="objective-box">
              <strong>Objective:</strong>
              {meta.objective}
            </div>

            <p className="description-text">{meta.description}</p>
          </div>

          {/* Tiered Hints */}
          <div className="hints-card">
            <div className="panel-title" style={{ fontSize: 12 }}>
              💡 Tactical Intel (Tiered Hints)
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
              <span>{defense ? '🛡️ DEFENDED' : '🔴 VULNERABLE'}</span>
            </div>
          </div>

          <div className="chat-history">
            {messages.length === 0 ? (
              <div className="chat-empty-state">
                <div style={{ fontSize: 32 }}>⚡</div>
                <div>Connection established with {meta.botName}.</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  Craft your injection payload or use the hint intel to trigger a tool exploit.
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
                placeholder={`Attack ${meta.botName} (press Enter to send)…`}
                rows={1}
                disabled={busy}
              />
              <button type="submit" className="send-btn" disabled={busy || !input.trim()}>
                Send
              </button>
            </form>
          </div>
        </section>

        {/* Panel 3: Defense Lab & Inspector */}
        <section className="panel defense-panel" aria-label="Defense Lab and Tool Inspector">
          <div className="panel-header">
            <span className="panel-title">🛡️ Defense Lab & Inspector</span>
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
                <span>Defense Mitigation</span>
              </label>
              <span className={`defense-badge-state ${defense ? 'defended' : 'vulnerable'}`}>
                {defense ? 'ACTIVE' : 'OFF'}
              </span>
            </div>

            <div className="defense-explanation-box">
              <strong>{meta.defense.title}</strong>
              <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>{meta.defense.summary}</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--panel-border)', paddingTop: 6 }}>
                {meta.defense.details}
              </div>
            </div>
          </div>

          {/* DEFENSE BLOCKED Prominent Banner */}
          {defenseBlockEvents.length > 0 && (
            <div className="defense-blocked-banner">
              <div className="defense-blocked-header">
                <span>🛡️</span> DEFENSE BLOCKED
              </div>
              <div className="defense-blocked-msg">
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

      {/* Victory Modal */}
      {showVictory && (
        <div className="modal-overlay">
          <div className="victory-card">
            <div style={{ fontSize: 48 }}>🏆</div>
            <h2 className="victory-title">CTF CHALLENGE COMPLETED!</h2>
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

            <div style={{ textAlign: 'left', fontSize: 12, color: 'var(--text-muted)' }}>
              <strong>Mitigations Mastered:</strong>
              <ul style={{ margin: '8px 0 0 16px', padding: 0, lineHeight: 1.6 }}>
                <li>OWASP LLM01: Prompt Injection & Output Filtering</li>
                <li>OWASP LLM02: Dual-LLM Quarantine & Data Delimiters</li>
                <li>OWASP LLM07: MCP Manifest Sanitizer & Schema Sandbox</li>
                <li>OWASP LLM06: Human-in-the-Loop Confirmation Gates</li>
              </ul>
            </div>

            <button className="close-modal-btn" onClick={() => setShowVictory(false)}>
              Back to Arena
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
