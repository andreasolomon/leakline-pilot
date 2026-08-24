import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, MessageSquareText, RefreshCw, Search, X } from 'lucide-react'
import { renewalOutreachAvailability, UPSELL_CAMPAIGN_STAGES, upsellCampaignStage, upsellCampaignSummary, type RenewalClient, type UpsellCampaignStage } from './renewalCommand'
import { renewalApi } from './renewalCommandClient'
import RenewalOutreachDrawer from './RenewalOutreachDrawer'

const stageLabels = Object.fromEntries(UPSELL_CAMPAIGN_STAGES.map((stage) => [stage.id, stage.label])) as Record<UpsellCampaignStage, string>

function latestCampaignActivity(client: RenewalClient) {
  const campaign = client.upsellCampaign
  const timestamps = [campaign?.outcomeAt, campaign?.callAttendedAt, campaign?.callBookedAt, campaign?.callOfferedAt, campaign?.interestConfirmedAt, campaign?.repliedAt, campaign?.openerSentAt].filter(Boolean) as string[]
  if (!timestamps.length) return 'No campaign activity yet'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamps.sort().at(-1)!))
}

export default function CampaignTrackingPage({ canAct, workspaceId }: { canAct: boolean; workspaceId: string }) {
  const [clients, setClients] = useState<RenewalClient[]>([])
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | 'messaged' | UpsellCampaignStage>('all')
  const [busy, setBusy] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lossClient, setLossClient] = useState<RenewalClient | undefined>()
  const [lossReason, setLossReason] = useState('')
  const [messageClient, setMessageClient] = useState<RenewalClient | undefined>()

  useEffect(() => {
    let active = true
    setBusy('loading')
    renewalApi<{ clients: RenewalClient[] }>().then((result) => {
      if (active) setClients(result.clients)
    }).catch((event) => {
      if (active) setError(event instanceof Error ? event.message : 'Campaign tracking could not be loaded.')
    }).finally(() => {
      if (active) setBusy('')
    })
    return () => { active = false }
  }, [workspaceId])

  const summary = useMemo(() => upsellCampaignSummary(clients), [clients])
  const filtered = useMemo(() => clients.filter((client) => {
    const stage = upsellCampaignStage(client)
    const query = search.trim().toLowerCase()
    return (stageFilter === 'all' || stageFilter === 'messaged' && stage !== 'not_contacted' || stage === stageFilter)
      && (!query || `${client.name} ${client.owner} ${client.email ?? ''} ${client.upsellCampaign?.nonProceedReason ?? ''}`.toLowerCase().includes(query))
  }).sort((left, right) => (right.upsellCampaign?.updatedAt ?? '').localeCompare(left.upsellCampaign?.updatedAt ?? '') || left.name.localeCompare(right.name)), [clients, search, stageFilter])

  const updateCampaign = async (client: RenewalClient, stage: UpsellCampaignStage, nonProceedReason?: string) => {
    if (stage === 'lost' && !nonProceedReason) {
      setLossClient(client)
      setLossReason(client.upsellCampaign?.nonProceedReason ?? '')
      return
    }
    if (stage === 'not_contacted' && upsellCampaignStage(client) !== 'not_contacted' && !window.confirm(`Reset all upsell campaign tracking for ${client.name}?`)) return
    setBusy(client.id)
    setError('')
    try {
      const result = await renewalApi<{ client: RenewalClient }>(`/api/renewal-clients/${client.id}/upsell-campaign`, {
        method: 'PATCH',
        body: JSON.stringify({ stage, nonProceedReason }),
      })
      setClients((current) => current.map((item) => item.id === result.client.id ? result.client : item))
      setNotice(`${result.client.name} moved to ${stageLabels[stage]}.`)
      setLossClient(undefined)
      setLossReason('')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The campaign stage could not be updated.')
    } finally {
      setBusy('')
    }
  }

  const saveLostOutcome = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (lossClient && lossReason.trim()) void updateCampaign(lossClient, 'lost', lossReason.trim())
  }

  if (busy === 'loading') return <section className="campaign-tracking-page renewal-loading"><RefreshCw className="spin" /><span>Opening Campaign Tracking…</span></section>

  return <section className="campaign-tracking-page">
    <div className="renewal-command-heading">
      <div>
        <p>Campaign Tracking · Launch Webinars</p>
        <h1>See every lead move from opener to upsell.</h1>
        <span>Track Fred’s VA campaign separately from the core client renewal workflow.</span>
      </div>
    </div>

    {error && <div className="integration-error"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="renewal-notice"><CheckCircle2 size={15} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></div>}

    <div className="upsell-metrics-grid campaign-page-metrics">
      <article><span>Opener sent</span><strong>{summary.openerSent}</strong></article>
      <article><span>Replied</span><strong>{summary.replied}</strong></article>
      <article><span>Interest confirmed</span><strong>{summary.interestConfirmed}</strong></article>
      <article><span>Call offered</span><strong>{summary.callOffered}</strong></article>
      <article><span>Call booked</span><strong>{summary.callBooked}</strong></article>
      <article><span>Call attended</span><strong>{summary.callAttended}</strong></article>
      <article className="won"><span>Upsell won</span><strong>{summary.won}</strong></article>
      <article className="lost"><span>Upsell lost</span><strong>{summary.lost}</strong></article>
    </div>

    <article className="panel campaign-leads-panel">
      <div className="panel-head"><div><h2>Campaign leads</h2></div><small>{filtered.length} shown</small></div>
      <div className="renewal-toolbar">
        <label><Search size={14} /><input aria-label="Search campaign leads" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search clients, owners or outcomes…" /></label>
        <select aria-label="Filter campaign leads" value={stageFilter} onChange={(event) => setStageFilter(event.target.value as typeof stageFilter)}>
          <option value="all">All clients</option>
          <option value="messaged">All messaged leads</option>
          {UPSELL_CAMPAIGN_STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
        </select>
      </div>
      <div className="campaign-lead-table-wrap">
        <div className="campaign-lead-table campaign-lead-head"><span>Client</span><span>Owner</span><span>Campaign stage</span><span>Latest activity</span><span>Outcome detail</span><span>SMS</span></div>
        {filtered.map((client) => <div className="campaign-lead-table campaign-lead-row" key={client.id}>
          <span><strong>{client.name}</strong><small>{client.email || client.phone || 'No contact detail saved'}</small></span>
          <span><strong>{client.owner}</strong></span>
          <span className="renewal-upsell-workflow">{canAct ? <select aria-label={`Upsell campaign stage for ${client.name}`} value={upsellCampaignStage(client)} disabled={busy === client.id} onChange={(event) => void updateCampaign(client, event.target.value as UpsellCampaignStage)}>{UPSELL_CAMPAIGN_STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select> : <strong>{stageLabels[upsellCampaignStage(client)]}</strong>}</span>
          <span><small>{latestCampaignActivity(client)}</small></span>
          <span className={client.upsellCampaign?.outcome === 'lost' ? 'campaign-loss-reason' : ''}><small>{client.upsellCampaign?.nonProceedReason || (client.upsellCampaign?.outcome === 'won' ? 'Upsell completed' : 'No outcome recorded')}</small></span>
          <span>{canAct && <button className="secondary-button campaign-message-button" disabled={!renewalOutreachAvailability(client).available} title={renewalOutreachAvailability(client).reason} onClick={() => setMessageClient(client)}><MessageSquareText size={14} /> Message</button>}</span>
        </div>)}
        {!filtered.length && <div className="renewal-empty"><h3>No campaign leads match this view</h3><p>Change the filter or add clients in Renewal Command before tracking the campaign.</p></div>}
      </div>
    </article>

    {lossClient && <div className="connection-modal-backdrop" onClick={() => setLossClient(undefined)}>
      <form className="connection-modal upsell-loss-modal" onSubmit={saveLostOutcome} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setLossClient(undefined)}><X size={18} /></button>
        <span className="eyebrow">Upsell outcome</span>
        <h2>Why did {lossClient.name} not proceed?</h2>
        <p>Record the real reason so Launch Webinars can learn which objections or gaps are costing renewals.</p>
        <label>Reason they did not proceed<textarea required maxLength={500} value={lossReason} onChange={(event) => setLossReason(event.target.value)} placeholder="For example: Timing was not right, pricing was too high, or they did not see enough value." /></label>
        <div className="renewal-editor-actions"><button type="button" className="ghost-button" onClick={() => setLossClient(undefined)}>Cancel</button><button className="primary-button" disabled={!lossReason.trim() || busy === lossClient.id}>Save lost outcome</button></div>
      </form>
    </div>}

    {messageClient && <RenewalOutreachDrawer
      client={messageClient}
      defaultKind="va_upsell_opener"
      onClose={() => setMessageClient(undefined)}
      onClientUpdated={(updated) => {
        setMessageClient(updated)
        setClients((current) => current.map((client) => client.id === updated.id ? updated : client))
      }}
      onNotice={setNotice}
    />}
  </section>
}
