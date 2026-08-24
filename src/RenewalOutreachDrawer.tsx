import { type FormEvent, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, MessageSquareQuote, MessageSquareText, RefreshCw, Send, Sparkles, Smartphone, X } from 'lucide-react'
import { recommendedRenewalOutreachKind, type RenewalClient, type RenewalOutreachActivity, type RenewalOutreachKind } from './renewalCommand'
import { renewalApi } from './renewalCommandClient'

type RenewalOutreachPreview = {
  channel: 'sms' | 'email'
  kind: RenewalOutreachKind
  to?: string
  body: string
  templateKey: string
  canSend: boolean
  reason: string
  daysRemaining?: number
  history: RenewalOutreachActivity[]
}

type QuoConversationMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  status: string
  createdAt: string
}

type RenewalReplySuggestion = {
  intent: 'ready_to_continue' | 'positive_feedback' | 'webinar_blocked' | 'needs_support' | 'timing_or_budget' | 'not_interested' | 'opt_out' | 'unclear'
  label: string
  rationale: string
  body: string
  recommendedNextAction: string
  sourceMessageId: string
}

type Props = {
  client: RenewalClient
  defaultKind?: RenewalOutreachKind
  onClose: () => void
  onClientUpdated: (client: RenewalClient) => void
  onNotice: (message: string) => void
}

