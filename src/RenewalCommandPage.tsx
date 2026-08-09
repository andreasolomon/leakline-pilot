import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, MessageSquareQuote, MessageSquareText, Pencil, Plus, RefreshCw, Search, Send, Sparkles, Smartphone, Trash2, UsersRound, Video, X } from 'lucide-react'
import { daysUntilProgrammeEnd, programmeEndDate, programmePhase, recommendedRenewalAction, recommendedRenewalOutreachKind, RENEWAL_PIPELINE_STAGES, renewalOutreachAvailability, renewalPipelineStage, renewalPipelineSummary, renewalReadiness, renewalStatusForPipelineStage, renewalSummary, type ProgrammePhase, type RenewalClient, type RenewalClientInput, type RenewalOutreachActivity, type RenewalOutreachKind, type RenewalPipelineStage } from './renewalCommand'
import { emptyRenewalClient, inputFromRenewalClient, renewalApi } from './renewalCommandClient'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const phaseLabels: Record<ProgrammePhase, string> = {
  awaiting_activation: 'Awaiting activation',
  active: 'Active',
  inactive: 'Inactive',
  renewal_window: 'Renewal window',
  completion_overdue: 'Past completion',
  renewed: 'Renewed',
  declined: 'Declined',
}
const pipelineStageLabels = Object.fromEntries(RENEWAL_PIPELINE_STAGES.map((stage) => [stage.id, stage.label])) as Record<RenewalPipelineStage, string>
const phasePriority: Record<ProgrammePhase, number> = {
  completion_overdue: 0,
  renewal_window: 1,
  inactive: 2,
  awaiting_activation: 3,
  active: 4,
  renewed: 5,
  declined: 6,
}

type ClickUpImportMeta = {
  fileName: string
  importedAt: string
  importedBy: string
  sourceRows: number
  acceptedRows: number
  created: number
  updated: number
  unchanged: number
}

type RenewalOutreachPreview = {
  channel: 'sms' | 'email'
  kind: RenewalOutreachKind
  to?: string
  subject?: string
  body: string
  templateKey: string
  canSend: boolean
  reason: string
  daysRemaining?: number
  contactMatched: boolean
  highLevelConnected: boolean
  quoConnected?: boolean
  history: RenewalOutreachActivity[]
}

type QuoConversationMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  status: string
  createdAt: string
  conversationId?: string
}

type RenewalReplySuggestion = {
  intent: 'ready_to_continue' | 'positive_feedback' | 'webinar_blocked' | 'needs_support' | 'timing_or_budget' | 'not_interested' | 'opt_out' | 'unclear'
  label: string
  rationale: string
  body: string
  recommendedNextAction: string
  sourceMessageId: string
}

