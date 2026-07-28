import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BarChart3, CalendarDays, CheckCircle2, Pencil, Plus, RefreshCw, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react'
import { calculateKpis, compareKpiValue, sortKpiSnapshots, type KpiSnapshot, type KpiSnapshotInput } from './kpiTracking'
import { emptyKpiSnapshot, inputFromKpiSnapshot, kpiApi } from './kpiTrackingClient'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`))
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

export default function KpiTrackingPage({ canAct, workspaceId }: { canAct: boolean; workspaceId: string }) {
  const [snapshots, setSnapshots] = useState<KpiSnapshot[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState<KpiSnapshotInput>(emptyKpiSnapshot)

  const load = async () => {
    setBusy('loading')
    setError('')
    try {
      const body = await kpiApi<{ snapshots: KpiSnapshot[] }>()
      setSnapshots(body.snapshots)
      setSelectedId((current) => body.snapshots.some((snapshot) => snapshot.id === current) ? current : body.snapshots[0]?.id ?? '')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'KPI periods could not be loaded.')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void load() }, [workspaceId])

  const ordered = useMemo(() => sortKpiSnapshots(snapshots), [snapshots])
  const selectedIndex = Math.max(0, ordered.findIndex((snapshot) => snapshot.id === selectedId))
  const selected = ordered[selectedIndex]
  const previous = ordered[selectedIndex + 1]
  const calculated = selected ? calculateKpis(selected) : undefined
  const previousCalculated = previous ? calculateKpis(previous) : undefined

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

  if (busy === 'loading') return <section className="kpi-tracking-page kpi-loading"><RefreshCw className="spin" /><span>Opening KPI Tracking…</span></section>

  const rawCards = selected ? [
    ['Booked calls', selected.bookedCalls, previous?.bookedCalls, 'Calls scheduled during this reporting period'],
    ['Calls taken', selected.callsTaken, previous?.callsTaken, 'Calls that were actually attended'],
    ['Deals', selected.deals, previous?.deals, 'Sales completed during the period'],
    ['Refunds', selected.refunds, previous?.refunds, 'Deals refunded during the period'],
    ['Total revenue', selected.totalRevenue, previous?.totalRevenue, 'revenue'],
    ['Cash collected', selected.cashCollected, previous?.cashCollected, 'cash'],
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
      <div><p>KPI Tracking · Launch Webinars</p><h1>Track the numbers driving sales performance.</h1><span>Record the gross sales totals once. LeakLine calculates conversion and cash-efficiency metrics automatically.</span></div>
      {canAct && <button className="primary-button" onClick={openCreate}><Plus size={15} /> Add period</button>}
    </div>

    {error && <div className="integration-error"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="renewal-notice"><CheckCircle2 size={15} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></div>}

    {!selected ? <article className="panel kpi-empty">
      <BarChart3 size={34} />
      <h2>No KPI periods tracked yet</h2>
      <p>Add the first reporting period manually. ClickUp will later populate the same figures automatically.</p>
      {canAct && <button className="primary-button" onClick={openCreate}><Plus size={14} /> Add first period</button>}
    </article> : <>
      <div className="kpi-period-strip">
        <span><CalendarDays size={15} /><strong>{periodLabel(selected)}</strong><small>{selected.source === 'clickup' ? 'Synced from ClickUp' : 'Manually recorded'}</small></span>
        <div>{canAct && <><button onClick={() => openEdit(selected)}><Pencil size={14} /> Edit period</button><button className="danger" onClick={() => void remove(selected)} disabled={busy === selected.id}><Trash2 size={14} /> Remove</button></>}</div>
      </div>

      <section className="kpi-section">
        <div className="kpi-section-heading"><span>Recorded totals</span><h2>Core sales KPIs</h2></div>
        <div className="kpi-core-grid">{rawCards.map(([label, value, prior, detail]) => {
          const monetary = detail === 'revenue' || detail === 'cash'
          return <article key={label}><span>{label}</span><strong>{monetary ? money.format(value) : integer.format(value)}</strong><p>{detail === 'revenue' ? 'Revenue contracted during the period' : detail === 'cash' ? 'Cash received during the period' : detail}</p><Change value={compareKpiValue(value, prior)} /></article>
        })}</div>
      </section>

      <section className="kpi-section">
        <div className="kpi-section-heading"><span>Calculated automatically</span><h2>Efficiency metrics</h2></div>
        <div className="kpi-efficiency-grid">{efficiencyCards.map(([label, value, change, formula]) => <article key={label}><span>{label}</span><strong>{value}</strong><p>{formula}</p><Change value={change} /></article>)}</div>
      </section>

      <article className="panel kpi-history-panel">
        <div className="panel-head"><div><span className="eyebrow"><CalendarDays size={14} /> Reporting history</span><h2>Previous KPI periods</h2></div></div>
        <div className="kpi-history-wrap"><div className="kpi-history-row kpi-history-head"><span>Period</span><span>Booked</span><span>Taken</span><span>Deals</span><span>Conversion</span><span>Revenue</span><span>Cash</span><span>Cash / deal</span></div>
          {ordered.map((snapshot) => {
            const metrics = calculateKpis(snapshot)
            return <button key={snapshot.id} className={`kpi-history-row ${snapshot.id === selected.id ? 'selected' : ''}`} onClick={() => setSelectedId(snapshot.id)}>
              <span><strong>{periodLabel(snapshot)}</strong><small>{snapshot.notes || 'No notes'}</small></span><span>{snapshot.bookedCalls}</span><span>{snapshot.callsTaken}</span><span>{snapshot.deals}</span><span>{metrics.conversionRate.toFixed(1)}%</span><span>{money.format(snapshot.totalRevenue)}</span><span>{money.format(snapshot.cashCollected)}</span><span>{money.format(metrics.cashPerDeal)}</span>
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
          <label>Refunds<input type="number" required min="0" value={draft.refunds} onChange={(event) => setDraft({ ...draft, refunds: Number(event.target.value) })} /></label>
          <label>Total revenue ($)<input type="number" required min="0" step="0.01" value={draft.totalRevenue} onChange={(event) => setDraft({ ...draft, totalRevenue: Number(event.target.value) })} /></label>
          <label>Cash collected ($)<input type="number" required min="0" step="0.01" value={draft.cashCollected} onChange={(event) => setDraft({ ...draft, cashCollected: Number(event.target.value) })} /></label>
          <label className="kpi-notes-field">Period notes<textarea value={draft.notes ?? ''} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Campaign changes, closer changes or anything that explains this period…" /></label>
        </div>
        <div className="renewal-editor-actions"><button type="button" className="ghost-button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy === 'saving'}>{busy === 'saving' ? 'Saving…' : editingId ? 'Save period changes' : 'Add KPI period'}</button></div>
      </form>
    </div>}
  </section>
}
