import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Database,
  FileSpreadsheet,
  FlaskConical,
  Link2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  UploadCloud,
  Users,
} from 'lucide-react'
import { datasetConfig, generateImportLeaks, importSummary, mergeIntegrationWorkspace, normaliseCsv, type DatasetKind, type ImportWorkspace } from './csvEngine'
import type { Leak } from './leakEngine'
import { buildSampleWorkspace } from './sampleWorkspace'
import type { IntegrationSnapshot, ProviderId } from './integrationTypes'

const kinds = Object.keys(datasetConfig) as DatasetKind[]

const sampleProviders: Array<{ id: ProviderId; label: string; connectedText: string }> = [
  { id: 'highlevel', label: 'GoHighLevel', connectedText: 'Sample GoHighLevel data connected' },
  { id: 'stripe', label: 'Stripe', connectedText: 'Sample Stripe payments connected' },
  { id: 'google-calendar', label: 'Calendar', connectedText: 'Sample Calendar appointments connected' },
  { id: 'fathom', label: 'Fathom', connectedText: 'Sample Fathom calls connected' },
]

const preflight = [
  { icon: Database, category: 'CRM', needs: 'Leads, opportunities, owners, stages, last activity', why: 'Shows who opted in, where every deal sits, and who owns the follow-up.' },
  { icon: CalendarDays, category: 'Calendar', needs: 'Booked calls, attended calls, no-shows', why: 'Finds the gap between interest, booked calls, and actual sales conversations.' },
  { icon: CreditCard, category: 'Payments', needs: 'Paid, failed, refunded, overdue', why: 'Separates confirmed losses from money that may still be recovered.' },
  { icon: AudioLines, category: 'Calls', needs: 'Recordings, summaries, objections, closer', why: 'Adds context behind missed sales, objections, and coaching patterns.' },
  { icon: Users, category: 'Team', needs: 'Closer name, calls taken, cash collected, close rate', why: 'Makes performance comparison fair enough to act on.' },
]