function formatDate(value?: string) {
  if (!value) return 'Not set'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00.000Z`))
}

function programmeTiming(client: RenewalClient) {
  const remaining = daysUntilProgrammeEnd(client)
  if (remaining === undefined) return 'Starts after first webinar'
  if (remaining < 0) return `${Math.abs(remaining)} days past completion`
  if (remaining === 0) return 'Completes today'
  return `${remaining} days remaining`
}

export default function RenewalCommandPage({ canAct, workspaceId, onOpenDataSources }: { canAct: boolean; workspaceId: string; onOpenDataSources?: () => void }) {
  const [clients, setClients] = useState<RenewalClient[]>([])
  const [search, setSearch] = useState('')
  const [phaseFilter, setPhaseFilter] = useState<'all' | ProgrammePhase>('all')
  const [pipelineFilter, setPipelineFilter] = useState<'all' | RenewalPipelineStage>('all')
  const [busy, setBusy] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState<RenewalClientInput>(emptyRenewalClient)
  const [editorOpen, setEditorOpen] = useState(false)
  const [clickUpImport, setClickUpImport] = useState<ClickUpImportMeta | undefined>()
  const [outreachOpen, setOutreachOpen] = useState(false)
  const [outreachClient, setOutreachClient] = useState<RenewalClient | undefined>()
  const [outreachKind, setOutreachKind] = useState<RenewalOutreachKind>('renewal_invitation')
  const [outreachPreview, setOutreachPreview] = useState<RenewalOutreachPreview | undefined>()
  const [outreachBody, setOutreachBody] = useState('')
  const [outreachApproved, setOutreachApproved] = useState(false)
  const [outreachKey, setOutreachKey] = useState('')
  const [quoMessages, setQuoMessages] = useState<QuoConversationMessage[]>([])
  const [replySuggestion, setReplySuggestion] = useState<RenewalReplySuggestion | undefined>()
  const [conversationReply, setConversationReply] = useState('')
  const [conversationApproved, setConversationApproved] = useState(false)
  const [conversationError, setConversationError] = useState('')
  const [conversationBusy, setConversationBusy] = useState('')
  const handledInboundId = useRef('')
  const latestSuggestedInboundId = useRef('')

  const load = async () => {
    setBusy('loading')
    setError('')
    try {
      const body = await renewalApi<{ clients: RenewalClient[]; clickUpImport?: ClickUpImportMeta }>()
      setClients(body.clients)
      setClickUpImport(body.clickUpImport)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Renewal clients could not be loaded.')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void load() }, [workspaceId])

  const summary = useMemo(() => renewalSummary(clients), [clients])
  const pipeline = useMemo(() => renewalPipelineSummary(clients), [clients])
  const filtered = useMemo(() => clients
    .filter((client) => {
      const query = search.trim().toLowerCase()
      return (phaseFilter === 'all' || programmePhase(client) === phaseFilter)
        && (pipelineFilter === 'all' || renewalPipelineStage(client) === pipelineFilter)
        && (!query || `${client.name} ${client.email ?? ''} ${client.phone ?? ''} ${client.owner} ${client.feedbackNote ?? ''}`.toLowerCase().includes(query))
    })
    .sort((left, right) => phasePriority[programmePhase(left)] - phasePriority[programmePhase(right)]
      || renewalReadiness(right).score - renewalReadiness(left).score
      || left.name.localeCompare(right.name)), [clients, phaseFilter, pipelineFilter, search])
  const feedbackClients = useMemo(() => clients
    .filter((client) => client.feedbackScore !== undefined)
    .sort((left, right) => renewalReadiness(right).score - renewalReadiness(left).score)
    .slice(0, 6), [clients])

  const openCreate = () => {
    setEditingId('')
    setDraft(emptyRenewalClient())
    setEditorOpen(true)
    setNotice('')
  }

  const openEdit = (client: RenewalClient) => {
    setEditingId(client.id)
    setDraft(inputFromRenewalClient(client))
    setEditorOpen(true)
    setNotice('')
  }

  const saveClient = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy('saving')
    setError('')
    try {
      const payload = {
        ...draft,
        email: draft.email ?? '',
        phone: draft.phone ?? '',
        enrolledAt: draft.enrolledAt ?? '',
        firstWebinarAt: draft.firstWebinarAt ?? '',
        lastWebinarAt: draft.lastWebinarAt ?? '',
        nextWebinarAt: draft.nextWebinarAt ?? '',
        feedbackScore: draft.feedbackScore ?? null,
        feedbackNote: draft.feedbackNote ?? '',
        renewalCallAt: draft.renewalCallAt ?? '',
        nextAction: draft.nextAction ?? '',
      }
      const body = await renewalApi<{ client: RenewalClient }>(editingId ? `/api/renewal-clients/${editingId}` : '/api/renewal-clients', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      })
      setClients((current) => editingId ? current.map((client) => client.id === body.client.id ? body.client : client) : [...current, body.client])
      setNotice(editingId ? `${body.client.name} was updated.` : `${body.client.name} was added to Renewal Command.`)
      setEditorOpen(false)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The renewal client could not be saved.')
    } finally {
      setBusy('')
    }
  }

  const updateClient = async (client: RenewalClient, patch: Partial<RenewalClientInput>, success: string) => {
    setBusy(client.id)
    setError('')
    try {
      const body = await renewalApi<{ client: RenewalClient }>(`/api/renewal-clients/${client.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      setClients((current) => current.map((item) => item.id === body.client.id ? body.client : item))
      setNotice(success)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The client could not be updated.')
    } finally {
      setBusy('')
    }
  }

  const logWebinar = (client: RenewalClient) => {
    const today = new Date().toISOString().slice(0, 10)
    void updateClient(client, {
      webinarsHosted: client.webinarsHosted + 1,
      firstWebinarAt: client.firstWebinarAt ?? today,
      lastWebinarAt: today,
    }, `Webinar ${client.webinarsHosted + 1} logged for ${client.name}.`)
  }

  const deleteClient = async (client: RenewalClient) => {
    if (!window.confirm(`Remove ${client.name} from Renewal Command?`)) return
    setBusy(client.id)
    setError('')
    try {
      await renewalApi(`/api/renewal-clients/${client.id}`, { method: 'DELETE' })
      setClients((current) => current.filter((item) => item.id !== client.id))
      setNotice(`${client.name} was removed.`)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The client could not be removed.')
    } finally {
      setBusy('')
    }
  }

  const fetchOutreachPreview = async (client: RenewalClient, kind: RenewalOutreachKind, channel: 'sms' | 'email') => {
    setBusy(`outreach-${client.id}`)
    setError('')
    setOutreachApproved(false)
    try {
      const preview = await renewalApi<RenewalOutreachPreview>(`/api/renewal-clients/${client.id}/outreach/preview`, {
        method: 'POST',
        body: JSON.stringify({ kind, channel }),
      })
      setOutreachPreview(preview)
      setOutreachBody(preview.body)
    } catch (event) {
      setOutreachPreview(undefined)
      setError(event instanceof Error ? event.message : 'The renewal message could not be prepared.')
    } finally {
      setBusy('')
    }
  }

  const loadQuoConversation = async (client: RenewalClient, quiet = false) => {
    if (!client.phone) {
      setQuoMessages([])
      setConversationError('Add a mobile number to this client before opening the Quo conversation.')
      return
    }
    if (!quiet) setConversationBusy('loading')
    try {
      const result = await renewalApi<{ messages: QuoConversationMessage[]; suggestion?: RenewalReplySuggestion }>(`/api/renewal-clients/${client.id}/conversation`)
      setQuoMessages(result.messages)
      if (result.suggestion?.sourceMessageId && result.suggestion.sourceMessageId !== latestSuggestedInboundId.current) {
        latestSuggestedInboundId.current = result.suggestion.sourceMessageId
        setConversationApproved(false)
      }
      setReplySuggestion(result.suggestion?.sourceMessageId === handledInboundId.current ? undefined : result.suggestion)
      setConversationError('')
    } catch (event) {
      setConversationError(event instanceof Error ? event.message : 'The Quo conversation could not be loaded.')
    } finally {
      if (!quiet) setConversationBusy('')
    }
  }

  useEffect(() => {
    if (!outreachOpen || !outreachClient) return
    void loadQuoConversation(outreachClient)
    const timer = window.setInterval(() => void loadQuoConversation(outreachClient, true), 10_000)
    return () => window.clearInterval(timer)
  }, [outreachOpen, outreachClient?.id])

  const sendConversationReply = async () => {
    if (!outreachClient || !conversationReply.trim() || !conversationApproved) return
    setConversationBusy('sending')
    setConversationError('')
    try {
      const result = await renewalApi<{ client: RenewalClient }>(`/api/renewal-clients/${outreachClient.id}/conversation/send`, {
        method: 'POST',
        body: JSON.stringify({ body: conversationReply.trim(), approved: true, idempotencyKey: crypto.randomUUID() }),
      })
      handledInboundId.current = [...quoMessages].reverse().find((message) => message.direction === 'inbound')?.id ?? ''
      setClients((current) => current.map((client) => client.id === result.client.id ? result.client : client))
      setOutreachClient(result.client)
      setConversationReply('')
      setConversationApproved(false)
      setReplySuggestion(undefined)
      setNotice(`SMS sent through Quo to ${result.client.name}.`)
      await loadQuoConversation(result.client, true)
    } catch (event) {
      setConversationError(event instanceof Error ? event.message : 'The SMS could not be sent through Quo.')
    } finally {
      setConversationBusy('')
    }
  }

  const openOutreach = (client: RenewalClient) => {
    const kind = recommendedRenewalOutreachKind(client)
    setOutreachClient(client)
    setOutreachKind(kind)
    setOutreachKey(crypto.randomUUID())
    setQuoMessages([])
    setReplySuggestion(undefined)
    setConversationReply('')
    setConversationApproved(false)
    setConversationError('')
    handledInboundId.current = ''
    latestSuggestedInboundId.current = ''
    setOutreachOpen(true)
    setNotice('')
    void fetchOutreachPreview(client, kind, 'sms')
  }

  const changeOutreachDraft = (kind: RenewalOutreachKind) => {
    if (!outreachClient) return
    setOutreachKind(kind)
    setOutreachKey(crypto.randomUUID())
    void fetchOutreachPreview(outreachClient, kind, 'sms')
  }

  const sendOutreach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!outreachClient || !outreachPreview) return
    setBusy(`send-outreach-${outreachClient.id}`)
    setError('')
    try {
      const result = await renewalApi<{ client: RenewalClient; simulated: boolean }>(`/api/renewal-clients/${outreachClient.id}/outreach/send`, {
        method: 'POST',
        body: JSON.stringify({
          kind: outreachKind,
          channel: 'sms',
          body: outreachBody,
          approved: outreachApproved,
          idempotencyKey: outreachKey,
        }),
      })
      setClients((current) => current.map((client) => client.id === result.client.id ? result.client : client))
      setOutreachClient(result.client)
      setOutreachPreview((current) => current ? { ...current, history: [...(result.client.outreach ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt)) } : current)
      setOutreachApproved(false)
      setOutreachKey(crypto.randomUUID())
      setNotice(`SMS ${result.simulated ? 'simulated' : 'sent'} for ${result.client.name}.`)
    } catch (event) {
      setOutreachKey(crypto.randomUUID())
      setError(event instanceof Error ? event.message : 'The renewal message could not be sent.')
    } finally {
      setBusy('')
    }
  }

  if (busy === 'loading') return <section className="renewal-command-page renewal-loading"><RefreshCw className="spin" /><span>Opening Renewal Command…</span></section>

  return <section className="renewal-command-page">
    <div className="renewal-command-heading">
      <div>
        <p>Renewal Command · Launch Webinars</p>
        <h1>Turn program completion into recurring revenue.</h1>
        <span>Track activation, webinar participation, client feedback and every renewal opportunity from one place.</span>
      </div>
      {canAct && <div className="renewal-heading-actions">
        {onOpenDataSources && <button className="ghost-button clickup-import-button" onClick={onOpenDataSources}>Update source data</button>}
        <button className="primary-button" onClick={openCreate}><Plus size={15} /> Add client</button>
      </div>}
    </div>

    {error && <div className="integration-error"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="renewal-notice"><CheckCircle2 size={15} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></div>}
    {clickUpImport && <div className="clickup-source-status">
      <span><CheckCircle2 size={15} /> ClickUp export imported</span>
      <strong>{clickUpImport.acceptedRows} clients</strong>
      <small>{clickUpImport.fileName} · {new Date(clickUpImport.importedAt).toLocaleString('en-GB')} by {clickUpImport.importedBy}</small>
    </div>}

    <div className="renewal-summary-grid">
      <article><span>Clients tracked</span><strong>{clients.length}</strong><small>{summary.activeClients} inside an active program</small></article>
      <article><span>Renewal opportunities</span><strong>{summary.renewalOpportunities}</strong><small>Completing within 30 days or already due</small></article>
      <article><span>High readiness</span><strong>{summary.highReadiness}</strong><small>Strong usage, recency and feedback signals</small></article>
      <article className="renewal-value-card"><span>Renewal pipeline value</span><strong>{money.format(summary.renewalPipelineValue)}</strong><small>Expected value across open renewal stages</small></article>
      <article className="renewal-value-card"><span>Renewal cash collected</span><strong>{money.format(summary.renewalCashCollected)}</strong><small>Cash attributed to completed renewals</small></article>
    </div>

    <article className="panel renewal-pipeline-panel">
      <div className="panel-head">
        <div><h2>Client renewal pipeline</h2></div>
        {pipelineFilter !== 'all' && <button className="renewal-pipeline-clear" onClick={() => setPipelineFilter('all')}>Clear stage filter</button>}
      </div>
      <p className="renewal-pipeline-explainer">LeakLine automatically identifies approaching renewal opportunities. Fred and Yonas can move each client forward as the renewal conversation progresses.</p>
      <div className="renewal-pipeline-scroll">
        <div className="renewal-pipeline-track">
          {pipeline.map((stage) => <button
            key={stage.stage}
            className={`renewal-pipeline-stage ${stage.stage} ${pipelineFilter === stage.stage ? 'selected' : ''}`}
            aria-pressed={pipelineFilter === stage.stage}
            onClick={() => setPipelineFilter((current) => current === stage.stage ? 'all' : stage.stage)}
          >
            <span>{stage.label}</span>
            <strong>{stage.clientCount}</strong>
            <small>{money.format(stage.value)} {stage.stage === 'renewed' ? 'collected' : 'potential'}</small>
          </button>)}
        </div>
      </div>
    </article>

    <div className="renewal-command-grid">
      <article className="panel renewal-queue-panel">
        <div className="panel-head">
          <div><h2>Client renewal queue</h2></div>
        </div>
        <div className="renewal-toolbar">
          <label><Search size={14} /><input aria-label="Search renewal clients" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search clients, owners or feedback…" /></label>
          <select aria-label="Filter by program phase" value={phaseFilter} onChange={(event) => setPhaseFilter(event.target.value as typeof phaseFilter)}>
            <option value="all">All program phases</option>
            {Object.entries(phaseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        <div className="renewal-table-wrap">
          <div className="renewal-table renewal-table-head">
            <span>Client</span><span>Program</span><span>Webinars</span><span>Feedback</span><span>Readiness</span><span>Renewal</span><span>Next action</span><span />
          </div>
          {filtered.map((client) => {
            const phase = programmePhase(client)
            const readiness = renewalReadiness(client)
            return <div className="renewal-table renewal-client-row" key={client.id}>
              <span className="renewal-client-name"><strong>{client.name}</strong><small>{client.owner}</small></span>
              <span className="renewal-programme"><em className={`renewal-phase ${phase}`}>{phaseLabels[phase]}</em><small>{programmeTiming(client)} · ends {formatDate(programmeEndDate(client.firstWebinarAt))}</small></span>
              <span className="webinar-counter"><strong><Video size={14} /> {client.webinarsHosted}</strong>{canAct && <button disabled={busy === client.id} onClick={() => logWebinar(client)}><Plus size={12} /> Log webinar</button>}<small>Last: {formatDate(client.lastWebinarAt)}</small>{client.nextWebinarAt && <small>Next: {formatDate(client.nextWebinarAt)}</small>}</span>
              <span className="renewal-feedback">{client.feedbackScore !== undefined ? <><strong>{client.feedbackScore}/5</strong><small>{client.feedbackNote || 'No feedback note'}</small></> : <><strong>Not scored</strong><button disabled={!canAct} onClick={() => openEdit(client)}>Add feedback</button></>}</span>
              <span className="renewal-readiness"><strong className={readiness.label.toLowerCase().replace(' ', '-')}>{readiness.label.startsWith('Needs') ? '—' : readiness.score}</strong><small>{readiness.label}</small><em title={readiness.explanation}>{readiness.explanation}</em></span>
              <span className="renewal-workflow">
                {canAct ? <select
                  aria-label={`Renewal stage for ${client.name}`}
                  value={renewalPipelineStage(client)}
                  disabled={busy === client.id}
                  onChange={(event) => {
                    const stage = event.target.value as RenewalPipelineStage
                    void updateClient(client, { renewalStatus: renewalStatusForPipelineStage(stage) }, `${client.name} moved to ${pipelineStageLabels[stage]}.`)
                  }}
                >{RENEWAL_PIPELINE_STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select> : <strong>{pipelineStageLabels[renewalPipelineStage(client)]}</strong>}
                <small>{client.expectedRenewalValue ? `${money.format(client.expectedRenewalValue)} expected` : 'Value not set'}</small>
              </span>
              <span className="renewal-next-action">{recommendedRenewalAction(client)}</span>
              <span className="renewal-row-actions">{canAct && <><button aria-label={`Message ${client.name}`} disabled={!renewalOutreachAvailability(client).available} title={renewalOutreachAvailability(client).reason} onClick={() => openOutreach(client)}><MessageSquareText size={14} /></button><button aria-label={`Update ${client.name}`} onClick={() => openEdit(client)}><Pencil size={14} /></button><button aria-label={`Remove ${client.name}`} onClick={() => void deleteClient(client)}><Trash2 size={14} /></button></>}</span>
            </div>
          })}
          {!filtered.length && <div className="renewal-empty">
            <CalendarClock size={28} />
            <h3>{clients.length ? 'No clients match these filters' : 'No renewal clients tracked yet'}</h3>
            <p>{clients.length ? 'Change the pipeline stage, program phase or search.' : 'Connect or import the Client Manager List from Data Sources, or add the first client manually.'}</p>
            {canAct && !clients.length && <button className="primary-button" onClick={openCreate}><Plus size={14} /> Add first client</button>}
          </div>}
        </div>
      </article>

      <aside className="panel feedback-readiness-panel">
        <div className="panel-head"><div><h2>Feedback and readiness</h2></div></div>
        <p className="feedback-explainer">Readiness combines webinar usage (50 points), recency (20) and client feedback (30). It is an explainable priority signal, not a guaranteed prediction.</p>
        {feedbackClients.length ? <div className="feedback-client-list">{feedbackClients.map((client) => {
          const readiness = renewalReadiness(client)
          return <button key={client.id} onClick={() => canAct && openEdit(client)}>
            <span className="feedback-score">{client.feedbackScore}/5</span>
            <span><strong>{client.name}</strong><small>{client.feedbackNote || 'No feedback note added'}</small><em>{readiness.score}/100 readiness · {readiness.label}</em></span>
          </button>
        })}</div> : <div className="feedback-empty"><MessageSquareQuote size={24} /><strong>No client feedback yet</strong><span>Add a score and note after a check-in to make renewal ranking more useful.</span></div>}
        <div className="activation-watch"><UsersRound size={17} /><span><strong>{summary.awaitingActivation} awaiting activation</strong><small>These clients have paid but have not yet started their 90-day clock.</small></span></div>
      </aside>
    </div>

    {editorOpen && <div className="connection-modal-backdrop" onClick={() => setEditorOpen(false)}>
      <form className="connection-modal renewal-client-editor" onSubmit={saveClient} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setEditorOpen(false)}><X size={18} /></button>
        <span className="eyebrow">{editingId ? 'Update renewal record' : 'Add renewal client'}</span>
        <h2>{editingId ? 'Update the client journey' : 'Start tracking a client'}</h2>
        <p>Save the facts here. LeakLine calculates the program phase, urgency and readiness automatically.</p>
        {error && <div className="modal-error"><AlertTriangle size={14} /><span>{error}</span></div>}

        <fieldset><legend>Client</legend><div className="renewal-editor-grid">
          <label>Client name<input required minLength={2} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>Email<input type="email" value={draft.email ?? ''} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
          <label>Mobile number<input type="tel" placeholder="+15551234567" value={draft.phone ?? ''} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} /><small>Use international format so Quo can send SMS.</small></label>
          <label>Client success owner<input required minLength={2} value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} /></label>
          <label>Joined date<input type="date" value={draft.enrolledAt ?? ''} onChange={(event) => setDraft({ ...draft, enrolledAt: event.target.value || undefined })} /></label>
        </div></fieldset>

        <fieldset><legend>Webinar activity</legend><div className="renewal-editor-grid">
          <label>First webinar<input type="date" value={draft.firstWebinarAt ?? ''} onChange={(event) => setDraft({ ...draft, firstWebinarAt: event.target.value || undefined })} /><small>This starts the 90-day program.</small></label>
          <label>Last webinar<input type="date" value={draft.lastWebinarAt ?? ''} onChange={(event) => setDraft({ ...draft, lastWebinarAt: event.target.value || undefined })} /></label>
          <label>Next webinar<input type="date" value={draft.nextWebinarAt ?? ''} onChange={(event) => setDraft({ ...draft, nextWebinarAt: event.target.value || undefined })} /></label>
          <label>Webinars completed<input type="number" min="0" max="10000" value={draft.webinarsHosted} onChange={(event) => setDraft({ ...draft, webinarsHosted: Number(event.target.value) })} /></label>
        </div></fieldset>

        <fieldset><legend>Feedback</legend><div className="renewal-editor-grid">
          <label>Feedback score<select value={draft.feedbackScore ?? ''} onChange={(event) => setDraft({ ...draft, feedbackScore: event.target.value ? Number(event.target.value) : undefined })}><option value="">Not scored</option><option value="1">1 — Very unhappy</option><option value="2">2 — Unhappy</option><option value="3">3 — Neutral</option><option value="4">4 — Positive</option><option value="5">5 — Very positive</option></select></label>
          <label className="renewal-note-field">Feedback note<textarea value={draft.feedbackNote ?? ''} onChange={(event) => setDraft({ ...draft, feedbackNote: event.target.value })} placeholder="What did the client say about the program and their results?" /></label>
        </div></fieldset>

        <fieldset><legend>Renewal</legend><div className="renewal-editor-grid">
          <label>Renewal stage<select
            value={draft.renewalStatus === 'not_started' ? 'active_programme' : draft.renewalStatus}
            onChange={(event) => setDraft({ ...draft, renewalStatus: renewalStatusForPipelineStage(event.target.value as RenewalPipelineStage) })}
          >{RENEWAL_PIPELINE_STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select></label>
          <label>Renewal call<input type="date" value={draft.renewalCallAt ?? ''} onChange={(event) => setDraft({ ...draft, renewalCallAt: event.target.value || undefined })} /></label>
          <label>Expected renewal value<input type="number" min="0" value={draft.expectedRenewalValue} onChange={(event) => setDraft({ ...draft, expectedRenewalValue: Number(event.target.value) })} /></label>
          <label>Renewal cash collected<input type="number" min="0" value={draft.renewalCashCollected} onChange={(event) => setDraft({ ...draft, renewalCashCollected: Number(event.target.value) })} /></label>
          <label className="renewal-note-field">Override next action<textarea value={draft.nextAction ?? ''} onChange={(event) => setDraft({ ...draft, nextAction: event.target.value })} placeholder="Leave blank to use LeakLine's recommended next action." /></label>
        </div></fieldset>

        <div className="renewal-editor-actions"><button type="button" className="ghost-button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy === 'saving'}>{busy === 'saving' ? 'Saving…' : editingId ? 'Save client changes' : 'Add to Renewal Command'}</button></div>
      </form>
    </div>}

    {outreachOpen && outreachClient && <div className="connection-modal-backdrop renewal-conversation-backdrop" onClick={() => setOutreachOpen(false)}>
      <form className="connection-modal renewal-outreach-modal" onSubmit={sendOutreach} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setOutreachOpen(false)}><X size={18} /></button>
        <span className="eyebrow">Assisted renewal outreach</span>
        <h2>Message {outreachClient.name}</h2>
        <p>Review the suggested message, see the live conversation and send approved SMS through Quo.</p>

        <div className="renewal-outreach-layout">
          <section className="renewal-outreach-draft">
            <div className="renewal-outreach-context">
              <span><strong>{outreachPreview?.daysRemaining !== undefined ? outreachPreview.daysRemaining < 0 ? `${Math.abs(outreachPreview.daysRemaining)} days past completion` : `${outreachPreview.daysRemaining} days remaining` : 'Program timing unavailable'}</strong><small>{outreachPreview?.templateKey.replaceAll('_', ' ') ?? 'Preparing draft…'}</small></span>
              <em className={outreachPreview?.canSend ? 'ready' : 'blocked'}>{outreachPreview?.canSend ? 'Ready for approval' : 'Setup required'}</em>
            </div>

            <div className="renewal-outreach-controls">
              <label>Message purpose<select value={outreachKind} onChange={(event) => changeOutreachDraft(event.target.value as RenewalOutreachKind)}>
                <option value="programme_check_in">Check in with active client</option>
                <option value="webinar_accountability">Re-engage inactive client</option>
                <option value="renewal_window_review">Open end-of-program conversation</option>
                <option value="post_completion_review">Re-engage completed client</option>
                <option value="no_response_follow_up">Follow up after no reply</option>
              </select></label>
              <label>Channel<span className="renewal-channel-display"><Smartphone size={14} /> SMS via Quo</span></label>
            </div>

            {outreachPreview && <div className={`renewal-outreach-readiness ${outreachPreview.canSend ? 'ready' : 'blocked'}`}>
              {outreachPreview.canSend ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span><strong>{outreachPreview.to || 'No destination matched'}</strong><small>{outreachPreview.reason}</small></span>
            </div>}

            <label>Message<textarea value={outreachBody} onChange={(event) => { setOutreachBody(event.target.value); setOutreachApproved(false) }} /></label>
            <label className="renewal-outreach-approval"><input type="checkbox" checked={outreachApproved} onChange={(event) => setOutreachApproved(event.target.checked)} /><span>I have reviewed this exact message and approve sending it to this client.</span></label>
            <button className="primary-button renewal-send-button" disabled={!outreachPreview?.canSend || !outreachApproved || busy.startsWith('send-outreach')}>
              <Smartphone size={14} />
              {busy.startsWith('send-outreach') ? 'Sending…' : 'Approve and send SMS'}
            </button>
          </section>

          <aside className="renewal-outreach-history">
            <div><MessageSquareText size={16} /><span><strong>Quo conversation</strong><small>Incoming replies refresh automatically while this drawer is open.</small></span></div>
            <>
              {conversationError && <div className="renewal-conversation-error"><AlertTriangle size={14} /><span>{conversationError}</span></div>}
              {conversationBusy === 'loading' ? <div className="renewal-conversation-loading"><RefreshCw className="spin" size={16} /> Loading Quo messages…</div> : quoMessages.length ? <div className="quo-message-thread">{quoMessages.map((message) => <article key={message.id} className={message.direction}>
                <p>{message.body}</p><small>{new Date(message.createdAt).toLocaleString('en-GB')} · {message.status}</small>
              </article>)}</div> : !conversationError && <div className="renewal-outreach-empty"><MessageSquareQuote size={22} /><strong>No Quo messages yet</strong><span>Send the first approved SMS to start this conversation.</span></div>}
              {replySuggestion && <div className={`renewal-reply-suggestion ${replySuggestion.intent}`}>
                <div><Sparkles size={15} /><span><small>Suggested response path</small><strong>{replySuggestion.label}</strong></span></div>
                <p>{replySuggestion.rationale}</p>
                <blockquote>{replySuggestion.body}</blockquote>
                <small><strong>Next action:</strong> {replySuggestion.recommendedNextAction}</small>
                <button type="button" className="secondary-button" onClick={() => { setConversationReply(replySuggestion.body); setConversationApproved(false) }}>Use this editable reply</button>
              </div>}
              <div className="quo-reply-composer">
                <label>Reply through Quo<textarea maxLength={1600} value={conversationReply} onChange={(event) => { setConversationReply(event.target.value); setConversationApproved(false) }} placeholder="Type the next response or use the suggestion above…" /></label>
                <label className="renewal-outreach-approval"><input type="checkbox" checked={conversationApproved} onChange={(event) => setConversationApproved(event.target.checked)} /><span>I have reviewed this exact reply and approve sending it.</span></label>
                <div><small>{conversationReply.length}/1600</small><button type="button" className="primary-button" disabled={!conversationReply.trim() || !conversationApproved || conversationBusy === 'sending' || Boolean(conversationError)} onClick={() => void sendConversationReply()}><Send size={13} /> {conversationBusy === 'sending' ? 'Sending…' : 'Approve and send through Quo'}</button></div>
              </div>
            </>
          </aside>
        </div>
      </form>
    </div>}

  </section>
}
