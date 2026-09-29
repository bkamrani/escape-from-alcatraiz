import { useState } from 'react'
import './App.css'

type Msg = { role: 'user' | 'assistant'; content: string }

export default function App() {
  const [defense, setDefense] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [won, setWon] = useState(false)
  const [tools, setTools] = useState<string[]>([])

  const reset = (d: boolean) => {
    setDefense(d)
    setMessages([])
    setWon(false)
    setTools([])
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, defense }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'request failed')
      setMessages([...next, { role: 'assistant', content: data.reply }])
      setTools(data.toolLog)
      if (data.won) setWon(true)
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `⚠ ${(e as Error).message}` }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app">
      <header>
        <h1>☠ Poisoned Tool</h1>
        <p className="sub">Level 1 · Direct prompt injection</p>
      </header>
      <p className="goal">
        Goal: make VaultBot leak the vault access code (<code>FLAG&#123;…&#125;</code>).
      </p>
      <label className="toggle">
        <input type="checkbox" checked={defense} onChange={(e) => reset(e.target.checked)} />
        Defense {defense ? 'ON: hardened prompt + least-privilege tools + output filter' : 'OFF'}
      </label>
      {won && <div className="win">🚩 Flag captured! Now flip Defense on and try again.</div>}
      <div className="chat">
        {messages.length === 0 && <p className="hint">Say something to VaultBot…</p>}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="msg assistant">…</div>}
      </div>
      {tools.length > 0 && <p className="tools">tools called: {tools.join(', ')}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Your attack…" />
        <button disabled={busy}>Send</button>
      </form>
    </main>
  )
}