export default function RenewalOutreachDrawer({ client, defaultKind, onClose, onClientUpdated, onNotice }: Props) {
  const initialKind = defaultKind ?? recommendedRenewalOutreachKind(client)
  const [activeClient, setActiveClient] = useState(client)
  const [kind, setKind] = useState<RenewalOutreachKind>(initialKind)
  const [preview, setPreview] = useState<RenewalOutreachPreview>()
  const [body, setBody] = useState('')
  const [approved, setApproved] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [messages, setMessages] = useState<QuoConversationMessage[]>([])
  const [replySuggestion, setReplySuggestion] = useState<RenewalReplySuggestion>()
  const [reply, setReply] = useState('')
  const [replyApproved, setReplyApproved] = useState(false)
  const [conversationError, setConversationError] = useState('')
  const [suppressionReason, setSuppressionReason] = useState('')
  const handledInboundId = useRef('')
  const latestSuggestedInboundId = useRef('')

  const prepareDraft = async (nextKind: RenewalOutreachKind) => {
    setBusy('preview')
    setError('')
    setApproved(false)
    try {
      const result = await renewalApi<RenewalOutreachPreview>(`/api/renewal-clients/${activeClient.id}/outreach/preview`, {
        method: 'POST',
        body: JSON.stringify({ kind: nextKind, channel: 'sms' }),
      })
      setPreview(result)
      setBody(result.body)
    } catch (event) {
      setPreview(undefined)
      setError(event instanceof Error ? event.message : 'The SMS draft could not be prepared.')
    } finally {
      setBusy('')
    }
  }

  const loadConversation = async (quiet = false) => {
    if (!activeClient.phone) {
      setMessages([])
      setConversationError('Add a mobile number to this client before opening the Quo conversation.')
      return
    }
    if (!quiet) setBusy('conversation')
    try {
      const result = await renewalApi<{ client?: RenewalClient; messages: QuoConversationMessage[]; suggestion?: RenewalReplySuggestion; suppressionReason?: string }>(`/api/renewal-clients/${activeClient.id}/conversation`)
      if (result.client) {
        setActiveClient(result.client)
        onClientUpdated(result.client)
      }
      setMessages(result.messages)
      setSuppressionReason(result.suppressionReason ?? '')
      if (result.suggestion?.sourceMessageId && result.suggestion.sourceMessageId !== latestSuggestedInboundId.current) {
        latestSuggestedInboundId.current = result.suggestion.sourceMessageId
        setReplyApproved(false)
      }
      setReplySuggestion(result.suggestion?.sourceMessageId === handledInboundId.current ? undefined : result.suggestion)
      setConversationError('')
    } catch (event) {
      setConversationError(event instanceof Error ? event.message : 'The Quo conversation could not be loaded.')
    } finally {
      if (!quiet) setBusy('')
    }
  }

  useEffect(() => {
    void prepareDraft(initialKind)
    void loadConversation()
    const timer = window.setInterval(() => void loadConversation(true), 10_000)
    return () => window.clearInterval(timer)
  }, [client.id])

  const changeDraft = (nextKind: RenewalOutreachKind) => {
    setKind(nextKind)
    setIdempotencyKey(crypto.randomUUID())
    void prepareDraft(nextKind)
  }

  const sendOpeningMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preview || !approved) return
    setBusy('sending')
    setError('')
    try {
      const result = await renewalApi<{ client: RenewalClient; simulated: boolean }>(`/api/renewal-clients/${activeClient.id}/outreach/send`, {
        method: 'POST',
        body: JSON.stringify({ kind, channel: 'sms', body, approved: true, idempotencyKey }),
      })
      setActiveClient(result.client)
      onClientUpdated(result.client)
      setPreview((current) => current ? { ...current, history: [...(result.client.outreach ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt)) } : current)
      setApproved(false)
      setIdempotencyKey(crypto.randomUUID())
      onNotice(`SMS ${result.simulated ? 'simulated' : 'sent'} for ${result.client.name}.`)
      await loadConversation(true)
    } catch (event) {
      setIdempotencyKey(crypto.randomUUID())
      setError(event instanceof Error ? event.message : 'The SMS could not be sent through Quo.')
    } finally {
      setBusy('')
    }
  }

  const sendReply = async () => {
    if (!reply.trim() || !replyApproved) return
    setBusy('reply')
    setConversationError('')
    try {
      const latestInbound = [...messages].reverse().find((message) => message.direction === 'inbound')
      const result = await renewalApi<{ client: RenewalClient }>(`/api/renewal-clients/${activeClient.id}/conversation/send`, {
        method: 'POST',
        body: JSON.stringify({ body: reply.trim(), approved: true, idempotencyKey: crypto.randomUUID(), sourceMessageId: latestInbound?.id }),
      })
      handledInboundId.current = latestInbound?.id ?? ''
      setActiveClient(result.client)
      onClientUpdated(result.client)
      setReply('')
      setReplyApproved(false)
      setReplySuggestion(undefined)
      onNotice(`SMS sent through Quo to ${result.client.name}.`)
      await loadConversation(true)
    } catch (event) {
      setConversationError(event instanceof Error ? event.message : 'The SMS could not be sent through Quo.')
    } finally {
      setBusy('')
    }
  }

  return <div className="connection-modal-backdrop renewal-conversation-backdrop" onClick={onClose}>
    <form className="connection-modal renewal-outreach-modal" onSubmit={sendOpeningMessage} onClick={(event) => event.stopPropagation()}>
      <button type="button" className="modal-close" aria-label="Close SMS drawer" onClick={onClose}><X size={18} /></button>
      <span className="eyebrow">Assisted SMS outreach</span>
      <h2>Message {activeClient.name}</h2>
      <p>Review the suggested message, see the live conversation and send approved SMS through Quo.</p>
      {error && <div className="modal-error"><AlertTriangle size={14} /><span>{error}</span></div>}

      <div className="renewal-outreach-layout">
        <section className="renewal-outreach-draft">
          <div className="renewal-outreach-context">
            <span><strong>{preview?.daysRemaining !== undefined ? preview.daysRemaining < 0 ? `${Math.abs(preview.daysRemaining)} days past completion` : `${preview.daysRemaining} days remaining` : 'Message at any program stage'}</strong><small>{preview?.templateKey.replaceAll('_', ' ') ?? 'Preparing draft…'}</small></span>
            <em className={preview?.canSend ? 'ready' : 'blocked'}>{preview?.canSend ? 'Ready for approval' : 'Setup required'}</em>
          </div>

          <div className="renewal-outreach-controls">
            <label>Message purpose<select value={kind} onChange={(event) => changeDraft(event.target.value as RenewalOutreachKind)}>
              <option value="va_upsell_opener">VA interest follow-up</option>
              <option value="programme_check_in">Program check-in</option>
              <option value="webinar_accountability">Webinar accountability</option>
              <option value="renewal_window_review">Warm progress check-in</option>
              <option value="post_completion_review">Post-completion review</option>
              <option value="feedback_request">Ask for feedback</option>
              <option value="no_response_follow_up">Follow up after no reply</option>
            </select></label>
            <label>Channel<span className="renewal-channel-display"><Smartphone size={14} /> SMS via Quo</span></label>
          </div>

          {preview && <div className={`renewal-outreach-readiness ${preview.canSend ? 'ready' : 'blocked'}`}>
            {preview.canSend ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span><strong>{preview.to || 'No mobile number saved'}</strong><small>{preview.reason}</small></span>
          </div>}

          <label>Message<textarea value={body} onChange={(event) => { setBody(event.target.value); setApproved(false) }} /></label>
          <label className="renewal-outreach-approval"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>I have reviewed this exact message and approve sending it to this client.</span></label>
          <button className="primary-button renewal-send-button" disabled={!preview?.canSend || !approved || busy === 'sending'}><Smartphone size={14} />{busy === 'sending' ? 'Sending…' : 'Approve and send SMS'}</button>
        </section>

        <aside className="renewal-outreach-history">
          <div><MessageSquareText size={16} /><span><strong>Quo conversation</strong><small>Incoming replies refresh automatically while this drawer is open.</small></span></div>
          {conversationError && <div className="renewal-conversation-error"><AlertTriangle size={14} /><span>{conversationError}</span></div>}
          {suppressionReason && <div className="renewal-conversation-error"><AlertTriangle size={14} /><span>{suppressionReason} Further SMS is blocked.</span></div>}
          {busy === 'conversation' ? <div className="renewal-conversation-loading"><RefreshCw className="spin" size={16} /> Loading Quo messages…</div> : messages.length ? <div className="quo-message-thread">{messages.map((message) => <article key={message.id} className={message.direction}><p>{message.body}</p><small>{new Date(message.createdAt).toLocaleString('en-GB')} · {message.status}</small></article>)}</div> : !conversationError && <div className="renewal-outreach-empty"><MessageSquareQuote size={22} /><strong>No Quo messages yet</strong><span>Send the first approved SMS to start this conversation.</span></div>}
          {replySuggestion && <div className={`renewal-reply-suggestion ${replySuggestion.intent}`}>
            <div><Sparkles size={15} /><span><small>Suggested response path</small><strong>{replySuggestion.label}</strong></span></div>
            <p>{replySuggestion.rationale}</p>
            <blockquote>{replySuggestion.body}</blockquote>
            <small><strong>Next action:</strong> {replySuggestion.recommendedNextAction}</small>
            {replySuggestion.intent !== 'opt_out' && <button type="button" className="secondary-button" onClick={() => { setReply(replySuggestion.body); setReplyApproved(false) }}>Use this editable reply</button>}
          </div>}
          <div className="quo-reply-composer">
            <label>Reply through Quo<textarea maxLength={1600} value={reply} onChange={(event) => { setReply(event.target.value); setReplyApproved(false) }} placeholder="Type the next response or use the suggestion above…" /></label>
            <label className="renewal-outreach-approval"><input type="checkbox" checked={replyApproved} disabled={Boolean(suppressionReason)} onChange={(event) => setReplyApproved(event.target.checked)} /><span>I have reviewed this exact reply and approve sending it.</span></label>
            <div><small>{reply.length}/1600</small><button type="button" className="primary-button" disabled={!reply.trim() || !replyApproved || busy === 'reply' || Boolean(conversationError) || Boolean(suppressionReason)} onClick={() => void sendReply()}><Send size={13} /> {busy === 'reply' ? 'Sending…' : 'Approve and send through Quo'}</button></div>
          </div>
        </aside>
      </div>
    </form>
  </div>
}
