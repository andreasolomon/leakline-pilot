import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BarChart3, CheckCircle2, FileUp, RefreshCw, Users, X } from 'lucide-react'
import IntegrationPage from './IntegrationPage'
import type { ImportWorkspace } from './csvEngine'
import type { ProviderId } from './integrationTypes'
import { classifyClickUpImport, parseClickUpRenewalCsv, type ClickUpRenewalPreview } from './clickUpRenewalImport'
import { parseKpiSheetCsv, type KpiSheetPreview } from './kpiSheetImport'
import { kpiApi } from './kpiTrackingClient'
import type { KpiSnapshot, KpiSnapshotInput } from './kpiTracking'
import { renewalApi } from './renewalCommandClient'
import type { RenewalClient } from './renewalCommand'

const allowedProviders: ProviderId[] = ['clickup', 'whop', 'highlevel']
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export default function RenewalDataSourcesPage({
  workspaceId,
  canManage,
  canSync,
  onWorkspace,
}: {
  workspaceId: string
  canManage: boolean
  canSync: boolean
  onWorkspace: (workspace: ImportWorkspace) => void
}) {
  const clickUpInput = useRef<HTMLInputElement>(null)
  const kpiInput = useRef<HTMLInputElement>(null)
  const [clients, setClients] = useState<RenewalClient[]>([])
  const [clickUpPreview, setClickUpPreview] = useState<ClickUpRenewalPreview | null>(null)
  const [kpiPreview, setKpiPreview] = useState<KpiSheetPreview | null>(null)
  const [kpiDraft, setKpiDraft] = useState<KpiSnapshotInput | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    void renewalApi<{ clients: RenewalClient[] }>().then((body) => {
      if (active) setClients(body.clients)
    }).catch(() => {
      if (active) setClients([])
    })
    return () => { active = false }
  }, [workspaceId])

  const clickUpChanges = useMemo(() => clickUpPreview ? classifyClickUpImport(clickUpPreview.rows, clients) : null, [clickUpPreview, clients])

  const chooseClickUpFile = async (event: ChangeEvent<HTMLInputElement>) => {
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
      setError('The ClickUp CSV could not be read. Export the Client Manager List as CSV and try again.')
    }
  }

  const importClickUp = async () => {
    if (!clickUpPreview) return
    setBusy('clickup')
    setError('')
    try {
      const body = await renewalApi<{ clients: RenewalClient[]; result: { created: number; updated: number; unchanged: number } }>('/api/renewal-clients/import-clickup', {
        method: 'POST',
        body: JSON.stringify({
          fileName: clickUpPreview.fileName,
          sourceRows: clickUpPreview.sourceRows,
          rows: clickUpPreview.rows,
        }),
      })
      setClients(body.clients)
      setClickUpPreview(null)
      setNotice(`ClickUp sheet imported: ${body.result.created} created, ${body.result.updated} updated and ${body.result.unchanged} unchanged.`)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The ClickUp clients could not be imported.')
    } finally {
      setBusy('')
    }
  }

  const chooseKpiFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setNotice('')
    if (file.size > 2 * 1024 * 1024) {
      setError('The KPI export is too large. Choose a CSV smaller than 2 MB.')
      return
    }
    try {
      const preview = parseKpiSheetCsv(file.name, await file.text())
      if (!preview.input) {
        setError(preview.issues.join(' '))
        return
      }
      setKpiPreview(preview)
      setKpiDraft(preview.input)
    } catch {
      setError('The KPI CSV could not be read. Export the sheet as CSV and try again.')
    }
  }

  const importKpis = async () => {
    if (!kpiDraft) return
    setBusy('kpi')
    setError('')
    try {
      const body = await kpiApi<{ snapshot: KpiSnapshot; action: 'created' | 'updated' }>('/api/kpi-snapshots/import', {
        method: 'POST',
        body: JSON.stringify(kpiDraft),
      })
      setKpiPreview(null)
      setKpiDraft(null)
      setNotice(`KPI period ${body.action}. Open KPI Tracking to review the calculated rates.`)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'The KPI sheet could not be imported.')
    } finally {
      setBusy('')
    }
  }

  return <section className="renewal-data-sources-page">
    {error && <div className="integration-error"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="renewal-notice"><CheckCircle2 size={15} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={14} /></button></div>}

    <IntegrationPage
      onWorkspace={onWorkspace}
      canManage={canManage}
      manageableProviders={canSync ? ['clickup'] : []}
      canSync={canSync}
      allowedProviders={allowedProviders}
      showSandbox={false}
      heading={{
        eyebrow: 'Launch Webinars data',
        title: 'Connect the systems behind renewals.',
        description: canManage
          ? 'Connect ClickUp, Whop and GoHighLevel. Credentials are validated server-side and encrypted before they are stored.'
          : canSync
            ? 'Connect ClickUp, refresh renewal data or upload the latest exports. A client admin is still required for CRM and payment credentials.'
            : 'Review the connected systems and import history behind this workspace.',
      }}
    />

    <section className="manual-source-section">
      <div className="manual-source-heading"><span>Manual fallback</span><h2>Upload exported sheets</h2><p>Use these when a live connection is not ready or when the team wants to control exactly when data changes.</p></div>
      <div className="manual-source-grid">
        <article className="panel manual-source-card">
          <span className="manual-source-icon"><Users size={20} /></span>
          <div><span className="eyebrow">Client delivery data</span><h3>ClickUp Client Manager CSV</h3><p>Imports client names, webinar dates, program status and the webinar counter. Existing feedback and renewal work are preserved.</p></div>
          {canSync ? <><input ref={clickUpInput} className="clickup-file-input" type="file" accept=".csv,text/csv" onChange={chooseClickUpFile} /><button className="secondary-button" onClick={() => clickUpInput.current?.click()}><FileUp size={14} /> Upload ClickUp CSV</button></> : <small>Read-only access</small>}
        </article>
        <article className="panel manual-source-card">
          <span className="manual-source-icon"><BarChart3 size={20} /></span>
          <div><span className="eyebrow">Gross Totals</span><h3>KPI Tracking CSV</h3><p>Reads Booked Calls, Calls Taken, Deals, Refunds, Total Revenue and Cash Collected from the Gross Totals section.</p></div>
          {canSync ? <><input ref={kpiInput} className="clickup-file-input" type="file" accept=".csv,text/csv" onChange={chooseKpiFile} /><button className="secondary-button" onClick={() => kpiInput.current?.click()}><FileUp size={14} /> Upload KPI CSV</button></> : <small>Read-only access</small>}
        </article>
      </div>
    </section>

    {clickUpPreview && clickUpChanges && <div className="connection-modal-backdrop" onClick={() => busy !== 'clickup' && setClickUpPreview(null)}>
      <section className="connection-modal clickup-preview-modal" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" disabled={busy === 'clickup'} onClick={() => setClickUpPreview(null)}><X size={18} /></button>
        <span className="eyebrow"><FileUp size={14} /> ClickUp import preview</span>
        <h2>Review before updating Renewal Command</h2>
        <p>{clickUpPreview.fileName} contains {clickUpPreview.rows.length} valid client records. Nothing is saved until you confirm.</p>
        <div className="clickup-preview-summary">
          <article><span>New clients</span><strong>{clickUpChanges.create}</strong><small>Default owner Yonas · $8,000 expected value</small></article>
          <article><span>Updated clients</span><strong>{clickUpChanges.update}</strong><small>Only ClickUp-owned fields change</small></article>
          <article><span>Unchanged</span><strong>{clickUpChanges.unchanged}</strong><small>Duplicate-safe replay</small></article>
          <article><span>Webinar dates</span><strong>{clickUpPreview.completedWebinarDates}</strong><small>{clickUpPreview.futureWebinarDates} future dates</small></article>
        </div>
        {clickUpPreview.issues.length > 0 && <div className="clickup-import-issues"><AlertTriangle size={15} /><div><strong>{clickUpPreview.issues.length} rows need attention</strong>{clickUpPreview.issues.map((issue) => <span key={issue}>{issue}</span>)}</div></div>}
        <div className="clickup-preview-table">
          <div><span>Client</span><span>Webinars</span><span>Next webinar</span></div>
          {clickUpPreview.rows.slice(0, 6).map((row) => <div key={row.clickUpTaskId}><span><strong>{row.name}</strong><small>{row.email || row.clickUpTaskId}</small></span><span>{row.webinarsHosted}</span><span>{row.nextWebinarAt || 'Not scheduled'}</span></div>)}
        </div>
        <div className="renewal-editor-actions"><button className="ghost-button" disabled={busy === 'clickup'} onClick={() => setClickUpPreview(null)}>Cancel</button><button className="primary-button" disabled={busy === 'clickup'} onClick={() => void importClickUp()}>{busy === 'clickup' ? <><RefreshCw className="spin" size={15} /> Importing…</> : <><FileUp size={15} /> Confirm ClickUp import</>}</button></div>
      </section>
    </div>}

    {kpiPreview && kpiDraft && <div className="connection-modal-backdrop" onClick={() => busy !== 'kpi' && setKpiPreview(null)}>
      <section className="connection-modal kpi-import-modal" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" disabled={busy === 'kpi'} onClick={() => setKpiPreview(null)}><X size={18} /></button>
        <span className="eyebrow"><BarChart3 size={14} /> KPI sheet preview</span>
        <h2>Confirm the reporting period</h2>
        <p>LeakLine found all six Gross Totals in {kpiPreview.fileName}. Choose the dates these figures cover before saving.</p>
        <div className="kpi-import-dates"><label>Period start<input type="date" value={kpiDraft.periodStart} onChange={(event) => setKpiDraft({ ...kpiDraft, periodStart: event.target.value })} /></label><label>Period end<input type="date" value={kpiDraft.periodEnd} onChange={(event) => setKpiDraft({ ...kpiDraft, periodEnd: event.target.value })} /></label></div>
        <div className="kpi-import-summary">
          <article><span>Booked calls</span><strong>{kpiDraft.bookedCalls}</strong></article>
          <article><span>Calls taken</span><strong>{kpiDraft.callsTaken}</strong></article>
          <article><span>Deals</span><strong>{kpiDraft.deals}</strong></article>
          <article><span>Refunds</span><strong>{kpiDraft.refunds}</strong></article>
          <article><span>Total revenue</span><strong>{money.format(kpiDraft.totalRevenue)}</strong></article>
          <article><span>Cash collected</span><strong>{money.format(kpiDraft.cashCollected)}</strong></article>
        </div>
        <label>Import note<textarea value={kpiDraft.notes ?? ''} onChange={(event) => setKpiDraft({ ...kpiDraft, notes: event.target.value })} /></label>
        <div className="renewal-editor-actions"><button className="ghost-button" disabled={busy === 'kpi'} onClick={() => setKpiPreview(null)}>Cancel</button><button className="primary-button" disabled={busy === 'kpi'} onClick={() => void importKpis()}>{busy === 'kpi' ? <><RefreshCw className="spin" size={15} /> Importing…</> : <><FileUp size={15} /> Import KPI period</>}</button></div>
      </section>
    </div>}
  </section>
}
