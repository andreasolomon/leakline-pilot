import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AudioLines,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Gauge,
  Info,
  FileUp,
  LayoutDashboard,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  X,
} from 'lucide-react'
import { funnel, kpis, leaks, paymentEvents, periodMetrics, recoveryQueue, reps, sourceHealth, trendByPeriod, type Leak, type Metric, type Period } from './data'
import ImportPage from './ImportPage'
import IntegrationPage from './IntegrationPage'
import CallsPage from './CallsPage'
import { datasetConfig, generateImportLeaks, mergeIntegrationWorkspace, type ImportWorkspace } from './csvEngine'
import type { IntegrationSnapshot, ProviderStatus } from './integrationTypes'
import type { AuthUser } from './AuthGate'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const workspaceStorageKey = 'leakline-v1-workspace'
const resolvedRecoveryStorageKey = 'leakline-v1-resolved-recovery'
const reviewedLeaksStorageKey = 'leakline-v1-reviewed-leaks'
const dataEntryNav = 'Connect or Import Data'
const confirmedLossStatuses = new Set(['refunded', 'chargeback', 'charged back', 'written off', 'written_off', 'write-off'])
const atRiskPaymentStatuses = new Set(['failed', 'overdue', 'past due', 'past_due', 'unpaid'])

type PaymentState = 'Paid' | 'Confirmed lost' | 'At risk' | 'Pending'
type DemoStep = typeof dataEntryNav | 'Overview' | 'Revenue at risk' | 'Alerts' | 'Action page' | 'Closer health'

function paymentState(row: Record<string, unknown>): PaymentState {
  const status = String(row.status ?? '').trim().toLowerCase()
  if (confirmedLossStatuses.has(status)) return 'Confirmed lost'
  if (atRiskPaymentStatuses.has(status)) return 'At risk'
  if (status === 'paid' || status === 'succeeded' || status === 'successful') return 'Paid'
  if (typeof row.due_at === 'string' && !row.paid_at && Date.parse(row.due_at) < Date.now()) return 'At risk'
  return 'Pending'
}

function paymentEventLabel(status: unknown) {
  const value = String(status ?? '').trim().toLowerCase()
  const labels: Record<string, string> = {
    paid: 'Payment collected', succeeded: 'Payment collected', successful: 'Payment collected',
    refunded: 'Refund completed', chargeback: 'Chargeback lost', 'charged back': 'Chargeback lost',
    failed: 'Payment failed', overdue: 'Payment overdue', 'past due': 'Payment overdue', past_due: 'Payment overdue',
    unpaid: 'Payment unpaid', 'written off': 'Payment written off', written_off: 'Payment written off', 'write-off': 'Payment written off',
  }
  return labels[value] ?? (value ? value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase()) : 'Payment imported')
}

function paymentDate(row: Record<string, unknown>) {
  const value = row.paid_at ?? row.due_at
  if (typeof value !== 'string') return 'No date'
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 'No date' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(timestamp)
}

type FunnelStage = (typeof funnel)[number]

export function importedFunnel(workspace: ImportWorkspace): FunnelStage[] {
  if (!Object.keys(workspace).length) return funnel
  const leads = workspace.leads?.rows ?? []
  const appointments = workspace.appointments?.rows ?? []
  const deals = workspace.deals?.rows ?? []
  const attendedStatuses = new Set(['attended', 'showed', 'completed'])
  const qualifiedStatuses = new Set(['qualified', 'sales qualified', 'sales_qualified'])
  const wonStatuses = new Set(['won', 'closed won', 'closed_won'])
  const values = [
    leads.length,
    appointments.length,
    appointments.filter((row) => attendedStatuses.has(String(row.status ?? '').trim().toLowerCase())).length,
    deals.filter((row) => qualifiedStatuses.has(String(row.stage ?? '').trim().toLowerCase())).length,
    deals.filter((row) => wonStatuses.has(String(row.stage ?? '').trim().toLowerCase())).length,
  ]

  return funnel.map((stage, index) => ({
    ...stage,
    value: values[index],
    rate: index === 0 ? 100 : values[index - 1] ? Math.round(values[index] / values[index - 1] * 100) : 0,
  }))
}

type RevenueTrendPoint = { day: string; retained: number; leaked: number; lost: number }
type CloserHealthRow = { name: string; initials: string; calls: number; closeRate: number; collected: number; retained?: number; trend?: number; color: string }
type RecoveryItem = { prospect: string; value: number; reason: string; inactive: number; owner: string; priority: string }
type AppProps = { user: AuthUser; onLogout: () => void }

const textValue = (value: unknown) => String(value ?? '').trim().toLowerCase()
const numberValue = (value: unknown) => typeof value === 'number' ? value : 0
const daysSince = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000)) : 0

export function importedRevenueTrend(workspace: ImportWorkspace, period: Period): RevenueTrendPoint[] {
  if (!Object.keys(workspace).length) return trendByPeriod[period]
  const payments = workspace.payments?.rows ?? []
  const byDate = new Map<string, typeof payments>()
  payments.forEach((row) => {
    const value = row.paid_at ?? row.due_at
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return
    const date = new Date(value).toISOString().slice(0, 10)
    byDate.set(date, [...(byDate.get(date) ?? []), row])
  })
  let collected = 0
  let atRisk = 0
  let lost = 0
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    rows.forEach((row) => {
      const state = paymentState(row)
      if (state === 'Paid') collected += numberValue(row.amount)
      if (state === 'At risk') atRisk += numberValue(row.amount)
      if (state === 'Confirmed lost') lost += numberValue(row.amount)
    })
    return {
      day: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(Date.parse(date)),
      retained: Math.max(0, collected - lost) / 1000,
      leaked: atRisk / 1000,
      lost: lost / 1000,
    }
  })
}

export function importedCloserHealth(workspace: ImportWorkspace): CloserHealthRow[] {
  if (!Object.keys(workspace).length) return reps
  const closers = workspace.closers?.rows ?? []
  const deals = workspace.deals?.rows ?? []
  const payments = workspace.payments?.rows ?? []
  const dealOwner = new Map(deals.map((deal) => [textValue(deal.id), textValue(deal.owner)]))
  const palette = ['#4e6f62', '#756248', '#6c625a', '#696d4e', '#765451']

  return closers.filter((closer) => closer.active !== false).map((closer, index) => {
    const name = String(closer.name ?? 'Unknown closer')
    const owner = textValue(name)
    const ownerPayments = payments.filter((payment) => dealOwner.get(textValue(payment.deal_id)) === owner)
    const collected = ownerPayments.filter((payment) => paymentState(payment) === 'Paid').reduce((sum, payment) => sum + numberValue(payment.amount), 0)
    const lost = ownerPayments.filter((payment) => paymentState(payment) === 'Confirmed lost').reduce((sum, payment) => sum + numberValue(payment.amount), 0)
    const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
    return {
      name,
      initials,
      calls: numberValue(closer.calls),
      closeRate: numberValue(closer.close_rate),
      collected,
      retained: collected ? Math.max(0, Math.round((collected - lost) / collected * 100)) : undefined,
      color: palette[index % palette.length],
    }
  })
}