type ImportPageProps = {
  onApply: (workspace: ImportWorkspace, alerts: Leak[], sourceMode: 'exports' | 'sandbox') => void
  onClear?: () => void
  onOpenIntegrations?: () => void
  onSandboxSnapshot?: (snapshot: IntegrationSnapshot) => void
  initialWorkspace?: ImportWorkspace
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`)
  return body
}

export default function ImportPage({ onApply, onClear, onOpenIntegrations, onSandboxSnapshot, initialWorkspace = {} }: ImportPageProps) {
  const [workspace, setWorkspace] = useState<ImportWorkspace>(initialWorkspace)
  const [reading, setReading] = useState<DatasetKind | null>(null)
  const [mappingKind, setMappingKind] = useState<DatasetKind | null>(null)
  const [sandboxing, setSandboxing] = useState(false)
  const [sandboxError, setSandboxError] = useState('')
  const [sampleStatuses, setSampleStatuses] = useState<string[]>([])
  const inputs = useRef<Partial<Record<DatasetKind, HTMLInputElement | null>>>({})
  const summary = useMemo(() => importSummary(workspace), [workspace])
  const alerts = useMemo(() => generateImportLeaks(workspace), [workspace])

  useEffect(() => { setWorkspace(initialWorkspace) }, [initialWorkspace])

  const receive = async (kind: DatasetKind, file?: File) => {
    if (!file) return
    setReading(kind)
    setSandboxError('')
    setSampleStatuses([])
    try {
      const imported = normaliseCsv(kind, file.name, await file.text())
      setWorkspace((current) => ({ ...current, [kind]: imported }))
    } finally { setReading(null) }
  }

  const remap = (kind: DatasetKind, field: string, header: string) => {
    const current = workspace[kind]
    if (!current?.sourceText) return
    const nextMapping = { ...current.mapping }
    if (header) nextMapping[field] = header
    else delete nextMapping[field]
    setWorkspace((value) => ({ ...value, [kind]: normaliseCsv(kind, current.fileName, current.sourceText!, nextMapping) }))
  }

  const loadDemoWorkspace = () => {
    setSandboxError('')
    setSampleStatuses(['Sample Ascend Growth Partners CSV workspace loaded', '85 records prepared across leads, calls, deals, payments and closers'])
    setWorkspace(buildSampleWorkspace())
  }

  const previewSandbox = async () => {
    setSandboxing(true)
    setSandboxError('')
    setSampleStatuses([])
    try {
      let nextWorkspace = workspace
      let latestSnapshot: IntegrationSnapshot | null = null
      const connected: string[] = []
      for (const provider of sampleProviders) {
        const snapshot = await api<IntegrationSnapshot>(`/api/integrations/${provider.id}/sandbox-sync`, { method: 'POST' })
        latestSnapshot = snapshot
        nextWorkspace = mergeIntegrationWorkspace(nextWorkspace, snapshot.workspace)
        connected.push(provider.connectedText)
        setSampleStatuses([...connected])
      }
      setWorkspace(nextWorkspace)
      if (latestSnapshot) onSandboxSnapshot?.({ ...latestSnapshot, workspace: nextWorkspace })
    } catch (requestError) {
      setSandboxError(requestError instanceof Error ? requestError.message : 'Sample data preview failed.')
    } finally { setSandboxing(false) }
  }

  return <section className="import-page">
    <div className="page-heading section-heading import-heading">
      <div><p>Connect or import</p><h1>Connect or Import Data</h1><span>LeakLine can connect directly to your tools, or start from exports if you do not want to connect yet.</span></div>
      <span className="privacy-note"><ShieldCheck size={15} /> Local-first demo workspace</span>
    </div>

    <section className="connect-import-hero panel">
      <div>
        <span className="eyebrow"><Link2 size={14} /> One data path</span>
        <h2>Start with the cleanest source available.</h2>
        <p>For a live pilot, connect the tools. For a low-friction first look, upload CSV exports. For a polished demo, load the sample high-ticket workspace and show what to fix before adding more volume.</p>
      </div>
      <div className="connect-actions">
        <button className="hero-primary" onClick={previewSandbox} disabled={sandboxing}>
          {sandboxing ? <RefreshCw className="spin" size={15} /> : <FlaskConical size={15} />}
          {sandboxing ? 'Loading sample data…' : 'Preview with sample high-ticket data'}
        </button>
        <button className="hero-secondary" onClick={onOpenIntegrations}><Link2 size={15} /> Connect live tools</button>
        <button className="hero-secondary" onClick={() => inputs.current.leads?.click()}><UploadCloud size={15} /> Import CSV exports</button>
      </div>
    </section>

    <section className="preflight-panel panel">
      <div className="panel-head"><div><span className="eyebrow"><ShieldCheck size={14} /> Integration readiness</span><h2>What LeakLine needs before the numbers are trusted</h2></div></div>
      <div className="preflight-grid">
        {preflight.map(({ icon: Icon, category, needs, why }) => <article className="preflight-card" key={category}>
          <span><Icon size={17} /></span>
          <div><strong>{category}</strong><p>{needs}</p><small>{why}</small></div>
        </article>)}
      </div>
    </section>

    <div className="import-layout">
      <div className="upload-stack">
        <div className="upload-section-title"><span className="eyebrow"><FileSpreadsheet size={14} /> CSV fallback</span><h2>Import exports if the prospect is not ready to connect yet.</h2></div>
        {kinds.map((kind, index) => {
          const config = datasetConfig[kind]
          const imported = workspace[kind]
          return <article className={`upload-card ${imported ? 'complete' : ''} ${mappingKind === kind ? 'mapping-open' : ''}`} key={kind}>
            <span className="upload-step">{imported ? <Check size={15} /> : index + 1}</span>
            <div className="upload-copy"><h2>{config.label}</h2><p>{config.description}</p>
              {imported && <div className="file-result"><strong>{imported.fileName}</strong><span>{imported.rows.length} rows · {imported.mappedFields.length} fields mapped</span>{imported.issues.length > 0 && <em><AlertTriangle size={12} /> {imported.issues.length} issue{imported.issues.length === 1 ? '' : 's'}</em>}</div>}
            </div>
            <input ref={(element) => { inputs.current[kind] = element }} type="file" accept=".csv,text/csv" onChange={(event) => receive(kind, event.target.files?.[0])} />
            <div className="upload-actions">
              <button className={imported ? 'replace-file' : 'choose-file'} onClick={() => inputs.current[kind]?.click()} disabled={reading === kind}>
                {reading === kind ? <RefreshCw className="spin" size={15} /> : imported ? <RefreshCw size={15} /> : <UploadCloud size={16} />}{reading === kind ? 'Reading…' : imported ? 'Replace' : 'Choose CSV'}
              </button>
              {imported && <button className="map-columns" onClick={() => setMappingKind((current) => current === kind ? null : kind)}><Settings2 size={14} /> Map columns <ChevronDown size={13} /></button>}
            </div>
            {imported && mappingKind === kind && <div className="column-mapper">
              <div className="mapper-head"><div><strong>Match columns</strong><span>Tell LeakLine what each column means.</span></div><em>{imported.mappedFields.length}/{config.fields.length} mapped</em></div>
              {!imported.sourceText && <div className="mapping-disabled"><AlertTriangle size={14} /> Re-upload this CSV to change its saved mapping.</div>}
              <div className="mapping-grid">{config.fields.map((field) => <label key={field.key}><span>{field.key.replaceAll('_', ' ')}</span><select value={imported.mapping[field.key] ?? ''} onChange={(event) => remap(kind, field.key, event.target.value)} disabled={!imported.sourceText}><option value="">Not mapped</option>{imported.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>
              {imported.issues.length > 0 && <div className="row-issues"><strong>Validation issues</strong>{imported.issues.map((issue) => <span key={issue}><AlertTriangle size={12} /> {issue}</span>)}</div>}
            </div>}
          </article>
        })}
      </div>

      <aside className="import-summary panel">
        <span className="eyebrow"><FileSpreadsheet size={14} /> Data summary</span>
        <h2>{summary.files ? `${summary.records} records ready` : 'Start with a connection or file'}</h2>
        <p>You do not need every source to begin. More linked datasets produce stronger alerts and higher confidence.</p>
        <div className="summary-stats"><div><strong>{summary.files}/5</strong><span>datasets</span></div><div><strong>{summary.records}</strong><span>records</span></div><div><strong>{alerts.length}</strong><span>alerts</span></div></div>
        {sampleStatuses.length > 0 && <div className="sample-status-list">
          {sampleStatuses.map((status) => <span key={status}><CheckCircle2 size={14} /> {status}</span>)}
        </div>}
        {sandboxError && <div className="issue-note"><AlertTriangle size={15} /><span>{sandboxError}</span></div>}
        {summary.issues > 0 && <div className="issue-note"><AlertTriangle size={15} /><span>{summary.issues} parsing issue{summary.issues === 1 ? '' : 's'} found. Valid rows can still be analysed.</span></div>}
        <div className="alert-preview">
          <span>Detected so far</span>
          {alerts.length ? alerts.slice(0, 4).map((alert) => <div key={alert.id}><i className={alert.severity} /><span>{alert.title}</span><strong>${alert.impact.toLocaleString('en-US')}</strong></div>) : <p>No alerts yet. Connect a source, load the sample workspace, or upload a CSV to begin.</p>}
        </div>
        <button className="secondary-button demo-data-button" onClick={loadDemoWorkspace}>Load sample CSV demo</button>
        <p className="demo-data-note">Use this for a reliable walkthrough when live integrations are not connected yet.</p>
        <button className="primary-button analyse-button" disabled={!summary.records} onClick={() => onApply(workspace, alerts, sampleStatuses.some((status) => status.includes('connected')) ? 'sandbox' : 'exports')}>Open overview</button>
        {summary.records > 0 && <button className="clear-import" onClick={() => { setWorkspace({}); setSampleStatuses([]); onClear?.() }}>Clear imported files</button>}
      </aside>
    </div>
  </section>
}
