import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Bot, RefreshCw, Send, Sparkles, X } from 'lucide-react'
import { answerRenewalAssistantQuestion, RENEWAL_ASSISTANT_PROMPTS, type RenewalAssistantAnswer } from './renewalAssistantAnalysis'
import type { RenewalClient } from './renewalCommand'
import { renewalApi } from './renewalCommandClient'
import logoMark from './assets/leakline-mark.svg'

type LeakLineAssistantProps = {
  workspaceId: string
  workspaceName: string
  onOpenRenewalCommand: () => void
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text?: string
  answer?: RenewalAssistantAnswer
}

export default function LeakLineAssistant({ workspaceId, workspaceName, onOpenRenewalCommand }: LeakLineAssistantProps) {
  const [open, setOpen] = useState(false)
  const [clients, setClients] = useState<RenewalClient[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const messagesRef = useRef<HTMLDivElement>(null)

  const loadClients = async () => {
    setLoading(true)
    setLoadError('')
    try {
      const body = await renewalApi<{ clients: RenewalClient[] }>('/api/renewal-clients')
      setClients(body.clients)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Renewal data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setMessages([])
    setClients([])
    setLoadError('')
  }, [workspaceId])

  useEffect(() => {
    if (open) void loadClients()
  }, [open, workspaceId])

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  const askQuestion = (question: string) => {
    const trimmed = question.trim()
    if (!trimmed || loading) return
    const answer = loadError
      ? {
          kind: 'empty' as const,
          title: 'I could not read the renewal records',
          summary: loadError,
          items: [],
          note: 'Refresh the data and try again.',
        }
      : answerRenewalAssistantQuestion(clients, trimmed)
    const timestamp = Date.now()
    setMessages((current) => [
      ...current,
      { id: `user-${timestamp}`, role: 'user', text: trimmed },
      { id: `assistant-${timestamp}`, role: 'assistant', answer },
    ])
    setDraft('')
  }

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault()
    askQuestion(draft)
  }

  return <>
    {open && <section className="leakline-assistant-panel" role="dialog" aria-label="LeakLine renewal assistant">
      <header className="leakline-assistant-header">
        <div className="leakline-assistant-icon"><Bot size={20} /></div>
        <div><strong>LeakLine Assistant</strong><span>Renewal analyst preview</span></div>
        <button type="button" aria-label="Close LeakLine assistant" onClick={() => setOpen(false)}><X size={18} /></button>
      </header>

      <div className="leakline-assistant-scope">
        <span><i /> {workspaceName}</span>
        <em>Read-only</em>
      </div>

      <div className="leakline-assistant-messages" ref={messagesRef} aria-live="polite">
        {!messages.length && <div className="leakline-assistant-welcome">
          <Sparkles size={21} />
          <h2>Ask about your renewal clients.</h2>
          <p>I use the current workspace’s program activity, feedback and renewal records. I will tell you when the data cannot support an answer.</p>
        </div>}

        {messages.map((message) => message.role === 'user'
          ? <div className="leakline-assistant-user-message" key={message.id}>{message.text}</div>
          : <article className={`leakline-assistant-answer ${message.answer?.kind ?? ''}`} key={message.id}>
              <strong>{message.answer?.title}</strong>
              <p>{message.answer?.summary}</p>
              {message.answer?.items.map((item) => <div className="leakline-assistant-result" key={item.id}>
                <b>{item.heading}</b>
                <span>{item.evidence}</span>
                {item.recommendation && <small>{item.recommendation}</small>}
              </div>)}
              {message.answer?.note && <em>{message.answer.note}</em>}
              {message.answer?.kind === 'answer' && message.answer.items.some((item) => item.id.startsWith('renewal-') || clients.some((client) => client.id === item.id)) && <button type="button" onClick={() => { onOpenRenewalCommand(); setOpen(false) }}>Open Renewal Command <ArrowRight size={14} /></button>}
            </article>)}

        {loading && <div className="leakline-assistant-loading"><RefreshCw className="spin" size={16} /> Reading permitted renewal records…</div>}
        {loadError && !loading && <div className="leakline-assistant-error"><span>{loadError}</span><button type="button" onClick={() => void loadClients()}>Retry</button></div>}
      </div>

      <div className="leakline-assistant-prompts">
        {RENEWAL_ASSISTANT_PROMPTS.map((prompt) => <button type="button" key={prompt} disabled={loading} onClick={() => askQuestion(prompt)}>{prompt}</button>)}
      </div>

      <form className="leakline-assistant-compose" onSubmit={submitQuestion}>
        <input aria-label="Ask LeakLine about renewal clients" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about renewal clients…" disabled={loading} />
        <button type="submit" aria-label="Send question" disabled={!draft.trim() || loading}><Send size={17} /></button>
      </form>
    </section>}

    <button
      type="button"
      className={`leakline-assistant-bubble ${open ? 'open' : ''}`}
      aria-label={open ? 'Close LeakLine assistant' : 'Open LeakLine assistant'}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      {open ? <X size={23} /> : <><img src={logoMark} alt="" aria-hidden="true" /><span>Ask LeakLine</span></>}
    </button>
  </>
}