export function importedRecoveryQueue(workspace: ImportWorkspace): RecoveryItem[] {
  if (!Object.keys(workspace).length) return recoveryQueue
  const deals = workspace.deals?.rows ?? []
  const payments = workspace.payments?.rows ?? []
  const dealById = new Map(deals.map((deal) => [textValue(deal.id), deal]))
  const atRiskPayments = payments.filter((payment) => paymentState(payment) === 'At risk')
  const atRiskDealIds = new Set(atRiskPayments.map((payment) => textValue(payment.deal_id)).filter(Boolean))
  const paymentItems: RecoveryItem[] = atRiskPayments.map((payment) => {
    const deal = dealById.get(textValue(payment.deal_id))
    return {
      prospect: String(payment.customer ?? deal?.name ?? 'Unknown customer'),
      value: numberValue(payment.amount),
      reason: paymentEventLabel(payment.status),
      inactive: daysSince(payment.due_at),
      owner: String(deal?.owner ?? 'Unassigned'),
      priority: 'High',
    }
  })
  const dealItems: RecoveryItem[] = deals.filter((deal) => {
    const stage = textValue(deal.stage)
    return !['won', 'closed won', 'closed_won', 'lost', 'closed lost', 'closed_lost'].includes(stage)
      && !deal.next_action && daysSince(deal.updated_at) >= 3 && !atRiskDealIds.has(textValue(deal.id))
  }).map((deal) => ({
    prospect: String(deal.name ?? 'Unnamed opportunity'),
    value: numberValue(deal.value),
    reason: 'No next action',
    inactive: daysSince(deal.updated_at),
    owner: String(deal.owner ?? 'Unassigned'),
    priority: numberValue(deal.value) >= 10000 ? 'High' : 'Medium',
  }))
  return [...paymentItems, ...dealItems].sort((a, b) => b.value - a.value)
}

export function recoveryItemKey(item: RecoveryItem) {
  return `${item.prospect}|${item.reason}|${item.value}`
}

export function sectionForLeakAction(action: string) {
  const routes: Record<string, string> = {
    'View team': 'Team',
    'Review deals': 'Recovery',
    'Review payments': 'Payments',
    'Inspect appointments': 'Funnel',
    'Review leads': 'Leak feed',
    'Review unbooked leads': 'Leak feed',
  }
  return routes[action] ?? 'Leak feed'
}

export function importedFinancialSummary(workspace: ImportWorkspace) {
  const payments = workspace.payments?.rows ?? []
  const confirmedLossPayments = payments.filter((row) => paymentState(row) === 'Confirmed lost')
  const confirmedLost = confirmedLossPayments.reduce((sum, row) => sum + numberValue(row.amount), 0)
  const collectedPayments = payments.filter((row) => paymentState(row) === 'Paid')
  const cashCollected = collectedPayments.reduce((sum, row) => sum + numberValue(row.amount), 0)
  const netRetained = Math.max(0, cashCollected - confirmedLost)
  const appointments = workspace.appointments?.rows ?? []
  const attendedStatuses = new Set(['attended', 'showed', 'completed'])
  const attended = appointments.filter((row) => attendedStatuses.has(textValue(row.status))).length
  return {
    confirmedLossPayments: confirmedLossPayments.length,
    confirmedLost,
    cashCollected,
    netRetained,
    retainedShare: cashCollected ? Math.round(netRetained / cashCollected * 100) : 0,
    appointments: appointments.length,
    attended,
    showRate: appointments.length ? Math.round(attended / appointments.length * 100) : 0,
  }
}

export function filterImportedWorkspace(workspace: ImportWorkspace, period: Period): ImportWorkspace {
  if (!Object.keys(workspace).length) return workspace
  const dateFields: Record<string, string[]> = {
    leads: ['created_at'], appointments: ['start_at'], deals: ['updated_at'], payments: ['paid_at', 'due_at'], closers: [],
  }
  const timestamps = Object.entries(workspace).flatMap(([kind, item]) => (item?.rows ?? []).flatMap((row) =>
    (dateFields[kind] ?? []).map((field) => row[field]).filter((value): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))).map(Date.parse),
  ))
  if (!timestamps.length) return workspace
  const anchor = new Date(Math.max(...timestamps))
  const start = new Date(anchor)
  if (period === '7 days') start.setUTCDate(start.getUTCDate() - 6)
  else if (period === 'This month') start.setUTCDate(1)
  else { start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3); start.setUTCDate(1) }
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(anchor)
  end.setUTCHours(23, 59, 59, 999)

  return Object.fromEntries(Object.entries(workspace).map(([kind, item]) => {
    if (!item || !(dateFields[kind]?.length)) return [kind, item]
    const rows = item.rows.filter((row) => {
      const timestamp = dateFields[kind].map((field) => row[field]).find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      return typeof timestamp !== 'string' || (Date.parse(timestamp) >= start.getTime() && Date.parse(timestamp) <= end.getTime())
    })
    return [kind, { ...item, rows }]
  })) as ImportWorkspace
}

type DataHealthItem = { source: string; status: string; detail: string; records: string }

export function importedDataHealth(workspace: ImportWorkspace): DataHealthItem[] {
  if (!Object.keys(workspace).length) return sourceHealth
  return (Object.keys(datasetConfig) as Array<keyof typeof datasetConfig>).map((kind) => {
    const item = workspace[kind]
    if (!item) return { source: datasetConfig[kind].label, status: 'Missing', detail: 'No CSV imported', records: '0 records' }
    const status = item.issues.length || !item.rows.length ? 'Review' : 'Healthy'
    const detail = item.issues.length ? `${item.issues.length} validation issue${item.issues.length === 1 ? '' : 's'}` : `${item.mappedFields.length} fields mapped`
    return { source: datasetConfig[kind].label, status, detail, records: `${item.rows.length} records · ${item.fileName}` }
  })
}

type DataConfidence = {
  connectedSources: string[]
  missingSources: string[]
  freshness: string
  level: 'High' | 'Medium' | 'Low'
  note: string
}

function freshnessLabel(timestamp?: string) {
  if (!timestamp) return null
  const diff = Math.max(0, Date.now() - Date.parse(timestamp))
  const minutes = Math.max(1, Math.round(diff / 60000))
  if (minutes < 60) return `Synced ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Synced ${hours} hr ago`
  return `Synced ${Math.round(hours / 24)} day${hours >= 48 ? 's' : ''} ago`
}

