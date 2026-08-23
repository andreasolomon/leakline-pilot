import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BarChart3, CalendarDays, CheckCircle2, ClipboardPlus, Database, Pencil, Plus, RefreshCw, Settings2, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react'
import { calculateKpis, compareKpiValue, effectiveKpiSnapshot, kpiCallEntryImpact, kpiOutcomeLabels, projectKpiSnapshotToMonthEnd, sortKpiSnapshots, type KpiCallEntryInput, type KpiCallOutcome, type KpiSnapshot, type KpiSnapshotInput } from './kpiTracking'
import { emptyKpiSnapshot, inputFromKpiSnapshot, kpiApi } from './kpiTrackingClient'
import { emptyHighLevelKpiData, highLevelKpiOutcomeLabels, type HighLevelKpiData, type HighLevelKpiOutcome } from './highLevelKpi'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`))
}

function formatDateTime(value?: string) {
  if (!value) return 'Not synced yet'
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function periodLabel(snapshot: Pick<KpiSnapshot, 'periodStart' | 'periodEnd'>) {
  return snapshot.periodStart === snapshot.periodEnd ? formatDate(snapshot.periodStart) : `${formatDate(snapshot.periodStart)} – ${formatDate(snapshot.periodEnd)}`
}

function Change({ value }: { value?: number }) {
  if (value === undefined) return <small>No comparable previous period</small>
  const rounded = Math.round(Math.abs(value) * 10) / 10
  if (value === 0) return <small>No change from previous period</small>
  return <small className={value > 0 ? 'positive' : 'negative'}>{value > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{rounded}% vs previous period</small>
}

function emptyCallEntry(snapshot: KpiSnapshot): KpiCallEntryInput {
  const today = new Date().toISOString().slice(0, 10)
  const occurredOn = today < snapshot.periodStart ? snapshot.periodStart : today > snapshot.periodEnd ? snapshot.periodEnd : today
  return { occurredOn, personName: '', outcome: 'offer_didnt_buy', revenueValue: 0, cashCollected: 0, notes: '' }
}

export default function KpiTrackingPage({ canAct, workspaceId }: { canAct: boolean; workspaceId: string }) {
  const [snapshots, setSnapshots] = useState<KpiSnapshot[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState<KpiSnapshotInput>(emptyKpiSnapshot)
  const [callEditorOpen, setCallEditorOpen] = useState(false)
  const [callDraft, setCallDraft] = useState<KpiCallEntryInput | null>(null)
  const [highLevel, setHighLevel] = useState<HighLevelKpiData>(emptyHighLevelKpiData)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [mappingPipelineId, setMappingPipelineId] = useState('')
  const [mappingDraft, setMappingDraft] = useState<Record<string, HighLevelKpiOutcome>>({})
  const [reportingPeriod, setReportingPeriod] = useState<'week' | 'month' | 'custom'>('month')
  const [customStart, setCustomStart] = useState(() => new Date().toISOString().slice(0, 10))
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().slice(0, 10))
  const highLevelPath = reportingPeriod === 'custom'
    ? `/api/kpi-tracking/highlevel?period=custom&startDate=${customStart}&endDate=${customEnd}`
    : `/api/kpi-tracking/highlevel?period=${reportingPeriod}`

  const load = async () => {
    setBusy('loading')
    setError('')
    try {
      const [body, highLevelBody] = await Promise.all([
        kpiApi<{ snapshots: KpiSnapshot[] }>(),
        kpiApi<HighLevelKpiData>(highLevelPath),
      ])
      setSnapshots(body.snapshots)
      setHighLevel(highLevelBody)
      setSelectedId((current) => body.snapshots.some((snapshot) => snapshot.id === current) ? current : body.snapshots[0]?.id ?? '')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'KPI periods could not be loaded.')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void load() }, [workspaceId, reportingPeriod, customStart, customEnd])

  useEffect(() => {
    let active = true
    const timer = window.setInterval(() => {
      void kpiApi<HighLevelKpiData>(highLevelPath)
        .then((body) => { if (active) setHighLevel(body) })
        .catch(() => { /* The visible last-sync time makes a stalled background refresh apparent. */ })
    }, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [workspaceId, highLevelPath])

  const pipelines = useMemo(() => Array.from(new Map(highLevel.stages.map((stage) => [stage.pipelineId, stage.pipelineName])).entries()).map(([id, name]) => ({ id, name })), [highLevel.stages])
  const mappingStages = useMemo(() => highLevel.stages.filter((stage) => stage.pipelineId === mappingPipelineId), [highLevel.stages, mappingPipelineId])

  const ordered = useMemo(() => sortKpiSnapshots(snapshots), [snapshots])
  const selectedIndex = Math.max(0, ordered.findIndex((snapshot) => snapshot.id === selectedId))
  const selected = ordered[selectedIndex]
  const previous = ordered[selectedIndex + 1]
  const selectedTotals = selected ? effectiveKpiSnapshot(selected) : undefined
  const previousTotals = previous ? effectiveKpiSnapshot(previous) : undefined
  const calculated = selected ? calculateKpis(selected) : undefined
  const previousCalculated = previous ? calculateKpis(previous) : undefined
  const manualProjection = selected ? projectKpiSnapshotToMonthEnd(selected) : undefined

  const openCreate = () => {
    setEditingId('')
    setDraft(emptyKpiSnapshot())
    setEditorOpen(true)
    setNotice('')
  }

  const openEdit = (snapshot: KpiSnapshot) => {
    setEditingId(snapshot.id)
    setDraft(inputFromKpiSnapshot(snapshot))
    setEditorOpen(true)
    setNotice('')
  }

  const openCallEditor = () => {
    if (!selected) return
    setCallDraft(emptyCallEntry(selected))
    setCallEditorOpen(true)
    setNotice('')
  }

  const saveCall = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected || !callDraft) return
    setBusy('saving-call')
    setError('')
    try {
      const body = await kpiApi<{ snapshot: KpiSnapshot }>(`/api/kpi-snapshots/${selected.id}/entries`, { method: 'POST', body: JSON.stringify(callDraft) })
      setSnapshots((current) => current.map((snapshot) => snapshot.id === body.snapshot.id ? body.snapshot : snapshot))
      setNotice(`${callDraft.personName}'s call was recorded and the KPI totals were updated.`)
      setCallEditorOpen(false)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The call result could not be saved.')
    } finally {
      setBusy('')
    }
  }

  const removeCall = async (entryId: string, personName: string) => {
    if (!selected || !window.confirm(`Remove ${personName}'s call entry? Its contribution will be removed from this period's totals.`)) return
    setBusy(entryId)
    setError('')
    try {
      const body = await kpiApi<{ snapshot: KpiSnapshot }>(`/api/kpi-snapshots/${selected.id}/entries/${entryId}`, { method: 'DELETE' })
      setSnapshots((current) => current.map((snapshot) => snapshot.id === body.snapshot.id ? body.snapshot : snapshot))
      setNotice('Call entry removed and KPI totals recalculated.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The call entry could not be removed.')
    } finally {
      setBusy('')
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy('saving')
    setError('')
    try {
      const body = await kpiApi<{ snapshot: KpiSnapshot }>(editingId ? `/api/kpi-snapshots/${editingId}` : '/api/kpi-snapshots', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...draft, notes: draft.notes ?? '' }),
      })
      setSnapshots((current) => editingId ? current.map((snapshot) => snapshot.id === body.snapshot.id ? body.snapshot : snapshot) : [...current, body.snapshot])
      setSelectedId(body.snapshot.id)
      setNotice(editingId ? 'KPI period updated.' : 'KPI period added.')
      setEditorOpen(false)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The KPI period could not be saved.')
    } finally {
      setBusy('')
    }
  }

  const remove = async (snapshot: KpiSnapshot) => {
    if (!window.confirm(`Remove the KPI period ${periodLabel(snapshot)}?`)) return
    setBusy(snapshot.id)
    setError('')
    try {
      await kpiApi(`/api/kpi-snapshots/${snapshot.id}`, { method: 'DELETE' })
      const remaining = ordered.filter((item) => item.id !== snapshot.id)
      setSnapshots(remaining)
      setSelectedId(remaining[0]?.id ?? '')
      setNotice('KPI period removed.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The KPI period could not be removed.')
    } finally {
      setBusy('')
    }
  }

  const openMapping = () => {
    const pipelineId = highLevel.settings.pipelineId ?? pipelines[0]?.id ?? ''
    setMappingPipelineId(pipelineId)
    setMappingDraft({ ...highLevel.settings.stageMappings })
    setMappingOpen(true)
    setNotice('')
  }

  const changePipeline = (pipelineId: string) => {
    const allowed = new Set(highLevel.stages.filter((stage) => stage.pipelineId === pipelineId).map((stage) => stage.stageId))
    setMappingPipelineId(pipelineId)
    setMappingDraft((current) => Object.fromEntries(Object.entries(current).filter(([stageId]) => allowed.has(stageId))) as Record<string, HighLevelKpiOutcome>)
  }

  const saveHighLevelMapping = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy('saving-ghl-mapping')
    setError('')
    try {
      await kpiApi<HighLevelKpiData>('/api/kpi-tracking/highlevel/settings', {
        method: 'PATCH',
        body: JSON.stringify({ pipelineId: mappingPipelineId, stageMappings: mappingDraft }),
      })
      setHighLevel(await kpiApi<HighLevelKpiData>(highLevelPath))
      setMappingOpen(false)
      setNotice('GoHighLevel pipeline mapping saved. KPI totals were recalculated.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The GoHighLevel mapping could not be saved.')
    } finally {
      setBusy('')
    }
  }

  const syncHighLevel = async () => {
    setBusy('syncing-ghl')
    setError('')
    try {
      await kpiApi('/api/integrations/highlevel/sync', { method: 'POST' })
      const body = await kpiApi<HighLevelKpiData>(highLevelPath)
      setHighLevel(body)
      setNotice('GoHighLevel refreshed. New pipeline movements are now included.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'GoHighLevel could not be refreshed.')
    } finally {
      setBusy('')
    }
  }

  if (busy === 'loading') return <section className="kpi-tracking-page kpi-loading"><RefreshCw className="spin" /><span>Opening KPI Tracking…</span></section>

  const rawCards = selectedTotals ? [
    ['Booked calls', selectedTotals.bookedCalls, previousTotals?.bookedCalls, 'Calls scheduled during this reporting period'],
    ['Calls taken', selectedTotals.callsTaken, previousTotals?.callsTaken, 'Calls that were actually attended'],
    ['Deals', selectedTotals.deals, previousTotals?.deals, 'Sales completed during the period'],
    ['Refunds', selectedTotals.refunds, previousTotals?.refunds, 'Deals refunded during the period'],
    ['Total revenue', selectedTotals.totalRevenue, previousTotals?.totalRevenue, 'revenue'],
    ['Cash collected', selectedTotals.cashCollected, previousTotals?.cashCollected, 'cash'],
  ] as const : []

  const efficiencyCards = selected && calculated ? [
    ['Conversion rate', `${calculated.conversionRate.toFixed(1)}%`, compareKpiValue(calculated.conversionRate, previousCalculated?.conversionRate), 'Deals ÷ calls taken'],
    ['Deals refunded', `${calculated.dealsRefundedRate.toFixed(1)}%`, compareKpiValue(calculated.dealsRefundedRate, previousCalculated?.dealsRefundedRate), 'Refunds ÷ deals'],
    ['Cash / call booked', money.format(calculated.cashPerCallBooked), compareKpiValue(calculated.cashPerCallBooked, previousCalculated?.cashPerCallBooked), 'Cash collected ÷ booked calls'],
    ['Revenue / call booked', money.format(calculated.revenuePerCallBooked), compareKpiValue(calculated.revenuePerCallBooked, previousCalculated?.revenuePerCallBooked), 'Total revenue ÷ booked calls'],
    ['Cash / call taken', money.format(calculated.cashPerCallTaken), compareKpiValue(calculated.cashPerCallTaken, previousCalculated?.cashPerCallTaken), 'Cash collected ÷ calls taken'],
    ['Cash / deal', money.format(calculated.cashPerDeal), compareKpiValue(calculated.cashPerDeal, previousCalculated?.cashPerDeal), 'Cash collected ÷ deals'],
  ] as const : []

  return <section className="kpi-tracking-page">
    <div className="kpi-tracking-heading">
      <div><p>KPI Tracking · Launch Webinars</p><h1>See sales performance without updating another sheet.</h1><span>LeakLine turns GoHighLevel pipeline movements into appointment, attendance and conversion KPIs. Manual reporting periods remain available below for historical totals.</span></div>
      {canAct && <div className="kpi-heading-actions">{selected && <button className="primary-button" onClick={openCallEditor}><ClipboardPlus size={15} /> Record call</button>}<button className="secondary-button" onClick={openCreate}><Plus size={15} /> Add period</button></div>}
    </div>

    {error && <div className="integration-error"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="renewal-notice"><CheckCircle2 size={15} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></div>}

    <article className="panel ghl-kpi-panel">
      <div className="panel-head ghl-kpi-head">
        <div><span className="eyebrow"><Database size={14} /> GoHighLevel pipeline</span><h2>Automated appointment and conversion tracking</h2><p>LeakLine reads pipeline movements from GoHighLevel and turns the stages Yonas already uses into consistent sales KPIs.</p></div>
        <div className="ghl-kpi-actions">
          {canAct && highLevel.connected && <button className="secondary-button" disabled={busy === 'syncing-ghl'} onClick={() => void syncHighLevel()}><RefreshCw size={14} className={busy === 'syncing-ghl' ? 'spin' : ''} /> {busy === 'syncing-ghl' ? 'Refreshing' : 'Refresh GHL'}</button>}
          {canAct && highLevel.connected && highLevel.stages.length > 0 && <button className="primary-button" onClick={openMapping}><Settings2 size={14} /> Map pipeline stages</button>}
        </div>
      </div>

      {!highLevel.connected ? <div className="ghl-kpi-setup-state"><AlertTriangle size={20} /><div><strong>GoHighLevel is not connected in this workspace</strong><span>Connect it from Data Sources first. Connections on the public host and local preview are stored separately.</span></div></div>
        : highLevel.stages.length === 0 ? <div className="ghl-kpi-setup-state"><RefreshCw size={20} /><div><strong>Refresh GoHighLevel to load its pipelines</strong><span>The connection exists, but LeakLine has not received the available pipeline stages yet.</span></div></div>
          : !highLevel.settings.pipelineId || Object.keys(highLevel.settings.stageMappings).length === 0 ? <div className="ghl-kpi-setup-state"><Settings2 size={20} /><div><strong>Map Yonas's pipeline stages once</strong><span>Choose which GHL stages mean booked call, no-show, converted or did not convert. LeakLine will use that mapping on every later sync.</span></div>{canAct && <button className="primary-button" onClick={openMapping}>Set up KPI mapping</button>}</div>
            : <>
              <div className="ghl-reporting-controls">
                <div><strong>Reporting period</strong><span>Only movements inside this period are included.</span></div>
                <div className="ghl-reporting-tabs">
                  <button className={reportingPeriod === 'week' ? 'active' : ''} onClick={() => setReportingPeriod('week')}>This week</button>
                  <button className={reportingPeriod === 'month' ? 'active' : ''} onClick={() => setReportingPeriod('month')}>This month</button>
                  <button className={reportingPeriod === 'custom' ? 'active' : ''} onClick={() => setReportingPeriod('custom')}>Custom</button>
                </div>
                {reportingPeriod === 'custom' && <div className="ghl-custom-dates"><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>To<input type="date" min={customStart} value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
              </div>
              <div className="ghl-kpi-status-strip">
                <span><CheckCircle2 size={14} /><strong>{pipelines.find((pipeline) => pipeline.id === highLevel.settings.pipelineId)?.name ?? 'Selected pipeline'} · automatic sync active</strong></span>
                <small>{highLevel.range.startDate && highLevel.range.endDate ? `${formatDate(highLevel.range.startDate)} to ${formatDate(highLevel.range.endDate)} · ` : ''}Last synced {formatDateTime(highLevel.lastSyncAt)} · {highLevel.summary.mappedStages} of {highLevel.summary.availableStages} stages mapped</small>
              </div>

              <section className="ghl-kpi-summary">
                <div className="kpi-section-heading"><span>Updated from GHL</span><h2>Appointment outcomes</h2></div>
                <div className="ghl-kpi-summary-grid">
                  {[
                    ['Total appointments', highLevel.summary.appointments, 'Unique opportunities reaching a mapped stage'],
                    ['No-shows', highLevel.summary.noShows, 'Appointments marked as no-show'],
                    ['Rescheduled', highLevel.summary.rescheduled, 'Appointments moved into rescheduled'],
                    ['Showed', highLevel.summary.showed, 'People who attended the sales call'],
                    ['Converted', highLevel.summary.started, 'Attendees who converted after showing up'],
                    ['Did not convert', highLevel.summary.didNotConvert, 'Attendees who did not start'],
                  ].map(([label, value, explanation]) => <article key={label}><span>{label}</span><strong>{integer.format(value as number)}</strong><p>{explanation}</p></article>)}
                </div>
              </section>

              <section className="ghl-kpi-rate-grid">
                <article><span>Show-up rate</span><strong>{highLevel.summary.showRate.toFixed(1)}%</strong><p>Showed ÷ total appointments</p></article>
                <article><span>Conversion from appointments</span><strong>{highLevel.summary.conversionFromAppointments.toFixed(1)}%</strong><p>Converted ÷ total appointments</p></article>
                <article><span>Conversion from shows</span><strong>{highLevel.summary.conversionFromShows.toFixed(1)}%</strong><p>Converted ÷ people who showed</p></article>
              </section>

              {highLevel.projection && <section className="ghl-projection-section">
                <div className="kpi-section-heading"><span>Current pace</span><h2>Projected by the end of this period</h2><p>Based on {highLevel.projection.elapsedDays} elapsed days out of {highLevel.projection.totalDays}. Projections are directional, not guaranteed outcomes.</p></div>
                <div className="ghl-projection-grid">
                  <article><span>Appointments</span><strong>{integer.format(highLevel.projection.appointments)}</strong><small>{integer.format(highLevel.summary.appointments)} recorded so far</small></article>
                  <article><span>Shows</span><strong>{integer.format(highLevel.projection.showed)}</strong><small>{integer.format(highLevel.summary.showed)} recorded so far</small></article>
                  <article><span>Conversions</span><strong>{integer.format(highLevel.projection.started)}</strong><small>{integer.format(highLevel.summary.started)} recorded so far</small></article>
                  <article><span>Contracted revenue</span><strong>{money.format(highLevel.projection.convertedRevenue)}</strong><small>{money.format(highLevel.summary.convertedRevenue)} recorded so far</small></article>
                </div>
              </section>}

              <div className="ghl-kpi-opportunity-wrap">
                <div className="ghl-kpi-opportunity-row ghl-kpi-opportunity-head"><span>Lead</span><span>Owner</span><span>GHL stage</span><span>LeakLine outcome</span><span>Last movement</span></div>
                {highLevel.opportunities.length === 0 ? <div className="ghl-kpi-table-empty">No opportunities have been returned for this pipeline yet.</div> : highLevel.opportunities.slice(0, 50).map((opportunity) => <div className="ghl-kpi-opportunity-row" key={opportunity.opportunityId}>
                  <span><strong>{opportunity.personName}</strong><small>{opportunity.status || 'Open'}</small></span>
                  <span>{opportunity.owner || 'Unassigned'}</span>
                  <span>{opportunity.stageName}</span>
                  <span><em className={opportunity.outcome ? 'mapped' : 'unmapped'}>{opportunity.outcomeLabel}</em></span>
                  <span>{formatDateTime(opportunity.changedAt)}</span>
                </div>)}
              </div>
            </>}
    </article>

    {!selected ? <article className="panel kpi-empty">
      <BarChart3 size={34} />
      <h2>No KPI periods tracked yet</h2>
      <p>Add the first reporting period manually, or upload the exported Gross Totals CSV from Data Sources.</p>
      {canAct && <button className="primary-button" onClick={openCreate}><Plus size={14} /> Add first period</button>}
    </article> : <>
      <div className="kpi-period-strip">
        <span><CalendarDays size={15} /><strong>{periodLabel(selected)}</strong><small>{selected.source === 'clickup' ? 'Synced from ClickUp' : selected.source === 'csv' ? 'Imported from KPI sheet' : 'Manually recorded'}{selected.entries?.length ? ` + ${selected.entries.length} call ${selected.entries.length === 1 ? 'entry' : 'entries'}` : ''}</small></span>
        <div>{canAct && <><button onClick={() => openEdit(selected)}><Pencil size={14} /> Edit period</button><button className="danger" onClick={() => void remove(selected)} disabled={busy === selected.id}><Trash2 size={14} /> Remove</button></>}</div>
      </div>

      <section className="kpi-section">
        <div className="kpi-section-heading"><span>Recorded totals</span><h2>Core sales KPIs</h2></div>
        <div className="kpi-core-grid">{rawCards.map(([label, value, prior, detail]) => {
          const monetary = detail === 'revenue' || detail === 'cash'
          const pending = Boolean(selected.financialsPending) && (label === 'Refunds' || monetary)
          return <article key={label}><span>{label}</span><strong>{pending ? 'Pending data' : monetary ? money.format(value) : integer.format(value)}</strong><p>{pending ? 'Awaiting the confirmed financial total' : detail === 'revenue' ? 'Revenue contracted during the period' : detail === 'cash' ? 'Cash received during the period' : detail}</p>{pending ? <small>Not treated as $0</small> : <Change value={compareKpiValue(value, prior)} />}</article>
        })}</div>
      </section>

      {manualProjection && <section className="kpi-section manual-projection-section">
        <div className="kpi-section-heading"><span>Month-to-date pace</span><h2>Projected month-end totals</h2><p>Based on {manualProjection.elapsedDays} recorded days out of {manualProjection.totalDays}. This is a straight-line pace estimate.</p></div>
        <div className="ghl-projection-grid">
          <article><span>Booked calls</span><strong>{integer.format(manualProjection.bookedCalls)}</strong><small>{integer.format(selectedTotals!.bookedCalls)} recorded so far</small></article>
          <article><span>Calls taken</span><strong>{integer.format(manualProjection.callsTaken)}</strong><small>{integer.format(selectedTotals!.callsTaken)} recorded so far</small></article>
          <article><span>Deals</span><strong>{integer.format(manualProjection.deals)}</strong><small>{integer.format(selectedTotals!.deals)} recorded so far</small></article>
          <article><span>Revenue</span><strong>{manualProjection.totalRevenue === undefined ? 'Pending data' : money.format(manualProjection.totalRevenue)}</strong><small>{manualProjection.totalRevenue === undefined ? 'Add confirmed financials to project revenue' : `${money.format(selectedTotals!.totalRevenue)} recorded so far`}</small></article>
          <article><span>Cash collected</span><strong>{manualProjection.cashCollected === undefined ? 'Pending data' : money.format(manualProjection.cashCollected)}</strong><small>{manualProjection.cashCollected === undefined ? 'Add confirmed financials to project cash' : `${money.format(selectedTotals!.cashCollected)} recorded so far`}</small></article>
        </div>
      </section>}

      <section className="kpi-section">
        <div className="kpi-section-heading"><span>Calculated automatically</span><h2>Efficiency metrics</h2></div>
        <div className="kpi-efficiency-grid">{efficiencyCards.map(([label, value, change, formula]) => {
          const pending = Boolean(selected.financialsPending) && label !== 'Conversion rate'
          return <article key={label}><span>{label}</span><strong>{pending ? 'Pending data' : value}</strong><p>{pending ? 'Awaiting confirmed financial totals' : formula}</p>{pending ? <small>Not calculated from temporary zeros</small> : <Change value={change} />}</article>
        })}</div>
      </section>

      <article className="panel kpi-call-ledger">
        <div className="panel-head"><div><span className="eyebrow"><ClipboardPlus size={14} /> Call-by-call tracking</span><h2>People, outcomes and cash collected</h2><p>These rows are added to the period's imported or manually entered baseline totals.</p></div>{canAct && <button className="secondary-button" onClick={openCallEditor}><Plus size={14} /> Record call</button>}</div>
        {!selected.entries?.length ? <div className="kpi-ledger-empty"><p>No individual calls have been recorded for this period yet.</p>{canAct && <button onClick={openCallEditor}>Record the first call</button>}</div> : <div className="kpi-call-table-wrap"><div className="kpi-call-row kpi-call-head"><span>Date</span><span>Person</span><span>Outcome</span><span>Revenue</span><span>Cash collected</span><span>Recorded by</span><span /></div>
          {[...selected.entries].sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt)).map((entry) => <div className="kpi-call-row" key={entry.id}>
            <span>{formatDate(entry.occurredOn)}</span><span><strong>{entry.personName}</strong><small>{entry.notes || 'No note added'}</small></span><span><em className={`kpi-outcome ${entry.outcome}`}>{kpiOutcomeLabels[entry.outcome]}</em></span><span>{money.format(entry.revenueValue)}</span><span className="kpi-call-cash">{money.format(entry.cashCollected)}</span><span>{entry.createdBy}</span><span>{canAct && <button aria-label={`Remove ${entry.personName}'s call entry`} disabled={busy === entry.id} onClick={() => void removeCall(entry.id, entry.personName)}><Trash2 size={13} /></button>}</span>
          </div>)}
        </div>}
      </article>

      <article className="panel kpi-history-panel">
        <div className="panel-head"><div><span className="eyebrow"><CalendarDays size={14} /> Reporting history</span><h2>Previous KPI periods</h2></div></div>
        <div className="kpi-history-wrap"><div className="kpi-history-row kpi-history-head"><span>Period</span><span>Booked</span><span>Taken</span><span>Deals</span><span>Conversion</span><span>Revenue</span><span>Cash</span><span>Cash / deal</span></div>
          {ordered.map((snapshot) => {
            const metrics = calculateKpis(snapshot)
            const totals = effectiveKpiSnapshot(snapshot)
            return <button key={snapshot.id} className={`kpi-history-row ${snapshot.id === selected.id ? 'selected' : ''}`} onClick={() => setSelectedId(snapshot.id)}>
              <span><strong>{periodLabel(snapshot)}</strong></span><span>{totals.bookedCalls}</span><span>{totals.callsTaken}</span><span>{totals.deals}</span><span>{metrics.conversionRate.toFixed(1)}%</span><span>{snapshot.financialsPending ? 'Pending' : money.format(totals.totalRevenue)}</span><span>{snapshot.financialsPending ? 'Pending' : money.format(totals.cashCollected)}</span><span>{snapshot.financialsPending ? 'Pending' : money.format(metrics.cashPerDeal)}</span>
            </button>
          })}
        </div>
      </article>
    </>}

    {editorOpen && <div className="connection-modal-backdrop" onClick={() => setEditorOpen(false)}>
      <form className="connection-modal kpi-editor" onSubmit={save} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setEditorOpen(false)}><X size={18} /></button>
        <span className="eyebrow">{editingId ? 'Update reporting period' : 'Add reporting period'}</span>
        <h2>{editingId ? 'Correct the KPI totals' : 'Record the sales totals'}</h2>
        <p>Enter the six source figures. LeakLine calculates every rate and per-call metric for you.</p>
        {error && <div className="modal-error"><AlertTriangle size={14} /><span>{error}</span></div>}
        <div className="kpi-editor-grid">
          <label>Period start<input type="date" required value={draft.periodStart} onChange={(event) => setDraft({ ...draft, periodStart: event.target.value })} /></label>
          <label>Period end<input type="date" required value={draft.periodEnd} onChange={(event) => setDraft({ ...draft, periodEnd: event.target.value })} /></label>
          <label>Booked calls<input type="number" required min="0" value={draft.bookedCalls} onChange={(event) => setDraft({ ...draft, bookedCalls: Number(event.target.value) })} /></label>
          <label>Calls taken<input type="number" required min="0" value={draft.callsTaken} onChange={(event) => setDraft({ ...draft, callsTaken: Number(event.target.value) })} /></label>
          <label>Deals<input type="number" required min="0" value={draft.deals} onChange={(event) => setDraft({ ...draft, deals: Number(event.target.value) })} /></label>
          <label>Refunds<input type="number" required min="0" disabled={Boolean(draft.financialsPending)} value={draft.refunds} onChange={(event) => setDraft({ ...draft, refunds: Number(event.target.value) })} /></label>
          <label>Total revenue ($)<input type="number" required min="0" step="0.01" disabled={Boolean(draft.financialsPending)} value={draft.totalRevenue} onChange={(event) => setDraft({ ...draft, totalRevenue: Number(event.target.value) })} /></label>
          <label>Cash collected ($)<input type="number" required min="0" step="0.01" disabled={Boolean(draft.financialsPending)} value={draft.cashCollected} onChange={(event) => setDraft({ ...draft, cashCollected: Number(event.target.value) })} /></label>
          <label className="kpi-financials-pending"><input type="checkbox" checked={Boolean(draft.financialsPending)} onChange={(event) => setDraft({ ...draft, financialsPending: event.target.checked })} /><span><strong>Financial totals are still pending</strong><small>Use this when refunds, revenue and cash have not been supplied yet. LeakLine will not present the placeholder values as confirmed $0.</small></span></label>
          <label className="kpi-notes-field">Period notes<textarea value={draft.notes ?? ''} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Campaign changes, closer changes or anything that explains this period…" /></label>
        </div>
        <div className="renewal-editor-actions"><button type="button" className="ghost-button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy === 'saving'}>{busy === 'saving' ? 'Saving…' : editingId ? 'Save period changes' : 'Add KPI period'}</button></div>
      </form>
    </div>}

    {callEditorOpen && callDraft && selected && <div className="connection-modal-backdrop" onClick={() => setCallEditorOpen(false)}>
      <form className="connection-modal kpi-call-editor" onSubmit={saveCall} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setCallEditorOpen(false)}><X size={18} /></button>
        <span className="eyebrow">Add to {periodLabel(selected)}</span>
        <h2>Record a call result</h2>
        <p>Add the person and the outcome once. LeakLine will update this period's totals automatically.</p>
        {error && <div className="modal-error"><AlertTriangle size={14} /><span>{error}</span></div>}
        <div className="kpi-editor-grid">
          <label>Call date<input type="date" required min={selected.periodStart} max={selected.periodEnd} value={callDraft.occurredOn} onChange={(event) => setCallDraft({ ...callDraft, occurredOn: event.target.value })} /></label>
          <label>Person's name<input autoFocus required minLength={2} maxLength={120} value={callDraft.personName} onChange={(event) => setCallDraft({ ...callDraft, personName: event.target.value })} placeholder="e.g. Alex Carter" /></label>
          <label>Call outcome<select value={callDraft.outcome} onChange={(event) => {
            const outcome = event.target.value as KpiCallOutcome
            const isDeal = ['full_pay', 'split_pay', 'deposit'].includes(outcome)
            setCallDraft({ ...callDraft, outcome, revenueValue: isDeal ? callDraft.revenueValue : 0, cashCollected: isDeal ? callDraft.cashCollected : 0 })
          }}>{Object.entries(kpiOutcomeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Contracted revenue ($)<input type="number" min="0" step="0.01" disabled={!['full_pay', 'split_pay', 'deposit'].includes(callDraft.outcome)} value={callDraft.revenueValue} onChange={(event) => setCallDraft({ ...callDraft, revenueValue: Number(event.target.value) })} /></label>
          <label>Cash collected ($)<input type="number" min="0" step="0.01" disabled={!['full_pay', 'split_pay', 'deposit'].includes(callDraft.outcome)} value={callDraft.cashCollected} onChange={(event) => setCallDraft({ ...callDraft, cashCollected: Number(event.target.value) })} /></label>
          <label className="kpi-notes-field">Notes<textarea maxLength={1000} value={callDraft.notes ?? ''} onChange={(event) => setCallDraft({ ...callDraft, notes: event.target.value })} placeholder="Payment plan, follow-up needed, or useful context…" /></label>
        </div>
        {(() => { const impact = kpiCallEntryImpact(callDraft); return <div className="kpi-entry-impact"><strong>This entry will add:</strong><span>+1 booked call</span><span>+{impact.callsTaken} call taken</span><span>+{impact.deals} deal</span><span>+{money.format(impact.cashCollected)} cash</span></div> })()}
        <div className="renewal-editor-actions"><button type="button" className="ghost-button" onClick={() => setCallEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy === 'saving-call'}>{busy === 'saving-call' ? 'Saving…' : 'Save call result'}</button></div>
      </form>
    </div>}

    {mappingOpen && <div className="connection-modal-backdrop" onClick={() => setMappingOpen(false)}>
      <form className="connection-modal ghl-kpi-mapping-modal" onSubmit={saveHighLevelMapping} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={() => setMappingOpen(false)}><X size={18} /></button>
        <span className="eyebrow">One-time pipeline setup</span>
        <h2>Tell LeakLine what each GHL stage means</h2>
        <p>GoHighLevel keeps its exact stage names. This mapping gives LeakLine one consistent definition for every KPI.</p>
        <label className="ghl-pipeline-field">GoHighLevel pipeline<select required value={mappingPipelineId} onChange={(event) => changePipeline(event.target.value)}><option value="" disabled>Choose a pipeline</option>{pipelines.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.name}</option>)}</select></label>
        <div className="ghl-stage-mapping-list">
          {mappingStages.map((stage) => <label key={stage.stageId}><span>{stage.stageName}</span><select value={mappingDraft[stage.stageId] ?? ''} onChange={(event) => {
            const value = event.target.value as HighLevelKpiOutcome | ''
            setMappingDraft((current) => {
              const next = { ...current }
              if (value) next[stage.stageId] = value
              else delete next[stage.stageId]
              return next
            })
          }}><option value="">Not included in KPI tracking</option>{Object.entries(highLevelKpiOutcomeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>)}
        </div>
        <div className="ghl-mapping-note"><AlertTriangle size={15} /><span>Only map stages that represent these exact outcomes. You can leave administrative or unrelated stages out.</span></div>
        <div className="renewal-editor-actions"><button type="button" className="ghost-button" onClick={() => setMappingOpen(false)}>Cancel</button><button className="primary-button" disabled={!mappingPipelineId || busy === 'saving-ghl-mapping'}>{busy === 'saving-ghl-mapping' ? 'Saving mapping' : 'Save KPI mapping'}</button></div>
      </form>
    </div>}
  </section>
}
