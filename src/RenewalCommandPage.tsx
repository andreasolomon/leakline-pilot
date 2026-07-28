import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, FileUp, MessageSquareQuote, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, UsersRound, Video, X } from 'lucide-react'
import { classifyClickUpImport, parseClickUpRenewalCsv, type ClickUpRenewalPreview } from './clickUpRenewalImport'
import { daysUntilProgrammeEnd, programmeEndDate, programmePhase, recommendedRenewalAction, RENEWAL_PIPELINE_STAGES, renewalPipelineStage, renewalPipelineSummary, renewalReadiness, renewalStatusForPipelineStage, renewalSummary, type ProgrammePhase, type RenewalClient, type RenewalClientInput, type RenewalPipelineStage } from './renewalCommand'
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

export default function RenewalCommandPage({ canAct, workspaceId }: { canAct: boolean; workspaceId: string }) {
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
  const [clickUpPreview, setClickUpPreview] = useState<ClickUpRenewalPreview | null>(null)
  const clickUpInput = useRef<HTMLInputElement>(null)

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
        && (!query || `${client.name} ${client.email ?? ''} ${client.owner} ${client.feedbackNote ?? ''}`.toLowerCase().includes(query))
    })
    .sort((left, right) => phasePriority[programmePhase(left)] - phasePriority[programmePhase(right)]
      || renewalReadiness(right).score - renewalReadiness(left).score
      || left.name.localeCompare(right.name)), [clients, phaseFilter, pipelineFilter, search])
  const feedbackClients = useMemo(() => clients
    .filter((client) => client.feedbackScore !== undefined)
    .sort((left, right) => renewalReadiness(right).score - renewalReadiness(left).score)
    .slice(0, 6), [clients])
  const clickUpChanges = useMemo(() => clickUpPreview ? classifyClickUpImport(clickUpPreview.rows, clients) : null, [clickUpPreview, clients])

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

  const previewClickUpFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setNotice('')
    if (file.size > 5 * 1024 * 1024) {
      setError('The ClickUp export is too large. Choose a CSV smaller than 5 MB.')
      return
    }
    try {
      const preview = parseClickUpRenewalCsv(file.name, await file.text())
      if (!preview.rows.length) {
        setError(preview.issues.join(' ') || 'No valid ClickUp clients were found.')
        return
      }
      setClickUpPreview(preview)
    } catch {
      setError('The ClickUp CSV could not be read. Export the Client Manager list as CSV and try again.')
    }
  }

  const importClickUp = async () => {
    if (!clickUpPreview) return
    setBusy('clickup-import')
    setError('')
    try {
      const body = await renewalApi<{ clients: RenewalClient[]; clickUpImport: ClickUpImportMeta; result: { created: number; updated: number; unchanged: number } }>('/api/renewal-clients/import-clickup', {
        method: 'POST',
        body: JSON.stringify({ fileName: clickUpPreview.fileName, sourceRows: clickUpPreview.sourceRows, rows: clickUpPreview.rows }),
      })
      setClients(body.clients)
      setClickUpImport(body.clickUpImport)
      setClickUpPreview(null)
      setNotice(`ClickUp import complete: ${body.result.created} created, ${body.result.updated} updated and ${body.result.unchanged} unchanged.`)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The ClickUp clients could not be imported.')
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
        <input ref={clickUpInput} className="clickup-file-input" type="file" accept=".csv,text/csv" onChange={previewClickUpFile} />
        <button className="ghost-button clickup-import-button" onClick={() => clickUpInput.current?.click()}><FileUp size={15} /> Import from ClickUp</button>
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
      <article><span>Renewal cash collected</span><strong>{money.format(summary.renewalCashCollected)}</strong><small>Cash attributed to completed renewals</small></article>
    </div>

    <article className="panel renewal-pipeline-panel">
      <div className="panel-head">
        <div><span className="eyebrow"><Sparkles size={14} /> Recurring-revenue workflow</span><h2>Client renewal pipeline</h2></div>
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
          <div><span className="eyebrow"><Sparkles size={14} /> Ranked by urgency and readiness</span><h2>Client renewal queue</h2></div>
          <span className="renewal-rule-chip">90-day program · 14-day inactivity check</span>
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
              <span className="renewal-row-actions">{canAct && <><button aria-label={`Update ${client.name}`} onClick={() => openEdit(client)}><Pencil size={14} /></button><button aria-label={`Remove ${client.name}`} onClick={() => void deleteClient(client)}><Trash2 size={14} /></button></>}</span>
            </div>
          })}
          {!filtered.length && <div className="renewal-empty">
            <CalendarClock size={28} />
            <h3>{clients.length ? 'No clients match these filters' : 'No renewal clients tracked yet'}</h3>
            <p>{clients.length ? 'Change the pipeline stage, program phase or search.' : 'Import the Client Manager CSV from ClickUp, or add the first client manually.'}</p>
            {canAct && !clients.length && <button className="primary-button" onClick={openCreate}><Plus size={14} /> Add first client</button>}
          </div>}
        </div>
      </article>

      <aside className="panel feedback-readiness-panel">
        <div className="panel-head"><div><span className="eyebrow"><MessageSquareQuote size={14} /> Client voice</span><h2>Feedback and readiness</h2></div></div>
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

    {clickUpPreview && clickUpChanges && <div className="connection-modal-backdrop" onClick={() => busy !== 'clickup-import' && setClickUpPreview(null)}>
      <section className="connection-modal clickup-preview-modal" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" disabled={busy === 'clickup-import'} onClick={() => setClickUpPreview(null)}><X size={18} /></button>
        <span className="eyebrow"><FileUp size={14} /> ClickUp import preview</span>
        <h2>Review before updating Renewal Command</h2>
        <p>New clients start with Yonas as the renewal owner and $8,000 expected value. Existing feedback, renewal stages, values, cash and manual notes are preserved.</p>

        <div className="clickup-preview-summary">
          <article><span>Valid clients</span><strong>{clickUpPreview.rows.length}</strong><small>{clickUpPreview.sourceRows} source rows</small></article>
          <article><span>New clients</span><strong>{clickUpChanges.create}</strong><small>Will be added</small></article>
          <article><span>Updates</span><strong>{clickUpChanges.update}</strong><small>Matched by Task ID or email</small></article>
          <article><span>Unchanged</span><strong>{clickUpChanges.unchanged}</strong><small>No duplicate created</small></article>
        </div>

        <div className="clickup-date-explainer">
          <CalendarClock size={17} />
          <span><strong>{clickUpPreview.completedWebinarDates} completed webinar dates</strong><small>{clickUpPreview.futureWebinarDates} future webinar dates will be treated as scheduled, not completed.</small></span>
        </div>

        {clickUpPreview.issues.length > 0 && <div className="clickup-import-issues">
          <strong><AlertTriangle size={15} /> {clickUpPreview.issues.length} import note{clickUpPreview.issues.length === 1 ? '' : 's'}</strong>
          {clickUpPreview.issues.slice(0, 5).map((issue) => <span key={issue}>{issue}</span>)}
        </div>}

        <div className="clickup-preview-table">
          <div><strong>Client</strong><strong>Completed</strong><strong>Next webinar</strong></div>
          {clickUpPreview.rows.slice(0, 6).map((row) => <div key={row.clickUpTaskId}>
            <span><strong>{row.name}</strong><small>{row.email || 'No email'}</small></span>
            <span>{row.webinarsHosted}</span>
            <span>{formatDate(row.nextWebinarAt)}</span>
          </div>)}
          {clickUpPreview.rows.length > 6 && <small className="clickup-more-rows">Plus {clickUpPreview.rows.length - 6} more clients</small>}
        </div>

        <div className="renewal-editor-actions">
          <button className="ghost-button" disabled={busy === 'clickup-import'} onClick={() => setClickUpPreview(null)}>Cancel</button>
          <button className="primary-button" disabled={busy === 'clickup-import'} onClick={() => void importClickUp()}>
            {busy === 'clickup-import' ? <><RefreshCw className="spin" size={15} /> Importing…</> : <><FileUp size={15} /> Confirm ClickUp import</>}
          </button>
        </div>
      </section>
    </div>}
  </section>
}