export function dataSourceConfidence(workspace: ImportWorkspace, statuses: ProviderStatus[], callCount = 0): DataConfidence {
  const statusById = new Map(statuses.map((status) => [status.id, status]))
  const connected = (id: ProviderStatus['id']) => statusById.get(id)?.connected === true
  const has = (kind: keyof ImportWorkspace) => Boolean(workspace[kind]?.rows.length)
  const connectedSources: string[] = []
  const missingSources: string[] = []

  const crmConnected = connected('highlevel') || has('leads') || has('deals')
  const calendarConnected = connected('google-calendar') || has('appointments')
  const paymentConnected = connected('stripe') || has('payments')
  const callsConnected = connected('fathom') || callCount > 0
  const teamConnected = has('closers')

  if (crmConnected) connectedSources.push(statusById.get('highlevel')?.label ?? 'CRM exports')
  else missingSources.push('CRM')
  if (paymentConnected) connectedSources.push(statusById.get('stripe')?.label ?? 'Payment exports')
  else missingSources.push('Payments')
  if (calendarConnected) connectedSources.push(statusById.get('google-calendar')?.label ?? 'Calendar exports')
  else missingSources.push('Calendar')
  if (callsConnected) connectedSources.push(statusById.get('fathom')?.label ?? 'Call recordings')
  else missingSources.push('Call recordings')
  if (teamConnected) connectedSources.push('Closer scorecard')
  else missingSources.push('Closer scorecard')

  const latestSync = statuses
    .filter((status) => status.connected && status.lastSyncAt)
    .map((status) => status.lastSyncAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  const hasSandbox = statuses.some((status) => status.connected && status.mode === 'sandbox')
  const freshness = freshnessLabel(latestSync)
    ?? (hasSandbox ? 'Sample data loaded' : Object.keys(workspace).length ? 'Export data loaded' : 'No current data')
  const score = [crmConnected, calendarConnected, paymentConnected, callsConnected, teamConnected].filter(Boolean).length
  const level: DataConfidence['level'] = crmConnected && calendarConnected && paymentConnected && score >= 4 ? 'High' : score >= 3 ? 'Medium' : 'Low'
  const note = level === 'High'
    ? 'Strong enough for a confident walkthrough.'
    : level === 'Medium'
      ? 'Usable for diagnosis, with any missing source called out.'
      : 'Early signal only. Add CRM, calendar and payment data before trusting totals.'

  return { connectedSources, missingSources, freshness, level, note }
}

type SearchItem = { key: string; label: string; meta: string; section: string; leakId?: number }

export function importedSearchItems(workspace: ImportWorkspace, alerts: Leak[]): SearchItem[] {
  const items: SearchItem[] = alerts.map((leak) => ({ key: `leak-${leak.id}`, label: leak.title, meta: `${leak.type} leak · ${money.format(leak.impact)}`, section: 'Leak feed', leakId: leak.id }))
  workspace.leads?.rows.forEach((row, index) => items.push({ key: `lead-${row.id ?? index}`, label: String(row.name ?? row.email ?? 'Unnamed lead'), meta: `Lead · ${row.email ?? row.source ?? 'Imported'}`, section: 'Leak feed' }))
  workspace.deals?.rows.forEach((row, index) => items.push({ key: `deal-${row.id ?? index}`, label: String(row.name ?? 'Unnamed deal'), meta: `Deal · ${money.format(numberValue(row.value))}`, section: 'Recovery' }))
  workspace.closers?.rows.forEach((row, index) => items.push({ key: `closer-${row.id ?? index}`, label: String(row.name ?? 'Unnamed closer'), meta: `Closer · ${numberValue(row.close_rate)}% close rate`, section: 'Team' }))
  workspace.payments?.rows.forEach((row, index) => items.push({ key: `payment-${row.id ?? index}`, label: String(row.customer ?? 'Unknown customer'), meta: `${paymentEventLabel(row.status)} · ${money.format(numberValue(row.amount))}`, section: 'Payments' }))
  return items
}

function readSavedWorkspace(): ImportWorkspace {
  try { return JSON.parse(localStorage.getItem(workspaceStorageKey) ?? '{}') as ImportWorkspace }
  catch { return {} }
}

function saveWorkspace(workspace: ImportWorkspace) {
  try {
    const compact = Object.fromEntries(Object.entries(workspace).map(([kind, item]) => [kind, { ...item, sourceText: undefined }]))
    localStorage.setItem(workspaceStorageKey, JSON.stringify(compact))
  } catch { /* Storage can be unavailable in private browsing. */ }
}

function clearSavedWorkspace() {
  try { localStorage.removeItem(workspaceStorageKey) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function readSavedResolvedRecovery() {
  try { return new Set<string>(JSON.parse(localStorage.getItem(resolvedRecoveryStorageKey) ?? '[]')) }
  catch { return new Set<string>() }
}

function saveResolvedRecovery(items: Set<string>) {
  try { localStorage.setItem(resolvedRecoveryStorageKey, JSON.stringify([...items])) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function clearResolvedRecovery() {
  try { localStorage.removeItem(resolvedRecoveryStorageKey) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function readSavedReviewedLeaks() {
  try { return new Set<number>(JSON.parse(localStorage.getItem(reviewedLeaksStorageKey) ?? '[]')) }
  catch { return new Set<number>() }
}

function saveReviewedLeaks(items: Set<number>) {
  try { localStorage.setItem(reviewedLeaksStorageKey, JSON.stringify([...items])) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function clearReviewedLeaks() {
  try { localStorage.removeItem(reviewedLeaksStorageKey) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function TrendChart({ data }: { data: { day: string; retained: number; leaked: number; lost: number }[] }) {
  if (!data.length) return <div className="empty-alerts"><CircleDollarSign size={24} /><h3>No payment movement available</h3><p>Import Payments data to populate this chart.</p></div>
  const max = Math.max(1, Math.ceil(Math.max(...data.flatMap((item) => [item.retained, item.leaked, item.lost])) / 5) * 5)
  const width = 640
  const height = 180
  const pad = 18
  const points = data.map((item, index) => ({
    x: pad + index * ((width - pad * 2) / Math.max(data.length - 1, 1)),
    y: height - pad - (item.retained / max) * (height - pad * 2),
  }))
  const leakPoints = data.map((item, index) => ({
    x: pad + index * ((width - pad * 2) / Math.max(data.length - 1, 1)),
    y: height - pad - (item.leaked / max) * (height - pad * 2),
  }))
  const lostPoints = data.map((item, index) => ({
    x: pad + index * ((width - pad * 2) / Math.max(data.length - 1, 1)),
    y: height - pad - (item.lost / max) * (height - pad * 2),
  }))
  const line = (items: { x: number; y: number }[]) => items.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
  const area = `${line(points)} L ${points.at(-1)?.x} ${height - pad} L ${points[0].x} ${height - pad} Z`

  return (
    <div className="chart-wrap">
      <span className="chart-unit">Revenue ($k)</span>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Retained revenue and estimated revenue at risk in thousands of dollars">
        {[0, Math.round(max / 2), max].map((value) => {
          const y = height - pad - (value / max) * (height - pad * 2)
          return <g key={value}><line x1={pad} x2={width - pad} y1={y} y2={y} className="chart-grid" /><text x={pad + 3} y={y - 5} className="chart-axis-label">{`$${value}k`}</text></g>
        })}
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#239675" stopOpacity=".22" />
            <stop offset="100%" stopColor="#239675" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#areaFill)" />
        <path d={line(points)} className="chart-line retained" />
        <path d={line(leakPoints)} className="chart-line leaked" />
        <path d={line(lostPoints)} className="chart-line lost" />
        {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="3.5" className="chart-point" />)}
      </svg>
      <div className="chart-labels">{data.map((item) => <span key={item.day}>{item.day}</span>)}</div>
    </div>
  )
}

function LeakRow({ leak, onOpen, reviewed = false }: { leak: Leak; onOpen: (leak: Leak) => void; reviewed?: boolean }) {
  return (
    <button className={`leak-row ${reviewed ? 'reviewed' : ''}`} onClick={() => onOpen(leak)}>
      <span className={`severity-dot ${leak.severity}`} />
      <span className="leak-copy">
        <span className="leak-type">{leak.type} · {leak.count} record{leak.count === 1 ? '' : 's'} {reviewed && <em>Reviewed</em>}</span>
        <strong>{leak.title}</strong>
        <span>{leak.description}</span>
      </span>
      <span className="leak-impact">
        <small>Est. impact</small>
        <strong>{money.format(leak.impact)}</strong>
        <ArrowRight size={17} />
      </span>
    </button>
  )
}

function PaymentLedger({ workspace }: { workspace: ImportWorkspace }) {
  const hasImportedWorkspace = Object.keys(workspace).length > 0
  const importedPayments = workspace.payments?.rows
  const rows = importedPayments?.map((row, index) => ({
    key: String(row.id ?? `${row.customer ?? 'payment'}-${index}`),
    customer: String(row.customer ?? 'Unknown customer'),
    event: paymentEventLabel(row.status),
    amount: typeof row.amount === 'number' ? row.amount : 0,
    date: paymentDate(row),
    state: paymentState(row),
  })) ?? (!hasImportedWorkspace ? paymentEvents.map((event, index) => ({ ...event, key: `${event.customer}-${index}`, state: event.status as PaymentState })) : [])
  const confirmedLost = rows.filter((row) => row.state === 'Confirmed lost').reduce((sum, row) => sum + row.amount, 0)
  const atRisk = rows.filter((row) => row.state === 'At risk').reduce((sum, row) => sum + row.amount, 0)

  return <article className="panel full-panel">
    <div className="panel-head">
      <div><span className="eyebrow">{importedPayments ? `${rows.length} imported records` : 'Financial events'}</span><h2>Payment ledger</h2></div>
      <div className="ledger-totals"><span className="confirmed-total">{money.format(confirmedLost)} confirmed lost</span><span className="risk-total">{money.format(atRisk)} at risk</span></div>
    </div>
    {rows.length ? <div className="ledger-table">{rows.map((event) => <div key={event.key}>
      <span className={`ledger-status ${event.state === 'Confirmed lost' ? 'lost' : event.state === 'At risk' ? 'risk' : event.state.toLowerCase()}`} />
      <section><strong>{event.customer}</strong><small>{event.event}</small></section>
      <span>{event.date}</span><b>{money.format(event.amount)}</b><em>{event.state}</em>
    </div>)}</div> : <div className="empty-alerts"><FileUp size={24} /><h3>No payment data imported</h3><p>Add a Payments CSV to populate this ledger.</p></div>}
  </article>
}

function CloserHealthTable({ rows }: { rows: CloserHealthRow[] }) {
  if (!rows.length) return <div className="empty-alerts"><Users size={24} /><h3>No closer data imported</h3><p>Add a Closers CSV to populate this table.</p></div>
  return <div className="table-scroll"><table>
    <thead><tr><th>Closer</th><th>Calls</th><th>Close rate</th><th>Cash collected</th><th>Retained</th><th>Trend</th></tr></thead>
    <tbody>{rows.map((rep) => <tr key={rep.name}>
      <td><span className="avatar" style={{ background: rep.color }}>{rep.initials}</span><strong>{rep.name}</strong></td>
      <td>{rep.calls}</td><td>{rep.closeRate}%</td><td>{money.format(rep.collected)}</td><td>{rep.retained === undefined ? '—' : `${rep.retained}%`}</td>
      <td>{rep.trend === undefined ? <span className="no-comparison">No comparison</span> : <span className={rep.trend > 0 ? 'trend-up' : 'trend-down'}>{rep.trend > 0 ? '+' : ''}{rep.trend}%</span>}</td>
    </tr>)}</tbody>
  </table></div>
}

function SectionPage({ section, onOpenLeak, alertData = leaks, workspace = {}, funnelData = funnel, closerData = reps, recoveryData = recoveryQueue, healthData = sourceHealth, onResolveRecovery, reviewedLeaks = new Set<number>() }: { section: string; onOpenLeak: (leak: Leak) => void; alertData?: Leak[]; workspace?: ImportWorkspace; funnelData?: FunnelStage[]; closerData?: CloserHealthRow[]; recoveryData?: RecoveryItem[]; healthData?: DataHealthItem[]; onResolveRecovery?: (item: RecoveryItem) => void; reviewedLeaks?: Set<number> }) {
  const copy: Record<string, [string, string]> = {
    'Leak feed': ['Leak feed', 'Every open revenue signal, ordered by estimated financial impact.'],
    Funnel: ['Funnel intelligence', 'See where prospects move forward—and where momentum breaks.'],
    Recovery: ['Recovery queue', 'Prioritised opportunities and payments that can still be recovered.'],
    Team: ['Closer performance', 'Compare outcomes while keeping lead mix and sample size visible.'],
    Payments: ['Revenue ledger', 'A clear audit trail of confirmed losses and revenue still at risk.'],
    'Data health': ['Data health', 'Trust starts with complete, recent and correctly matched source data.'],
    Settings: ['Workspace settings', 'Control reporting windows, thresholds and alert ownership.'],
  }
  const [title, subtitle] = copy[section] ?? [section, 'Workspace view']
  return <section className="section-page">
    <div className="page-heading section-heading"><div><p>Workspace</p><h1>{title}</h1><span>{subtitle}</span></div></div>
    {section === 'Leak feed' && <article className="panel full-panel"><div className="panel-head"><div><span className="eyebrow">{alertData.length} active signals</span><h2>Prioritised by impact</h2></div><span className="live-pill"><i /> {Object.keys(workspace).length ? 'Imported' : 'Live'}</span></div>{alertData.length ? <div className="leak-list">{alertData.map((leak) => <LeakRow key={leak.id} leak={leak} onOpen={onOpenLeak} reviewed={reviewedLeaks.has(leak.id)} />)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>No leaks detected</h3><p>The imported records passed the current Version 1 checks.</p></div>}</article>}
    {section === 'Funnel' && <div className="section-grid"><article className="panel"><div className="panel-head"><div><span className="eyebrow">{Object.keys(workspace).length ? 'Imported data' : 'This month'}</span><h2>Stage conversion</h2></div></div><div className="funnel-list">{funnelData.map((stage, index) => <div className="funnel-row" key={stage.label}><div><span>{stage.label}</span><strong>{stage.value}</strong></div><div className="funnel-track"><i style={{ width: `${stage.value / Math.max(funnelData[0].value, 1) * 100}%`, background: stage.color }} /></div><small>{index ? `${stage.rate}%` : '—'}</small></div>)}</div></article><article className="panel"><div className="panel-head"><div><span className="eyebrow">Campaign quality</span><h2>Attendance comparison</h2></div></div><div className="breakdown-table">{leaks.find((leak) => leak.type === 'Attendance')?.breakdown?.map((row) => <div key={row.label}><strong>{row.label}</strong><span>{row.current}</span><small className={row.signal.startsWith('+') ? 'positive' : 'negative'}>{row.signal}</small></div>)}</div></article></div>}
    {section === 'Recovery' && <article className="panel full-panel"><div className="panel-head"><div><span className="eyebrow">{money.format(recoveryData.reduce((sum, item) => sum + item.value, 0))} recoverable</span><h2>Open opportunities and payments</h2></div></div>{recoveryData.length ? <div className="recovery-board">{recoveryData.map((item) => <div key={recoveryItemKey(item)}><span className={`priority ${item.priority.toLowerCase()}`} /><section><strong>{item.prospect}</strong><small>{item.reason} · {item.inactive} days inactive</small><em>Owner: {item.owner}</em></section><b>{money.format(item.value)}</b><button className="resolve-button" onClick={() => onResolveRecovery?.(item)}><CheckCircle2 size={14} /><span>Resolve</span></button></div>)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>Nothing currently needs recovery</h3><p>No stale deals or at-risk payments were found.</p></div>}</article>}
    {section === 'Team' && <article className="panel full-panel"><div className="panel-head"><div><span className="eyebrow">{Object.keys(workspace).length ? 'Imported closer snapshot' : 'Comparable lead cohorts'}</span><h2>Closer health</h2></div></div><CloserHealthTable rows={closerData} /></article>}
    {section === 'Payments' && <PaymentLedger workspace={workspace} />}
    {section === 'Data health' && <div className="health-grid">{healthData.map((source) => <article className="panel" key={source.source}>{source.status === 'Healthy' ? <CheckCircle2 size={20} className="healthy-icon" /> : <AlertTriangle size={20} className="review-icon" />}<div><span className="eyebrow">{source.status}</span><h2>{source.source}</h2><p>{source.detail}</p><small>{source.records}</small></div></article>)}</div>}
    {section === 'Settings' && <article className="panel settings-panel"><div><span className="eyebrow">Reporting</span><h2>Revenue maturity window</h2><p>Wait 14 days before treating retained-revenue results as mature.</p></div><button>14 days <ChevronDown size={14} /></button><div><span className="eyebrow">Alerts</span><h2>Minimum sample size</h2><p>Only compare closer performance after 10 qualified calls.</p></div><button>10 calls <ChevronDown size={14} /></button></article>}
  </section>
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase()
}

export default function App({ user, onLogout }: AppProps) {
  const [activeNav, setActiveNav] = useState('Overview')
  const [period, setPeriod] = useState<Period>('This month')
  const [selectedLeak, setSelectedLeak] = useState<Leak | null>(null)
  const [selectedMetric, setSelectedMetric] = useState<Metric | null>(null)
  const [showChartInfo, setShowChartInfo] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [leakFilter, setLeakFilter] = useState<'All' | Leak['severity']>('All')
  const [importedWorkspace, setImportedWorkspace] = useState<ImportWorkspace>(readSavedWorkspace)
  const [resolvedRecovery, setResolvedRecovery] = useState<Set<string>>(readSavedResolvedRecovery)
  const [reviewedLeaks, setReviewedLeaks] = useState<Set<number>>(readSavedReviewedLeaks)
  const [integrationStatuses, setIntegrationStatuses] = useState<ProviderStatus[]>([])
  const [syncedCalls, setSyncedCalls] = useState(0)

  const hasImportedData = Object.keys(importedWorkspace).length > 0
  const periodWorkspace = useMemo(() => filterImportedWorkspace(importedWorkspace, period), [importedWorkspace, period])
  const importedLeaks = useMemo(() => generateImportLeaks(periodWorkspace), [periodWorkspace])
  const activeLeaks = hasImportedData ? importedLeaks : leaks
  const searchItems = useMemo(() => importedSearchItems(periodWorkspace, activeLeaks), [periodWorkspace, activeLeaks])
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return (query ? searchItems.filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query)) : searchItems.filter((item) => item.leakId !== undefined)).slice(0, 8)
  }, [searchItems, searchQuery])
  const unreadAlerts = activeLeaks.filter((leak) => !reviewedLeaks.has(leak.id))

  const visibleLeaks = useMemo(
    () => leakFilter === 'All' ? activeLeaks : activeLeaks.filter((leak) => leak.severity === leakFilter),
    [activeLeaks, leakFilter],
  )

  const currentMetrics = useMemo<Metric[]>(() => {
    const view = periodMetrics[period]
    return kpis.map((metric) => {
      if (metric.label === 'Net retained') return { ...metric, value: view.retained, calculation: `${view.retained} retained during ${view.rangeLabel}` }
      if (metric.label === 'Confirmed lost') return { ...metric, value: view.confirmedLost, calculation: `${view.confirmedLost} confirmed lost during ${view.rangeLabel}` }
      if (metric.label === 'Revenue at risk') return { ...metric, value: view.leakage, detail: `${view.leakageShare} of collected cash`, calculation: `${view.leakage} estimated across open signals` }
      if (metric.label === 'Show rate') return { ...metric, value: view.showRate, detail: view.showDetail, calculation: `${view.showDetail} = ${view.showRate}` }
      return metric
    })
  }, [period])

  const displayFunnel = useMemo(() => importedFunnel(periodWorkspace), [periodWorkspace])
  const displayRevenueTrend = useMemo(() => importedRevenueTrend(periodWorkspace, period), [periodWorkspace, period])
  const displayClosers = useMemo(() => importedCloserHealth(periodWorkspace), [periodWorkspace])
  const rawRecovery = useMemo(() => importedRecoveryQueue(periodWorkspace), [periodWorkspace])
  const displayRecovery = useMemo(() => rawRecovery.filter((item) => !resolvedRecovery.has(recoveryItemKey(item))), [rawRecovery, resolvedRecovery])
  const displayHealth = useMemo(() => importedDataHealth(importedWorkspace), [importedWorkspace])
  const sourceConfidence = useMemo(() => dataSourceConfidence(importedWorkspace, integrationStatuses, syncedCalls), [importedWorkspace, integrationStatuses, syncedCalls])
  const largestFunnelDrop = useMemo(() => displayFunnel.slice(1).map((stage, index) => ({
    label: `${displayFunnel[index].label} → ${stage.label.toLowerCase()}`,
    records: Math.max(0, displayFunnel[index].value - stage.value),
  })).sort((a, b) => b.records - a.records)[0], [displayFunnel])

  const displayMetrics = useMemo(() => {
    const summary = importedFinancialSummary(periodWorkspace)

    return currentMetrics.map((metric) => {
      if (metric.label === 'Net retained' && hasImportedData) return {
        ...metric,
        value: money.format(summary.netRetained),
        change: undefined,
        detail: `${summary.retainedShare}% of collected cash`,
        calculation: `${money.format(summary.cashCollected)} collected − ${money.format(summary.confirmedLost)} confirmed lost = ${money.format(summary.netRetained)}`,
      }
      if (metric.label === 'Confirmed lost' && hasImportedData) return {
        ...metric,
        value: money.format(summary.confirmedLost),
        change: undefined,
        detail: `${summary.confirmedLossPayments} confirmed loss record${summary.confirmedLossPayments === 1 ? '' : 's'}`,
        calculation: `${money.format(summary.confirmedLost)} from refunds, chargebacks and write-offs`,
      }
      if (metric.label === 'Revenue at risk' && hasImportedData) return {
        ...metric,
        value: money.format(importedLeaks.reduce((sum, leak) => sum + leak.impact, 0)),
        change: undefined,
        detail: `${importedLeaks.length} imported alert${importedLeaks.length === 1 ? '' : 's'}`,
        calculation: importedLeaks.length ? importedLeaks.map((leak) => money.format(leak.impact)).join(' + ') : 'No current alerts',
      }
      if (metric.label === 'Show rate' && hasImportedData) return {
        ...metric,
        value: `${summary.showRate}%`,
        change: undefined,
        detail: `${summary.attended} of ${summary.appointments} bookings`,
        calculation: `${summary.attended} attended ÷ ${summary.appointments} booked × 100 = ${summary.showRate}%`,
      }
      return metric
    })
  }, [currentMetrics, hasImportedData, importedLeaks, periodWorkspace])
  const primaryLeak = activeLeaks.find((leak) => leak.type === 'Collection')
    ?? activeLeaks.find((leak) => leak.type === 'Follow-up')
    ?? activeLeaks[0]
  const revenueAtRiskMetric = displayMetrics.find((metric) => metric.label === 'Revenue at risk')

  const navItems = [
    { label: 'Overview', icon: LayoutDashboard },
    { label: 'Leak feed', icon: AlertTriangle, badge: activeLeaks.length },
    { label: 'Funnel', icon: Activity },
    { label: 'Recovery', icon: Target, badge: displayRecovery.length },
    { label: 'Team', icon: Users },
    { label: dataEntryNav, icon: FileUp },
  ]

  const resolveRecovery = (item: RecoveryItem) => setResolvedRecovery((current) => {
    const next = new Set(current).add(recoveryItemKey(item))
    saveResolvedRecovery(next)
    return next
  })

  const markLeakReviewed = (leak: Leak) => {
    setReviewedLeaks((current) => {
      const next = new Set(current).add(leak.id)
      saveReviewedLeaks(next)
      return next
    })
    setSelectedLeak(null)
  }

  const followLeakAction = (leak: Leak) => {
    if (leak.relatedRecords?.length) {
      window.setTimeout(() => document.querySelector('#related-records-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
      return
    }
    setActiveNav(sectionForLeakAction(leak.action))
    setSelectedLeak(null)
  }

  const openSearchItem = (item: SearchItem) => {
    if (item.leakId !== undefined) {
      const leak = activeLeaks.find((candidate) => candidate.id === item.leakId)
      if (leak) setSelectedLeak(leak)
    } else setActiveNav(item.section)
    setSearchOpen(false)
    setSearchQuery('')
  }

  const markAllAlertsReviewed = () => {
    const next = new Set([...reviewedLeaks, ...activeLeaks.map((leak) => leak.id)])
    saveReviewedLeaks(next)
    setReviewedLeaks(next)
  }

  const runDemoStep = (step: DemoStep) => {
    setNotificationsOpen(false)
    setSearchOpen(false)
    setPeriodMenuOpen(false)
    if (step === dataEntryNav) setActiveNav(dataEntryNav)
    if (step === 'Overview') setActiveNav('Overview')
    if (step === 'Revenue at risk') {
      setActiveNav('Overview')
      if (revenueAtRiskMetric) setSelectedMetric(revenueAtRiskMetric)
    }
    if (step === 'Alerts') {
      setActiveNav('Overview')
      if (primaryLeak) setSelectedLeak(primaryLeak)
    }
    if (step === 'Action page') setActiveNav(primaryLeak ? sectionForLeakAction(primaryLeak.action) : 'Recovery')
    if (step === 'Closer health') setActiveNav('Team')
  }

  const demoSteps: { step: DemoStep; label: string; detail: string; ready: boolean }[] = [
    { step: dataEntryNav, label: 'Connect/import data', detail: hasImportedData ? 'Current funnel loaded' : 'Connect, import or preview current funnel data', ready: hasImportedData },
    { step: 'Overview', label: 'Overview', detail: hasImportedData ? `${Object.values(importedWorkspace).reduce((sum, item) => sum + item.rows.length, 0)} records analysed` : 'Find leaks before scaling spend', ready: true },
    { step: 'Revenue at risk', label: 'Revenue at risk', detail: revenueAtRiskMetric?.value ?? 'Open risk total', ready: Boolean(revenueAtRiskMetric) },
    { step: 'Alerts', label: 'Alerts', detail: primaryLeak ? primaryLeak.title : 'No active alert', ready: Boolean(primaryLeak) },
    { step: 'Action page', label: 'Action page', detail: primaryLeak ? primaryLeak.action : 'Recovery queue', ready: Boolean(primaryLeak) },
    { step: 'Closer health', label: 'Closer health', detail: `${displayClosers.length} closer${displayClosers.length === 1 ? '' : 's'} visible`, ready: displayClosers.length > 0 },
  ]

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
        setNotificationsOpen(false)
        setPeriodMenuOpen(false)
      }
      if (event.key === 'Escape') {
        setSearchOpen(false)
        setNotificationsOpen(false)
        setPeriodMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('integration')) {
      setActiveNav('Integrations')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  useEffect(() => {
    let active = true
    const refreshLiveWorkspace = async () => {
      try {
        const response = await fetch('/api/integrations')
        if (!response.ok) return
        const body = await response.json() as IntegrationSnapshot
        if (!active || !body.workspace) return
        setIntegrationStatuses(body.statuses ?? [])
        setSyncedCalls(body.calls?.length ?? 0)
        setImportedWorkspace((current) => {
          const next = mergeIntegrationWorkspace(current, body.workspace ?? {})
          if (JSON.stringify(next) === JSON.stringify(current)) return current
          saveWorkspace(next)
          return next
        })
      } catch { /* CSV mode continues to work when the integration service is unavailable. */ }
    }
    void refreshLiveWorkspace()
    const timer = window.setInterval(refreshLiveWorkspace, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const applyIntegratedWorkspace = (workspace: ImportWorkspace) => {
    saveWorkspace(workspace)
    clearResolvedRecovery()
    clearReviewedLeaks()
    setImportedWorkspace(workspace)
    setResolvedRecovery(new Set())
    setReviewedLeaks(new Set())
  }

  const applyIntegrationSnapshot = (snapshot: IntegrationSnapshot) => {
    setIntegrationStatuses(snapshot.statuses ?? [])
    setSyncedCalls(snapshot.calls?.length ?? 0)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><span>LEAKLINE</span></div>
        <button className="close-nav" onClick={() => setMobileNav(false)}><X size={20} /></button>
        <div className="workspace-card">
          <span className="workspace-logo">A</span>
          <span><strong>Ascend Growth</strong><small>Partners · High-ticket funnel</small></span>
          <ChevronDown size={16} />
        </div>
        <nav>
          <p>Workspace</p>
          {navItems.map(({ label, icon: Icon, badge }) => (
            <button key={label} className={activeNav === label ? 'active' : ''} onClick={() => { setActiveNav(label); setMobileNav(false) }}>
              <Icon size={18} /><span>{label}</span>{badge && <em>{badge}</em>}
            </button>
          ))}
          <p>Manage</p>
          <button className={activeNav === dataEntryNav || activeNav === 'Integrations' ? 'active' : ''} onClick={() => setActiveNav(dataEntryNav)}><Gauge size={18} /><span>Data sources</span></button>
          <button className={activeNav === 'Calls' ? 'active' : ''} onClick={() => setActiveNav('Calls')}><AudioLines size={18} /><span>Calls</span></button>
          <button className={activeNav === 'Payments' ? 'active' : ''} onClick={() => setActiveNav('Payments')}><CircleDollarSign size={18} /><span>Payments</span></button>
          <button className={activeNav === 'Data health' ? 'active' : ''} onClick={() => setActiveNav('Data health')}><ShieldCheck size={18} /><span>Data health</span></button>
        </nav>
        <div className="sidebar-bottom">
          <button className={activeNav === 'Settings' ? 'active' : ''} onClick={() => setActiveNav('Settings')}><Settings size={18} /><span>Settings</span></button>
          <button className="profile" onClick={onLogout} title="Sign out of Leakline"><span>{initials(user.name || user.email)}</span><div><strong>{user.name || user.email}</strong><small>{user.email}</small></div><ChevronDown size={15} /></button>
        </div>
      </aside>

      <main>
        <header>
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={21} /></button>
          <div className={`search ${searchOpen ? 'open' : ''}`} onClick={() => { setSearchOpen(true); setNotificationsOpen(false); setPeriodMenuOpen(false) }}>
            <Search size={17} />
            <input ref={searchInputRef} aria-label="Search leads, deals or insights" placeholder="Search leads, deals or insights" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onFocus={() => setSearchOpen(true)} />
            <kbd>⌘ K</kbd>
            {searchOpen && <div className="header-popover search-popover" onClick={(event) => event.stopPropagation()}>
              <span className="popover-label">{searchQuery ? `${searchResults.length} results` : 'Active alerts'}</span>
              {searchResults.length ? searchResults.map((item) => <button key={item.key} onClick={() => openSearchItem(item)}><Search size={14} /><span><strong>{item.label}</strong><small>{item.meta}</small></span><ArrowRight size={14} /></button>) : <div className="popover-empty">No matching records</div>}
            </div>}
          </div>
          <div className="header-control">
            <button className="icon-button" aria-label="Notifications" onClick={() => { setNotificationsOpen((open) => !open); setSearchOpen(false); setPeriodMenuOpen(false) }}><Bell size={19} />{unreadAlerts.length > 0 && <i />}</button>
            {notificationsOpen && <div className="header-popover notification-popover">
              <div className="popover-head"><span><strong>Notifications</strong><small>{unreadAlerts.length} unreviewed alerts</small></span>{unreadAlerts.length > 0 && <button onClick={markAllAlertsReviewed}>Mark all reviewed</button>}</div>
              {activeLeaks.length ? activeLeaks.slice(0, 6).map((leak) => <button className={reviewedLeaks.has(leak.id) ? 'reviewed' : ''} key={leak.id} onClick={() => { setSelectedLeak(leak); setNotificationsOpen(false) }}><span className={`severity-dot ${leak.severity}`} /><span><strong>{leak.title}</strong><small>{money.format(leak.impact)} estimated impact</small></span></button>) : <div className="popover-empty">No active alerts</div>}
            </div>}
          </div>
          <div className="header-control">
            <button className="period-button" aria-label="Select reporting period" onClick={() => { setPeriodMenuOpen((open) => !open); setSearchOpen(false); setNotificationsOpen(false) }}><CalendarDays size={17} />{period}<ChevronDown size={15} /></button>
            {periodMenuOpen && <div className="header-popover period-popover"><span className="popover-label">Reporting period</span>{(['7 days', 'This month', 'Quarter'] as Period[]).map((item) => <button key={item} className={period === item ? 'active' : ''} onClick={() => { setPeriod(item); setPeriodMenuOpen(false) }}><span>{item}</span>{period === item && <CheckCircle2 size={15} />}</button>)}</div>}
          </div>
        </header>

        <div className="content">
          {activeNav === dataEntryNav ? <ImportPage initialWorkspace={importedWorkspace} onOpenIntegrations={() => setActiveNav('Integrations')} onSandboxSnapshot={applyIntegrationSnapshot} onApply={(workspace, _alerts, sourceMode) => { if (sourceMode === 'exports') { setIntegrationStatuses([]); setSyncedCalls(0) } applyIntegratedWorkspace(workspace); setActiveNav('Overview') }} onClear={() => { clearSavedWorkspace(); clearResolvedRecovery(); clearReviewedLeaks(); setImportedWorkspace({}); setResolvedRecovery(new Set()); setReviewedLeaks(new Set()); setIntegrationStatuses([]); setSyncedCalls(0) }} /> : activeNav === 'Integrations' ? <IntegrationPage initialWorkspace={importedWorkspace} onWorkspace={applyIntegratedWorkspace} /> : activeNav === 'Calls' ? <CallsPage /> : activeNav !== 'Overview' ? <SectionPage section={activeNav} onOpenLeak={setSelectedLeak} alertData={activeLeaks} workspace={periodWorkspace} funnelData={displayFunnel} closerData={displayClosers} recoveryData={displayRecovery} healthData={displayHealth} onResolveRecovery={resolveRecovery} reviewedLeaks={reviewedLeaks} /> : <>
          <section className="page-heading">
            <div><p>Revenue command · Ascend Growth Partners sample audit</p><h1>Scale without leaking revenue.</h1><span>{hasImportedData ? `${importedLeaks.length} leaks found across ${Object.values(importedWorkspace).reduce((sum, item) => sum + item.rows.length, 0)} current-funnel records before adding more volume.` : `Before adding more leads, calls, or closers, find the revenue already leaking from the funnel you have.`}</span></div>
            <div className="period-switcher">
              {(['7 days', 'This month', 'Quarter'] as Period[]).map((item) => <button key={item} className={period === item ? 'active' : ''} onClick={() => setPeriod(item)}>{item}</button>)}
            </div>
          </section>

          <section className="demo-path panel" aria-label="Demo path">
            <div className="demo-path-head">
              <div><span className="eyebrow"><Target size={14} /> Demo path</span><h2>Audit the funnel you already have before spending more to scale.</h2></div>
              <button className="ghost-button" onClick={() => runDemoStep(dataEntryNav)}>{hasImportedData ? 'Replace data' : 'Load data'}</button>
            </div>
            <div className="demo-path-steps">
              {demoSteps.map((item, index) => <button key={item.step} className={item.ready ? 'ready' : ''} onClick={() => runDemoStep(item.step)}>
                <span>{index + 1}</span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </button>)}
            </div>
          </section>

          <section className="pilot-offer-grid" aria-label="Pilot offer">
            <article className="panel pilot-offer-card">
              <span className="eyebrow"><CircleDollarSign size={14} /> Manual pilot path</span>
              <h2>Start with a $1,500 Revenue Leak Audit.</h2>
              <p>Send, export, or connect leads, calls, deals, payments, refunds and closer data. LeakLine maps where revenue is leaking before the team adds more volume.</p>
              <div className="offer-price-row">
                <span><strong>$1,500</strong><small>Revenue Leak Audit</small></span>
                <span><strong>$3,000 + $1,500/mo</strong><small>90-day monitoring pilot</small></span>
              </div>
            </article>
            <article className="panel pilot-offer-card">
              <span className="eyebrow"><ShieldCheck size={14} /> Recovery report outcome</span>
              <h2>Leave with a 7-day recovery plan.</h2>
              <p>The audit packages each leak with evidence, estimated impact, owner and next action so a manager knows what to recover first.</p>
              <a className="report-link" href="https://drive.google.com/file/d/1cop2kFbIf-rRVoyBXid71nRA4j-CvuTL/view?usp=drivesdk" target="_blank" rel="noreferrer">View sample report <ArrowRight size={14} /></a>
            </article>
          </section>

          <section className={`data-confidence panel ${sourceConfidence.level.toLowerCase()}`}>
            <div className="data-confidence-head">
              <div><span className="eyebrow"><ShieldCheck size={14} /> Data source confidence</span><h2>{sourceConfidence.level} confidence</h2><p>{sourceConfidence.note}</p></div>
              <span>{sourceConfidence.freshness}</span>
            </div>
            <div className="confidence-grid">
              <div><strong>Available sources</strong><span>{sourceConfidence.connectedSources.length ? sourceConfidence.connectedSources.join(', ') : 'None yet'}</span></div>
              <div><strong>Missing sources</strong><span>{sourceConfidence.missingSources.length ? sourceConfidence.missingSources.join(', ') : 'None'}</span></div>
              <div><strong>Trust signal</strong><span>{sourceConfidence.level === 'High' ? 'CRM, calendar and payments are covered.' : sourceConfidence.level === 'Medium' ? 'Enough to demo; still needs a source check.' : 'Use as a skeleton until key sources are added.'}</span></div>
            </div>
          </section>

          <section className="kpi-grid">
            {displayMetrics.map((kpi, index) => (
              <article className="kpi-card" key={kpi.label}>
                <div className="kpi-top"><span>{kpi.label}</span><button aria-label={`Explain ${kpi.label}`} onClick={() => setSelectedMetric(kpi)}><Info size={14} /></button></div>
                <strong>{kpi.value}</strong>
                <div className="kpi-meta">
                  {kpi.change !== undefined && <span className={`${kpi.change >= 0 ? 'up' : 'down'} ${kpi.inverse ? 'inverse' : ''}`}>
                    {kpi.change >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{Math.abs(kpi.change)}%
                  </span>}
                  <small>{kpi.detail}</small>
                </div>
                {kpi.label === 'Revenue at risk' && <div className="leak-meter"><i style={{ width: '20.5%' }} /></div>}
              </article>
            ))}
          </section>

          <section className="main-grid">
            <article className="panel leak-panel">
              <div className="panel-head">
                <div><span className="eyebrow"><Sparkles size={14} /> Fix before scaling</span><h2>Leak feed</h2></div>
                <span className="live-pill"><i /> {hasImportedData ? 'Imported' : 'Live'}</span>
              </div>
              <div className="filter-row">
                {(['All', 'critical', 'warning', 'opportunity'] as const).map((filter) => (
                  <button key={filter} className={leakFilter === filter ? 'active' : ''} onClick={() => setLeakFilter(filter)}>{filter === 'All' ? 'All leaks' : filter}</button>
                ))}
              </div>
              <div className="leak-list">{visibleLeaks.map((leak) => <LeakRow key={leak.id} leak={leak} onOpen={setSelectedLeak} reviewed={reviewedLeaks.has(leak.id)} />)}</div>
              <button className="text-button" onClick={() => setActiveNav('Leak feed')}>View all insights <ArrowRight size={16} /></button>
            </article>

            <div className="right-stack">
              <article className="panel funnel-panel">
                <div className="panel-head"><div><span className="eyebrow">Sales health</span><h2>Revenue funnel</h2></div><button className="ghost-button" onClick={() => setActiveNav('Funnel')}>Explore</button></div>
                <div className="funnel-list">
                  {displayFunnel.map((stage, index) => (
                    <div className="funnel-row" key={stage.label}>
                      <div><span>{stage.label}</span><strong>{stage.value}</strong></div>
                      <div className="funnel-track"><i style={{ width: `${stage.value / Math.max(displayFunnel[0].value, 1) * 100}%`, background: stage.color }} /></div>
                      <small>{index === 0 ? '—' : `${stage.rate}%`}</small>
                    </div>
                  ))}
                </div>
                <div className="funnel-note"><AlertTriangle size={16} /><span><strong>Largest drop:</strong> {largestFunnelDrop?.label ?? 'No stage data'}</span><em>{largestFunnelDrop?.records ?? 0} records</em></div>
              </article>

              <article className="panel trend-panel">
                <div className="panel-head"><div><span className="eyebrow">{hasImportedData ? 'Imported payment timeline' : periodMetrics[period].rangeLabel}</span><div className="chart-title"><h2>Revenue movement</h2><button aria-label="Explain revenue movement" onClick={() => setShowChartInfo((open) => !open)}><Info size={14} /></button>{showChartInfo && <div className="chart-info-popover"><strong>Three revenue states</strong><span>Retained revenue remains after confirmed losses. Estimated at-risk revenue may still be recovered. Confirmed lost revenue includes completed refunds, lost chargebacks and formal write-offs.</span></div>}</div></div><div className="legend"><span><i className="retained" />Retained</span><span><i className="leaked" />Est. at risk</span><span><i className="lost" />Confirmed lost</span></div></div>
                <TrendChart data={displayRevenueTrend} />
              </article>
            </div>
          </section>

          <section className="bottom-grid">
            <article className="panel team-panel">
              <div className="panel-head"><div><span className="eyebrow">{hasImportedData ? 'Imported performance' : 'Performance'}</span><h2>Closer health</h2></div><button className="ghost-button" onClick={() => setActiveNav('Team')}>View team</button></div>
              <CloserHealthTable rows={displayClosers} />
            </article>

            <article className="panel recovery-panel">
              <div className="panel-head"><div><span className="eyebrow">Action queue</span><h2>Recover before adding volume</h2></div><span className="amount">{money.format(displayRecovery.reduce((sum, item) => sum + item.value, 0))}</span></div>
              {displayRecovery.length ? <div className="recovery-list">{displayRecovery.map((item) => <div className="recovery-item" key={`${item.prospect}-${item.reason}`}>
                <span className={`priority ${item.priority.toLowerCase()}`} />
                <div><strong>{item.prospect}</strong><span>{item.reason} · {item.inactive}d inactive</span></div>
                <strong>{money.format(item.value)}</strong>
                <button><ArrowRight size={15} /></button>
              </div>)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>Nothing to recover</h3><p>No stale deals or at-risk payments were found.</p></div>}
              <button className="primary-button" onClick={() => setActiveNav('Recovery')}>Open recovery queue <ArrowRight size={16} /></button>
            </article>
          </section>
          </>}
        </div>
      </main>

      {selectedLeak && <div className="drawer-backdrop" onClick={() => setSelectedLeak(null)}>
        <aside className="detail-drawer" onClick={(event) => event.stopPropagation()}>
          <button className="drawer-close" onClick={() => setSelectedLeak(null)}><X size={20} /></button>
          <span className={`drawer-severity ${selectedLeak.severity}`}>{selectedLeak.severity}</span>
          <p className="eyebrow">{selectedLeak.type} leak</p>
          <h2>{selectedLeak.title}</h2>
          <p className="drawer-description">{selectedLeak.description}</p>
          <div className="impact-box"><span>Estimated impact</span><strong>{money.format(selectedLeak.impact)}</strong><small>Based on average retained revenue for comparable opportunities.</small></div>
          <div className="drawer-period"><CalendarDays size={14} /><span>Evidence period</span><strong>{selectedLeak.periodLabel}</strong></div>
          <div className="evidence"><h3>Why this was flagged</h3><ul>{selectedLeak.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div>
          {selectedLeak.relatedRecords?.length && <div className="related-records" id="related-records-review">
            <div className="related-records-head">
              <div><h3>Lead review queue</h3><p>{selectedLeak.relatedRecords.length} affected lead{selectedLeak.relatedRecords.length === 1 ? '' : 's'} from the current synced data.</p></div>
              <span>{selectedLeak.relatedRecords.length}</span>
            </div>
            <div className="related-record-list">
              {selectedLeak.relatedRecords.map((record, index) => <article key={record.id ?? `${record.email}-${index}`}>
                <div>
                  <strong>{record.name}</strong>
                  <small>{record.email || 'No email'}{record.source ? ` · ${record.source}` : ''}</small>
                </div>
                <span>{record.owner || 'Unassigned'}</span>
                <em>{record.status || 'lead'}</em>
                {record.createdAt && <time>{new Date(record.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</time>}
              </article>)}
            </div>
          </div>}
          {selectedLeak.breakdown && <div className="drawer-breakdown"><h3>Named breakdown</h3>{selectedLeak.breakdown.map((row) => <div key={row.label}><strong>{row.label}</strong><span>{row.current}</span><small>Baseline {row.baseline}</small><em className={row.signal.startsWith('+') ? 'positive' : 'negative'}>{row.signal}</em></div>)}</div>}
          <div className="suggested-actions"><h3>Suggested actions</h3>{selectedLeak.suggestedActions.map((action, index) => <label key={action}><span>{index + 1}</span><p>{action}</p><button>Assign</button></label>)}</div>
          <div className="owner-row"><span>Suggested owner</span><strong>{selectedLeak.owner}</strong></div>
          <button className="primary-button" onClick={() => followLeakAction(selectedLeak)}>{selectedLeak.action} <ArrowRight size={16} /></button>
          <button className="secondary-button" onClick={() => markLeakReviewed(selectedLeak)} disabled={reviewedLeaks.has(selectedLeak.id)}>{reviewedLeaks.has(selectedLeak.id) ? 'Reviewed' : 'Mark as reviewed'}</button>
        </aside>
      </div>}

      {selectedMetric && <div className="drawer-backdrop" onClick={() => setSelectedMetric(null)}>
        <aside className="detail-drawer metric-drawer" onClick={(event) => event.stopPropagation()}>
          <button className="drawer-close" onClick={() => setSelectedMetric(null)}><X size={20} /></button>
          <span className="drawer-severity metric">Metric guide</span>
          <p className="eyebrow">How this number works</p>
          <h2>{selectedMetric.label}</h2>
          <div className="metric-value">{selectedMetric.value}</div>
          <p className="drawer-description">{selectedMetric.explanation}</p>
          <div className="formula-card"><span>Formula</span><strong>{selectedMetric.formula}</strong></div>
          <div className="formula-card calculation"><span>Current calculation</span><strong>{selectedMetric.calculation}</strong></div>
          {selectedMetric.label === 'Retained revenue / call' && <div className="evidence metric-notes"><h3>How to interpret it</h3><ul><li>Higher is generally better when lead quality is comparable between closers.</li><li>Track it by closer, campaign, offer and lead source.</li><li>Wait for the refund window before treating recent results as final.</li></ul></div>}
          <button className="secondary-button" onClick={() => setSelectedMetric(null)}>Got it</button>
        </aside>
      </div>}
    </div>
  )
}
