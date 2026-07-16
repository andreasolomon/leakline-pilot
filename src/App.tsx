import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
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
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import { funnel, kpis, leaks, paymentEvents, periodMetrics, recoveryQueue, reps, sourceHealth, trendByPeriod, type Leak, type Metric, type Period } from './data'
import ImportPage from './ImportPage'
import IntegrationPage from './IntegrationPage'
import CallsPage from './CallsPage'
import { datasetConfig, generateImportLeaks, mergeIntegrationWorkspace, type ImportWorkspace } from './csvEngine'
import type { IntegrationSnapshot, ProviderStatus } from './integrationTypes'
import type { AuthRole, AuthUser, AuthWorkspace } from './AuthGate'
import RecoveryCaseDrawer from './RecoveryCaseDrawer'
import { recoveryCaseRequest, recoveryStatusLabels, type RecoveryCase, type RecoveryCaseUpdate } from './recoveryCases'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const workspaceStorageKey = 'leakline-v1-workspace'
const resolvedRecoveryStorageKey = 'leakline-v1-resolved-recovery'
const reviewedLeaksStorageKey = 'leakline-v1-reviewed-leaks'
const fullDemoWorkspaceId = 'workspace-leakline-demo'
const dataEntryNav = 'Connect or Import Data'
const confirmedLossStatuses = new Set(['refunded', 'chargeback', 'charged back', 'written off', 'written_off', 'write-off'])
const atRiskPaymentStatuses = new Set(['failed', 'overdue', 'past due', 'past_due', 'unpaid'])

type PaymentState = 'Paid' | 'Confirmed lost' | 'At risk' | 'Pending'
type DemoStep = typeof dataEntryNav | 'Leak command' | 'Revenue at risk' | 'Detected leak' | 'Recovery case' | 'Closer signals'
type CustomDateRange = { start: string; end: string }

const importedDateFields: Record<string, string[]> = {
  leads: ['created_at'],
  appointments: ['start_at'],
  deals: ['updated_at'],
  payments: ['paid_at', 'due_at'],
  closers: [],
}

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

const roleLabels: Record<AuthRole, string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager', viewer: 'Viewer' }
const roleDescriptions: Record<AuthRole, string> = {
  owner: 'LeakLine owner: all clients, users, workspaces, integrations and billing/admin control.',
  admin: 'Client admin: manages assigned workspace users and live integrations.',
  manager: 'Manager: refreshes detection data, triages detected leaks and owns recovery actions.',
  viewer: 'Viewer: read-only access to recovery cases and the funnel, call, closer and payment evidence behind them.',
}
const ownerRoles: AuthRole[] = ['owner', 'admin', 'manager', 'viewer']
const adminAssignableRoles: AuthRole[] = ['manager', 'viewer']
const canAdminister = (user: AuthUser) => user.role === 'owner' || user.role === 'admin'
const canManageIntegrations = (user: AuthUser) => user.role === 'owner' || user.role === 'admin'
const canEditWorkspaceData = (user: AuthUser) => user.role !== 'viewer'

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
  const timestamps = Object.entries(workspace).flatMap(([kind, item]) => (item?.rows ?? []).flatMap((row) =>
    (importedDateFields[kind] ?? []).map((field) => row[field]).filter((value): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))).map(Date.parse),
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
    if (!item || !(importedDateFields[kind]?.length)) return [kind, item]
    const rows = item.rows.filter((row) => {
      const timestamp = importedDateFields[kind].map((field) => row[field]).find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      return typeof timestamp !== 'string' || (Date.parse(timestamp) >= start.getTime() && Date.parse(timestamp) <= end.getTime())
    })
    return [kind, { ...item, rows }]
  })) as ImportWorkspace
}

export function filterImportedWorkspaceByDateRange(workspace: ImportWorkspace, startDate: string, endDate: string): ImportWorkspace {
  if (!Object.keys(workspace).length || !startDate || !endDate) return workspace
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T23:59:59.999Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return workspace

  return Object.fromEntries(Object.entries(workspace).map(([kind, item]) => {
    if (!item || !(importedDateFields[kind]?.length)) return [kind, item]
    const rows = item.rows.filter((row) => {
      const timestamp = importedDateFields[kind].map((field) => row[field]).find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      return typeof timestamp === 'string' && Date.parse(timestamp) >= start && Date.parse(timestamp) <= end
    })
    return [kind, { ...item, rows }]
  })) as ImportWorkspace
}

type FunnelActionCue = { title: string; action: string; owner: string; measure: string }

export function funnelActionCue(dropLabel: string, records = 0): FunnelActionCue {
  const label = dropLabel.toLowerCase()
  if (label.includes('leads') && label.includes('booked')) return {
    title: 'Tighten the opt-in-to-booking process',
    action: `Put the ${records || 'unbooked'} affected opt-ins into a 48-hour booking recovery sequence, then review speed-to-lead and contact attempts by setter.`,
    owner: 'Setter / SDR manager',
    measure: 'Booking rate and median speed-to-lead over the next 7 days',
  }
  if (label.includes('booked') && label.includes('attended')) return {
    title: 'Reduce preventable no-shows',
    action: 'Segment no-shows by source and booking delay, strengthen confirmations, and give every missed call a same-day rebooking attempt.',
    owner: 'Appointment setting / Revenue operations',
    measure: 'Show rate and recovered appointments by source over the next 14 days',
  }
  if (label.includes('attended') && label.includes('qualified')) return {
    title: 'Inspect lead quality before adding volume',
    action: 'Compare qualification failures by campaign, setter and offer. Tighten pre-call qualification where poor-fit calls are concentrated.',
    owner: 'Growth / Revenue operations',
    measure: 'Qualified rate and cost per qualified call by source',
  }
  if (label.includes('qualified') && label.includes('closed')) return {
    title: 'Review sales execution and follow-up',
    action: 'Audit lost qualified calls, group the main objections, and assign a dated follow-up plan to every viable opportunity.',
    owner: 'Sales manager',
    measure: 'Close rate, follow-up completion and recovered pipeline over 30 days',
  }
  return {
    title: 'Investigate the largest stage loss',
    action: 'Open the affected cohort, identify the common source or process failure, and assign one corrective test before adding more volume.',
    owner: 'Revenue operations',
    measure: 'Stage conversion and retained revenue after the corrective test',
  }
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
    ? 'Enough connected evidence for high-confidence leak detection.'
    : level === 'Medium'
      ? 'Usable detections, with missing evidence clearly called out.'
      : 'Provisional detections only. Add CRM, calendar and payment evidence before trusting the totals.'

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

const scopedStorageKey = (key: string, workspaceId: string) => `${key}-${workspaceId || 'default'}`

function readSavedWorkspace(workspaceId: string): ImportWorkspace {
  try { return JSON.parse(localStorage.getItem(scopedStorageKey(workspaceStorageKey, workspaceId)) ?? '{}') as ImportWorkspace }
  catch { return {} }
}

function saveWorkspace(workspaceId: string, workspace: ImportWorkspace) {
  try {
    const compact = Object.fromEntries(Object.entries(workspace).map(([kind, item]) => [kind, { ...item, sourceText: undefined }]))
    localStorage.setItem(scopedStorageKey(workspaceStorageKey, workspaceId), JSON.stringify(compact))
  } catch { /* Storage can be unavailable in private browsing. */ }
}

function clearSavedWorkspace(workspaceId: string) {
  try { localStorage.removeItem(scopedStorageKey(workspaceStorageKey, workspaceId)) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function readSavedResolvedRecovery(workspaceId: string) {
  try { return new Set<string>(JSON.parse(localStorage.getItem(scopedStorageKey(resolvedRecoveryStorageKey, workspaceId)) ?? '[]')) }
  catch { return new Set<string>() }
}

function saveResolvedRecovery(workspaceId: string, items: Set<string>) {
  try { localStorage.setItem(scopedStorageKey(resolvedRecoveryStorageKey, workspaceId), JSON.stringify([...items])) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function clearResolvedRecovery(workspaceId: string) {
  try { localStorage.removeItem(scopedStorageKey(resolvedRecoveryStorageKey, workspaceId)) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function readSavedReviewedLeaks(workspaceId: string) {
  try { return new Set<number>(JSON.parse(localStorage.getItem(scopedStorageKey(reviewedLeaksStorageKey, workspaceId)) ?? '[]')) }
  catch { return new Set<number>() }
}

function saveReviewedLeaks(workspaceId: string, items: Set<number>) {
  try { localStorage.setItem(scopedStorageKey(reviewedLeaksStorageKey, workspaceId), JSON.stringify([...items])) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function clearReviewedLeaks(workspaceId: string) {
  try { localStorage.removeItem(scopedStorageKey(reviewedLeaksStorageKey, workspaceId)) }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function TrendChart({ data }: { data: { day: string; retained: number; leaked: number; lost: number }[] }) {
  if (!data.length) return <div className="empty-alerts"><CircleDollarSign size={24} /><h3>No payment leak evidence available</h3><p>Connect or import payments to detect collection risk, confirmed losses and recoverable balances.</p></div>
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

function LeakRow({ leak, onOpen, reviewed = false, recoveryCase }: { leak: Leak; onOpen: (leak: Leak) => void; reviewed?: boolean; recoveryCase?: RecoveryCase }) {
  const status = recoveryCase ? recoveryStatusLabels[recoveryCase.status] : reviewed ? 'Acknowledged' : 'Detected'
  return (
    <button className={`leak-row ${recoveryCase?.status === 'resolved' ? 'resolved' : ''}`} onClick={() => onOpen(leak)}>
      <span className={`severity-dot ${leak.severity}`} />
      <span className="leak-copy">
        <span className="leak-type">{leak.type} · {leak.count} record{leak.count === 1 ? '' : 's'} <em className={`case-status ${recoveryCase?.status ?? 'detected'}`}>{status}</em></span>
        <strong>{leak.title}</strong>
        <span>{leak.description}{recoveryCase ? ` · Owner: ${recoveryCase.owner}${recoveryCase.deadline ? ` · Due ${new Date(`${recoveryCase.deadline}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}` : ''}</span>
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
      <div><span className="eyebrow">{importedPayments ? `${rows.length} payment records` : 'Payment evidence'}</span><h2>Payment recovery ledger</h2></div>
      <div className="ledger-totals"><span className="confirmed-total">{money.format(confirmedLost)} confirmed lost</span><span className="risk-total">{money.format(atRisk)} at risk</span></div>
    </div>
    {rows.length ? <div className="ledger-table">{rows.map((event) => <div key={event.key}>
      <span className={`ledger-status ${event.state === 'Confirmed lost' ? 'lost' : event.state === 'At risk' ? 'risk' : event.state.toLowerCase()}`} />
      <section><strong>{event.customer}</strong><small>{event.event}</small></section>
      <span>{event.date}</span><b>{money.format(event.amount)}</b><em>{event.state}</em>
    </div>)}</div> : <div className="empty-alerts"><FileUp size={24} /><h3>No payment evidence connected</h3><p>Connect or import payments so LeakLine can detect recoverable balances and confirmed losses.</p></div>}
  </article>
}

function CloserHealthTable({ rows }: { rows: CloserHealthRow[] }) {
  if (!rows.length) return <div className="empty-alerts"><Users size={24} /><h3>No closer leak evidence connected</h3><p>Connect or import closer outcomes so LeakLine can check conversion and retained-revenue gaps.</p></div>
  return <div className="table-scroll"><table>
    <thead><tr><th>Closer</th><th>Calls</th><th>Close rate</th><th>Cash collected</th><th>Retained</th><th>Trend</th></tr></thead>
    <tbody>{rows.map((rep) => <tr key={rep.name}>
      <td><span className="avatar" style={{ background: rep.color }}>{rep.initials}</span><strong>{rep.name}</strong></td>
      <td>{rep.calls}</td><td>{rep.closeRate}%</td><td>{money.format(rep.collected)}</td><td>{rep.retained === undefined ? '—' : `${rep.retained}%`}</td>
      <td>{rep.trend === undefined ? <span className="no-comparison">Baseline unavailable</span> : <span className={rep.trend > 0 ? 'trend-up' : 'trend-down'}>{rep.trend > 0 ? '+' : ''}{rep.trend}%</span>}</td>
    </tr>)}</tbody>
  </table></div>
}

function SectionPage({ section, onOpenLeak, alertData = leaks, workspace = {}, funnelData = funnel, closerData = reps, recoveryData = recoveryQueue, healthData = sourceHealth, onResolveRecovery, reviewedLeaks = new Set<number>(), recoveryCases = [], canAct = true }: { section: string; onOpenLeak: (leak: Leak) => void; alertData?: Leak[]; workspace?: ImportWorkspace; funnelData?: FunnelStage[]; closerData?: CloserHealthRow[]; recoveryData?: RecoveryItem[]; healthData?: DataHealthItem[]; onResolveRecovery?: (item: RecoveryItem) => void; reviewedLeaks?: Set<number>; recoveryCases?: RecoveryCase[]; canAct?: boolean }) {
  const copy: Record<string, [string, string]> = {
    'Leak feed': ['Leak feed', 'Detected revenue issues ranked by financial impact, with the records and actions needed to address them.'],
    Funnel: ['Funnel analysis', 'Locate the largest stage drop-offs, understand the likely cause and choose the next corrective test.'],
    Recovery: ['Revenue recovery', 'Work the opportunities and payment balances that can still be recovered.'],
    Team: ['Closer signals', 'Find conversion and retention gaps without blaming closers before lead mix and sample size are checked.'],
    Payments: ['Payment evidence', 'Separate recoverable collection risk from revenue that has already been confirmed lost.'],
    'Data health': ['Data confidence', 'See whether LeakLine has enough complete, recent and correctly matched data to trust its findings.'],
    Settings: ['Detection rules', 'Control detection windows, minimum samples, thresholds and recovery ownership.'],
  }
  const [title, subtitle] = copy[section] ?? [section, 'Leak detection and recovery workspace']
  const largestDrop = funnelData.slice(1).map((stage, index) => ({
    label: `${funnelData[index].label} → ${stage.label.toLowerCase()}`,
    records: Math.max(0, funnelData[index].value - stage.value),
  })).sort((left, right) => right.records - left.records)[0]
  const funnelCue = funnelActionCue(largestDrop?.label ?? '', largestDrop?.records ?? 0)
  const attendanceLeak = alertData.find((leak) => leak.type === 'Attendance')
  const demoAttendanceRows = !Object.keys(workspace).length ? leaks.find((leak) => leak.type === 'Attendance')?.breakdown ?? [] : []
  const campaignRows = attendanceLeak?.breakdown ?? demoAttendanceRows
  const campaignValues = campaignRows.map((row) => ({ ...row, numericValue: Number.parseFloat(row.current) })).filter((row) => Number.isFinite(row.numericValue))
  const bestCampaign = campaignValues.slice().sort((left, right) => right.numericValue - left.numericValue)[0]
  const weakestCampaign = campaignValues.slice().sort((left, right) => left.numericValue - right.numericValue)[0]
  const openLeakCount = alertData.filter((leak) => recoveryCases.find((item) => item.leakId === leak.id)?.status !== 'resolved').length
  return <section className="section-page">
    <div className="page-heading section-heading"><div><p>Workspace</p><h1>{title}</h1><span>{subtitle}</span></div></div>
    {section === 'Leak feed' && <article className="panel full-panel recovery-case-feed"><div className="panel-head"><div><span className="eyebrow">{openLeakCount} open leak{openLeakCount === 1 ? '' : 's'}</span><h2>Prioritised by revenue at risk</h2></div><span className="live-pill"><i /> {Object.keys(workspace).length ? 'Imported' : 'Live'}</span></div>{alertData.length ? <div className="leak-list">{alertData.slice().sort((left, right) => { const leftResolved = recoveryCases.find((item) => item.leakId === left.id)?.status === 'resolved'; const rightResolved = recoveryCases.find((item) => item.leakId === right.id)?.status === 'resolved'; return Number(leftResolved) - Number(rightResolved) || right.impact - left.impact }).map((leak) => <LeakRow key={leak.id} leak={leak} onOpen={onOpenLeak} reviewed={reviewedLeaks.has(leak.id)} recoveryCase={recoveryCases.find((item) => item.leakId === leak.id)} />)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>No leaks detected</h3><p>The imported records passed the current checks.</p></div>}</article>}
    {section === 'Funnel' && <div className="section-grid funnel-analysis-grid">
      <article className="panel funnel-analysis-card">
        <div className="panel-head"><div><span className="eyebrow">{Object.keys(workspace).length ? 'Imported funnel data' : 'Current period'}</span><h2>Stage conversion and drop-offs</h2></div></div>
        <div className="funnel-list">{funnelData.map((stage, index) => <div className="funnel-row" key={stage.label}><div><span>{stage.label}</span><strong>{stage.value}</strong></div><div className="funnel-track"><i style={{ width: `${stage.value / Math.max(funnelData[0].value, 1) * 100}%`, background: stage.color }} /></div><small>{index ? `${stage.rate}%` : '—'}</small></div>)}</div>
        <div className="funnel-note"><AlertTriangle size={16} /><span><strong>Largest drop:</strong> {largestDrop?.label ?? 'No stage data'}</span><em>{largestDrop?.records ?? 0} records</em></div>
        <div className="funnel-action-card">
          <span className="eyebrow"><Target size={13} /> Recommended response</span>
          <h3>{funnelCue.title}</h3>
          <p>{funnelCue.action}</p>
          <div className="funnel-action-meta"><span><small>Suggested owner</small><strong>{funnelCue.owner}</strong></span><span><small>Measure next</small><strong>{funnelCue.measure}</strong></span></div>
        </div>
      </article>
      <article className="panel funnel-analysis-card">
        <div className="panel-head"><div><span className="eyebrow">Campaign quality</span><h2>Attendance by source</h2></div></div>
        {campaignRows.length ? <>
          <div className="breakdown-table">{campaignRows.map((row) => <div key={row.label}><strong>{row.label}</strong><span>{row.current}</span><small className={row.signal.startsWith('+') ? 'positive' : 'negative'}>{row.signal}</small></div>)}</div>
          <div className="funnel-action-card campaign-action-card">
            <span className="eyebrow"><Sparkles size={13} /> Source action cue</span>
            <h3>{bestCampaign && weakestCampaign ? `${bestCampaign.label} is outperforming ${weakestCampaign.label} on attendance` : 'Use source quality to guide the next test'}</h3>
            <p>Protect and test more volume from the stronger source, but only scale it after close rate, acquisition cost, refunds and retained revenue support the same conclusion. Inspect qualification, booking delay and reminders on the weaker source before cutting it.</p>
            <div className="funnel-action-meta"><span><small>Suggested owner</small><strong>Growth / Revenue operations</strong></span><span><small>Measure next</small><strong>Show rate, close rate and retained revenue by source</strong></span></div>
            {attendanceLeak && <button className="secondary-button" onClick={() => onOpenLeak(attendanceLeak)}>Open attendance recovery case <ArrowRight size={14} /></button>}
          </div>
        </> : <div className="campaign-empty"><Activity size={22} /><h3>No source comparison yet</h3><p>Connect campaign or lead-source fields to compare attendance, close rate and retained revenue by source.</p></div>}
      </article>
    </div>}
    {section === 'Recovery' && <article className="panel full-panel"><div className="panel-head"><div><span className="eyebrow">{money.format(recoveryData.reduce((sum, item) => sum + item.value, 0))} potentially recoverable</span><h2>Open opportunities and payments</h2></div></div>{recoveryData.length ? <div className="recovery-board">{recoveryData.map((item) => <div key={recoveryItemKey(item)}><span className={`priority ${item.priority.toLowerCase()}`} /><section><strong>{item.prospect}</strong><small>{item.reason} · {item.inactive} days inactive</small><em>Owner: {item.owner}</em></section><b>{money.format(item.value)}</b><button className="resolve-button" disabled={!canAct} title={canAct ? 'Record this recovery item as resolved' : 'Viewer role is read-only'} onClick={() => canAct && onResolveRecovery?.(item)}><CheckCircle2 size={14} /><span>{canAct ? 'Record outcome' : 'Read only'}</span></button></div>)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>Nothing currently needs recovery</h3><p>No stale opportunities or at-risk payments were found in this period.</p></div>}</article>}
    {section === 'Team' && <article className="panel full-panel"><div className="panel-head"><div><span className="eyebrow">{Object.keys(workspace).length ? 'Imported closer data' : 'Comparable lead cohorts'}</span><h2>Conversion and retention signals</h2></div></div><CloserHealthTable rows={closerData} /></article>}
    {section === 'Payments' && <PaymentLedger workspace={workspace} />}
    {section === 'Data health' && <div className="health-grid">{healthData.map((source) => <article className="panel" key={source.source}>{source.status === 'Healthy' ? <CheckCircle2 size={20} className="healthy-icon" /> : <AlertTriangle size={20} className="review-icon" />}<div><span className="eyebrow">{source.status === 'Healthy' ? 'Detection ready' : 'Evidence gap'}</span><h2>{source.source}</h2><p>{source.detail}</p><small>{source.records}</small></div></article>)}</div>}
    {section === 'Settings' && <article className="panel settings-panel"><div><span className="eyebrow">Detection confidence</span><h2>Revenue maturity window</h2><p>Wait 14 days before LeakLine treats retained-revenue results as mature.</p></div><button>14 days <ChevronDown size={14} /></button><div><span className="eyebrow">Leak threshold</span><h2>Minimum sample size</h2><p>Only detect a closer-performance gap after 10 qualified calls.</p></div><button>10 calls <ChevronDown size={14} /></button></article>}
  </section>
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase()
}

type AdminUser = AuthUser & { createdAt: string; lastLoginAt?: string; createdBy?: string; disabledAt?: string }
type AdminInvite = { id: string; email: string; role: Exclude<AuthRole, 'owner'>; workspaceIds: string[]; workspaces: AuthWorkspace[]; status: 'pending' | 'accepted' | 'revoked' | 'expired'; createdAt: string; expiresAt: string; acceptedAt?: string; revokedAt?: string; token?: string }
type MarketingLead = { id: string; name: string; email: string; phone?: string; company: string; role?: string; website?: string; monthlyBookedCalls?: string; offerPrice?: string; crm?: string; suspectedLeak?: string; notes?: string; status: 'new' | 'qualified'; createdAt: string; qualifiedAt?: string }
type MarketingEvent = { id: string; event: 'page_view' | 'apply_click' | 'vsl_click' | 'sample_report_click' | 'client_login_click' | 'application_details_submitted' | 'application_completed'; path: string; createdAt: string; leadId?: string }

async function adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'Admin request failed.')
  return payload as T
}

function AdminPage({ currentUser }: { currentUser: AuthUser }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const allowedCreateRoles = currentUser.role === 'owner' ? ownerRoles : adminAssignableRoles
  const allowedInviteRoles = (currentUser.role === 'owner' ? ['admin', 'manager', 'viewer'] : ['manager', 'viewer']) as Array<Exclude<AuthRole, 'owner'>>
  const [form, setForm] = useState({ name: '', email: '', password: '', role: (currentUser.role === 'owner' ? 'manager' : 'viewer') as AuthUser['role'], workspaceId: currentUser.workspaceId })
  const [inviteForm, setInviteForm] = useState({ email: '', role: (currentUser.role === 'owner' ? 'manager' : 'viewer') as Exclude<AuthRole, 'owner'>, workspaceId: currentUser.workspaceId, expiresInDays: '7' })
  const [workspaceForm, setWorkspaceForm] = useState({ name: '', clientName: '' })
  const [invites, setInvites] = useState<AdminInvite[]>([])
  const [createdInviteLink, setCreatedInviteLink] = useState('')
  const [marketingLeads, setMarketingLeads] = useState<MarketingLead[]>([])
  const [marketingEvents, setMarketingEvents] = useState<MarketingEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const loadUsers = async () => {
    const payload = await adminRequest<{ users: AdminUser[] }>('/api/admin/users')
    setUsers(payload.users)
  }

  const loadInvites = async () => {
    const payload = await adminRequest<{ invites: AdminInvite[] }>('/api/admin/invites')
    setInvites(payload.invites)
  }

  const loadMarketing = async () => {
    if (currentUser.role !== 'owner') return
    const payload = await adminRequest<{ leads: MarketingLead[]; events: MarketingEvent[] }>('/api/admin/marketing')
    setMarketingLeads(payload.leads)
    setMarketingEvents(payload.events)
  }

  useEffect(() => {
    void Promise.all([loadUsers(), loadInvites(), loadMarketing()]).catch((event) => setError(event instanceof Error ? event.message : 'Could not load admin data.'))
  }, [])

  const eventTotal = (event: MarketingEvent['event']) => marketingEvents.filter((item) => item.event === event).length

  const createUser = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await adminRequest<{ user: AdminUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: form.name, email: form.email, password: form.password, role: form.role, workspaceIds: [form.workspaceId] }) })
      setForm({ name: '', email: '', password: '', role: currentUser.role === 'owner' ? 'manager' : 'viewer', workspaceId: currentUser.workspaceId })
      await loadUsers()
      setMessage('User created. Send them the public LeakLine URL and their temporary password privately.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Could not create user.')
    } finally {
      setBusy(false)
    }
  }

  const createInvite = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    setCreatedInviteLink('')
    try {
      const payload = await adminRequest<{ invite: AdminInvite }>('/api/admin/invites', { method: 'POST', body: JSON.stringify({ email: inviteForm.email, role: inviteForm.role, workspaceIds: [inviteForm.workspaceId], expiresInDays: Number(inviteForm.expiresInDays) || 7 }) })
      const link = `${window.location.origin}/invite/${payload.invite.token}`
      setCreatedInviteLink(link)
      setInviteForm({ email: '', role: currentUser.role === 'owner' ? 'manager' : 'viewer', workspaceId: currentUser.workspaceId, expiresInDays: '7' })
      await loadInvites()
      setMessage('Invite created. Copy the link now — it is only shown once.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Could not create invite.')
    } finally {
      setBusy(false)
    }
  }

  const revokeInvite = async (invite: AdminInvite) => {
    setError('')
    setMessage('')
    try {
      await adminRequest<{ invite: AdminInvite }>(`/api/admin/invites/${invite.id}/revoke`, { method: 'POST' })
      await loadInvites()
      setMessage(`Invite revoked for ${invite.email}.`)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Could not revoke invite.')
    }
  }

  const copyInviteLink = async () => {
    if (!createdInviteLink) return
    await navigator.clipboard.writeText(createdInviteLink)
    setMessage('Invite link copied.')
  }

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await adminRequest<{ workspaceId: string }>('/api/workspaces', { method: 'POST', body: JSON.stringify(workspaceForm) })
      setMessage('Workspace created. Reloading so the workspace switcher can pick it up.')
      window.setTimeout(() => window.location.reload(), 450)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Could not create workspace.')
    } finally {
      setBusy(false)
    }
  }

  const updateUser = async (userId: string, patch: Partial<Pick<AdminUser, 'role' | 'status'>>) => {
    setError('')
    setMessage('')
    try {
      await adminRequest<{ user: AdminUser }>(`/api/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) })
      await loadUsers()
      setMessage('User access updated.')
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Could not update user.')
    }
  }

  const resetUserPassword = async (item: AdminUser) => {
    const password = window.prompt(`Enter a new temporary password for ${item.email}. It must be at least 10 characters.`)
    if (!password) return
    setError('')
    setMessage('')
    try {
      await adminRequest<{ ok: true }>(`/api/admin/users/${item.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) })
      setMessage(`Password reset for ${item.email}. Send the new temporary password privately.`)
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Could not reset password.')
    }
  }

  return (
    <section className="section-page">
      <div className="page-heading section-heading">
        <div><p>Admin</p><h1>Admin command centre</h1><span>Review landing-page applications, track conversion activity and manage private client access.</span></div>
      </div>
      <div className="admin-grid">
        {currentUser.role === 'owner' && <>
          <article className="panel admin-marketing-card">
            <div className="panel-head"><div><span className="eyebrow"><Target size={14} /> Landing page</span><h2>Conversion activity</h2></div><button className="ghost-button" onClick={() => void loadMarketing()}>Refresh</button></div>
            <div className="marketing-metrics">
              <div><span>Page views</span><strong>{eventTotal('page_view')}</strong></div>
              <div><span>Audit clicks</span><strong>{eventTotal('apply_click')}</strong></div>
              <div><span>Details captured</span><strong>{eventTotal('application_details_submitted')}</strong></div>
              <div><span>Completed</span><strong>{eventTotal('application_completed')}</strong></div>
            </div>
          </article>
          <article className="panel admin-marketing-card">
            <div className="panel-head"><div><span className="eyebrow">{marketingLeads.length} application{marketingLeads.length === 1 ? '' : 's'}</span><h2>Revenue Leak Audit leads</h2></div></div>
            <div className="marketing-lead-list">
              {marketingLeads.length ? marketingLeads.map((lead) => <article key={lead.id}>
                <span className={`marketing-lead-status ${lead.status}`}>{lead.status}</span>
                <section><strong>{lead.name} · {lead.company}</strong><small>{lead.email}{lead.phone ? ` · ${lead.phone}` : ''}{lead.role ? ` · ${lead.role}` : ''}</small><em>{lead.suspectedLeak || 'Qualification not completed'}{lead.monthlyBookedCalls ? ` · ${lead.monthlyBookedCalls} booked calls/month` : ''}</em></section>
                <time>{new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(lead.createdAt))}</time>
              </article>) : <div className="empty-alerts"><Users size={24} /><h3>No landing-page applications yet</h3><p>New audit applications will appear here as soon as their contact details are captured.</p></div>}
            </div>
          </article>
        </>}
        <article className="panel admin-create-card">
          <div className="panel-head"><div><span className="eyebrow"><UserCog size={14} /> Add user</span><h2>Create a private login</h2></div></div>
          <form className="admin-form" onSubmit={createUser}>
            <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Client name" /></label>
            <label>Email<input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="client@company.com" /></label>
            <label>Temporary password<input required type="password" minLength={10} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="At least 10 characters" /></label>
            <label>Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as AuthUser['role'] })}>{allowedCreateRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select><small>{roleDescriptions[form.role]}</small></label>
            <label>Workspace<select value={form.workspaceId} onChange={(event) => setForm({ ...form, workspaceId: event.target.value })}>{currentUser.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.clientName}</option>)}</select></label>
            {error && <div className="auth-error">{error}</div>}
            {message && <div className="admin-success">{message}</div>}
            <button className="auth-submit" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
          </form>
        </article>
        <article className="panel admin-create-card admin-invite-card">
          <div className="panel-head"><div><span className="eyebrow"><UserCog size={14} /> Invite user</span><h2>Create invite link</h2></div></div>
          <form className="admin-form" onSubmit={createInvite}>
            <label>Email<input required type="email" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })} placeholder="client@company.com" /></label>
            <label>Role<select value={inviteForm.role} onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as Exclude<AuthRole, 'owner'> })}>{allowedInviteRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select><small>{roleDescriptions[inviteForm.role]}</small></label>
            <label>Workspace<select value={inviteForm.workspaceId} onChange={(event) => setInviteForm({ ...inviteForm, workspaceId: event.target.value })}>{currentUser.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.clientName}</option>)}</select></label>
            <label>Expires in<select value={inviteForm.expiresInDays} onChange={(event) => setInviteForm({ ...inviteForm, expiresInDays: event.target.value })}><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
            {createdInviteLink && <div className="invite-link-box"><span>{createdInviteLink}</span><button type="button" onClick={() => void copyInviteLink()}>Copy</button></div>}
            <button className="auth-submit" disabled={busy}>{busy ? 'Creating…' : 'Create invite'}</button>
          </form>
        </article>
        <article className="panel admin-users-card">
          <div className="panel-head"><div><span className="eyebrow">{users.length} account{users.length === 1 ? '' : 's'}</span><h2>Current users</h2></div><button className="ghost-button" onClick={() => void loadUsers()}>Refresh</button></div>
          <div className="admin-user-list">
            {users.map((item) => (
              <div className="admin-user-row" key={item.id}>
                <span className="admin-avatar">{initials(item.name || item.email)}</span>
                <section>
                  <strong>{item.name || item.email}{item.id === currentUser.id ? ' · You' : ''}</strong>
                  <small>{item.email}</small>
                  <em>Created {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(item.createdAt))}{item.lastLoginAt ? ` · Last login ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(item.lastLoginAt))}` : ''}</em>
                  <em>{roleLabels[item.role]} · {item.role === 'owner' ? 'All workspaces' : item.workspaces.map((workspace) => workspace.clientName).join(', ') || 'No workspace assigned'}</em>
                </section>
                <select aria-label={`Role for ${item.email}`} value={item.role} disabled={item.id === currentUser.id || (currentUser.role !== 'owner' && (item.role === 'owner' || item.role === 'admin'))} onChange={(event) => void updateUser(item.id, { role: event.target.value as AuthUser['role'] })}>
                  {(currentUser.role === 'owner' ? ownerRoles : adminAssignableRoles).map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
                </select>
                <button className={`status-toggle ${item.status}`} disabled={item.id === currentUser.id || (currentUser.role !== 'owner' && (item.role === 'owner' || item.role === 'admin'))} onClick={() => void updateUser(item.id, { status: item.status === 'active' ? 'disabled' : 'active' })}>{item.status === 'active' ? 'Disable' : 'Restore'}</button>
                <button className="reset-password-button" disabled={item.id === currentUser.id || (currentUser.role !== 'owner' && (item.role === 'owner' || item.role === 'admin'))} onClick={() => void resetUserPassword(item)}>Reset</button>
              </div>
            ))}
          </div>
        </article>
        <article className="panel admin-invites-card">
          <div className="panel-head"><div><span className="eyebrow">{invites.length} invite{invites.length === 1 ? '' : 's'}</span><h2>Invite management</h2></div><button className="ghost-button" onClick={() => void loadInvites()}>Refresh</button></div>
          <div className="admin-user-list">
            {invites.length ? invites.map((invite) => (
              <div className="admin-user-row invite-row" key={invite.id}>
                <span className={`invite-status ${invite.status}`}>{invite.status}</span>
                <section>
                  <strong>{invite.email}</strong>
                  <small>{roleLabels[invite.role]} · {invite.workspaces.map((workspace) => workspace.clientName).join(', ') || 'No workspace assigned'}</small>
                  <em>Expires {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(invite.expiresAt))}{invite.acceptedAt ? ` · Accepted ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(invite.acceptedAt))}` : ''}</em>
                </section>
                <button className="status-toggle disabled" disabled={invite.status !== 'pending'} onClick={() => void revokeInvite(invite)}>Revoke</button>
              </div>
            )) : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>No invites yet</h3><p>Create an invite link when you want users to set their own password.</p></div>}
          </div>
        </article>
        <article className="panel admin-workspaces-card">
          <div className="panel-head"><div><span className="eyebrow">{currentUser.workspaces.length} workspace{currentUser.workspaces.length === 1 ? '' : 's'}</span><h2>Client workspaces</h2></div></div>
          <div className="workspace-admin-list">
            {currentUser.workspaces.map((workspace) => <div key={workspace.id}><span className="workspace-logo">{initials(workspace.name)}</span><section><strong>{workspace.clientName}</strong><small>{workspace.recordCount} records · {workspace.id === currentUser.workspaceId ? 'Active now' : 'Available'}</small></section></div>)}
          </div>
          {currentUser.role === 'owner'
            ? <form className="admin-form workspace-create-form" onSubmit={createWorkspace}>
                <span className="eyebrow">Create workspace</span>
                <label>Short label<input required value={workspaceForm.name} onChange={(event) => setWorkspaceForm({ ...workspaceForm, name: event.target.value })} placeholder="Client short name" /></label>
                <label>Client/company name<input required value={workspaceForm.clientName} onChange={(event) => setWorkspaceForm({ ...workspaceForm, clientName: event.target.value })} placeholder="Full client company name" /></label>
                <button className="secondary-button" disabled={busy}>Create workspace</button>
              </form>
            : <div className="workspace-create-form role-note"><strong>Workspace creation is owner-only.</strong><span>Client admins can manage users inside their assigned workspace, but new pilot client workspaces are created by the LeakLine owner.</span></div>}
        </article>
      </div>
    </section>
  )
}

export default function App({ user, onLogout }: AppProps) {
  const [activeNav, setActiveNav] = useState('Leak feed')
  const [period, setPeriod] = useState<Period>('This month')
  const [customDateRange, setCustomDateRange] = useState<CustomDateRange | null>(null)
  const [dateRangeDraft, setDateRangeDraft] = useState<CustomDateRange>({ start: '', end: '' })
  const [dateRangeOpen, setDateRangeOpen] = useState(false)
  const [dateRangeError, setDateRangeError] = useState('')
  const [selectedLeak, setSelectedLeak] = useState<Leak | null>(null)
  const [selectedMetric, setSelectedMetric] = useState<Metric | null>(null)
  const [showChartInfo, setShowChartInfo] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const [leakFilter, setLeakFilter] = useState<'All' | Leak['severity']>('All')
  const [importedWorkspace, setImportedWorkspace] = useState<ImportWorkspace>(() => readSavedWorkspace(user.workspaceId))
  const [resolvedRecovery, setResolvedRecovery] = useState<Set<string>>(() => readSavedResolvedRecovery(user.workspaceId))
  const [reviewedLeaks, setReviewedLeaks] = useState<Set<number>>(() => readSavedReviewedLeaks(user.workspaceId))
  const [integrationStatuses, setIntegrationStatuses] = useState<ProviderStatus[]>([])
  const [syncedCalls, setSyncedCalls] = useState(0)
  const [recoveryCases, setRecoveryCases] = useState<RecoveryCase[]>([])

  const hasImportedData = Object.keys(importedWorkspace).length > 0
  const isFullDemoWorkspace = user.workspaceId === fullDemoWorkspaceId && !hasImportedData
  const hasDisplayData = hasImportedData || isFullDemoWorkspace
  const periodWorkspace = useMemo(() => customDateRange
    ? filterImportedWorkspaceByDateRange(importedWorkspace, customDateRange.start, customDateRange.end)
    : filterImportedWorkspace(importedWorkspace, period), [customDateRange, importedWorkspace, period])
  const importedLeaks = useMemo(() => generateImportLeaks(periodWorkspace), [periodWorkspace])
  const activeLeaks = hasImportedData ? importedLeaks : leaks
  const caseByLeakId = useMemo(() => new Map(recoveryCases.map((item) => [item.leakId, item])), [recoveryCases])
  const openLeaks = useMemo(() => activeLeaks.filter((leak) => caseByLeakId.get(leak.id)?.status !== 'resolved'), [activeLeaks, caseByLeakId])
  const recoveredThroughLeakLine = useMemo(() => recoveryCases.reduce((sum, item) => sum + item.recoveredAmount, 0), [recoveryCases])
  const searchItems = useMemo(() => importedSearchItems(periodWorkspace, activeLeaks), [periodWorkspace, activeLeaks])
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return (query ? searchItems.filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query)) : searchItems.filter((item) => item.leakId !== undefined)).slice(0, 8)
  }, [searchItems, searchQuery])
  const unreadAlerts = openLeaks.filter((leak) => !reviewedLeaks.has(leak.id))

  const visibleLeaks = useMemo(
    () => leakFilter === 'All' ? openLeaks : openLeaks.filter((leak) => leak.severity === leakFilter),
    [openLeaks, leakFilter],
  )

  const currentMetrics = useMemo<Metric[]>(() => {
    const view = periodMetrics[period]
    return kpis.map((metric) => {
      if (metric.label === 'Net retained') return { ...metric, value: view.retained, calculation: `${view.retained} retained during ${view.rangeLabel}` }
      if (metric.label === 'Confirmed lost') return { ...metric, value: view.confirmedLost, calculation: `${view.confirmedLost} confirmed lost during ${view.rangeLabel}` }
      if (metric.label === 'Revenue at risk') return { ...metric, value: view.leakage, detail: `${view.leakageShare} of collected cash`, calculation: `${view.leakage} estimated across open detected leaks` }
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
  const sourceConfidence = useMemo(() => isFullDemoWorkspace ? {
    connectedSources: ['GoHighLevel', 'Stripe', 'Google Calendar', 'Fathom', 'Closer scorecard'],
    missingSources: [],
    freshness: 'Sample data loaded',
    level: 'High' as const,
    note: 'Full sample evidence is available across the CRM, calendar, payments, calls and closer scorecard.',
  } : dataSourceConfidence(importedWorkspace, integrationStatuses, syncedCalls), [importedWorkspace, integrationStatuses, isFullDemoWorkspace, syncedCalls])
  const currentWorkspace = user.workspaces.find((workspace) => workspace.id === user.workspaceId) ?? user.workspaces[0] ?? { id: user.workspaceId, name: 'Workspace', clientName: 'Client workspace', role: user.role, recordCount: 0 } satisfies AuthWorkspace
  const userCanAdminister = canAdminister(user)
  const userCanManageIntegrations = canManageIntegrations(user)
  const userCanEditData = canEditWorkspaceData(user)
  const largestFunnelDrop = useMemo(() => displayFunnel.slice(1).map((stage, index) => ({
    label: `${displayFunnel[index].label} → ${stage.label.toLowerCase()}`,
    records: Math.max(0, displayFunnel[index].value - stage.value),
  })).sort((a, b) => b.records - a.records)[0], [displayFunnel])
  const largestFunnelAction = useMemo(() => funnelActionCue(largestFunnelDrop?.label ?? '', largestFunnelDrop?.records ?? 0), [largestFunnelDrop])
  const reportingPeriodLabel = useMemo(() => {
    if (!customDateRange) return period
    const format = (value: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`))
    return `${format(customDateRange.start)} – ${format(customDateRange.end)}`
  }, [customDateRange, period])

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
      if (metric.label === 'Revenue at risk') return {
        ...metric,
        value: money.format(openLeaks.reduce((sum, leak) => sum + leak.impact, 0)),
        change: undefined,
        detail: `${openLeaks.length} open recovery case${openLeaks.length === 1 ? '' : 's'}`,
        calculation: openLeaks.length ? openLeaks.map((leak) => money.format(leak.impact)).join(' + ') : 'No open recovery cases',
      }
      if (metric.label === 'Show rate' && hasImportedData) return {
        ...metric,
        value: `${summary.showRate}%`,
        change: undefined,
        detail: `${summary.attended} of ${summary.appointments} bookings`,
        calculation: `${summary.attended} attended ÷ ${summary.appointments} booked × 100 = ${summary.showRate}%`,
      }
      return metric
    }).concat({
      label: 'Recovered through LeakLine',
      value: money.format(recoveredThroughLeakLine),
      detail: `${recoveryCases.filter((item) => item.status === 'resolved').length} resolved case${recoveryCases.filter((item) => item.status === 'resolved').length === 1 ? '' : 's'}`,
      formula: 'Sum of recovered revenue recorded when recovery cases are resolved',
      calculation: recoveryCases.filter((item) => item.recoveredAmount > 0).map((item) => `${item.title}: ${money.format(item.recoveredAmount)}`).join(' + ') || '$0 recorded so far',
      explanation: 'Revenue that the team has explicitly attributed to completed LeakLine recovery cases.',
    })
  }, [currentMetrics, hasImportedData, openLeaks, periodWorkspace, recoveredThroughLeakLine, recoveryCases])
  const primaryLeak = [...openLeaks].sort((left, right) => right.impact - left.impact)[0]
  const revenueAtRiskMetric = displayMetrics.find((metric) => metric.label === 'Revenue at risk')
  const detectedCasesPayload = useMemo(() => activeLeaks.map((leak) => ({
    leakId: leak.id,
    type: leak.type,
    title: leak.title,
    description: leak.description,
    impact: leak.impact,
    affectedRecords: leak.count,
    severity: leak.severity,
    suggestedOwner: leak.owner,
    suggestedActions: leak.suggestedActions,
  })), [activeLeaks])
  const detectedCasesKey = JSON.stringify(detectedCasesPayload)

  const navItems = [
    { label: 'Leak feed', display: 'Leak feed', icon: AlertTriangle, badge: openLeaks.length },
    { label: 'Leak command', display: 'Leak command', icon: Target },
    { label: 'Recovery', display: 'Revenue recovery', icon: Target, badge: displayRecovery.length },
  ]
  const supportingNavItems = [
    { label: 'Funnel', display: 'Funnel analysis', icon: Activity },
    { label: 'Team', display: 'Closer signals', icon: Users },
    { label: 'Calls', display: 'Calls', icon: AudioLines },
    { label: 'Payments', display: 'Payments', icon: CircleDollarSign },
  ]

  const resolveRecovery = (item: RecoveryItem) => setResolvedRecovery((current) => {
    if (!userCanEditData) return current
    const next = new Set(current).add(recoveryItemKey(item))
    saveResolvedRecovery(user.workspaceId, next)
    return next
  })

  const openSearchItem = (item: SearchItem) => {
    if (item.leakId !== undefined) {
      const leak = activeLeaks.find((candidate) => candidate.id === item.leakId)
      if (leak) setSelectedLeak(leak)
    } else setActiveNav(item.section)
    setSearchOpen(false)
    setSearchQuery('')
  }

  const markAllAlertsReviewed = () => {
    if (!userCanEditData) return
    const next = new Set([...reviewedLeaks, ...activeLeaks.map((leak) => leak.id)])
    saveReviewedLeaks(user.workspaceId, next)
    setReviewedLeaks(next)
  }

  const updateRecoveryCase = async (caseId: string, update: RecoveryCaseUpdate) => {
    const payload = await recoveryCaseRequest<{ case: RecoveryCase }>(`/api/recovery-cases/${caseId}`, { method: 'PATCH', body: JSON.stringify(update) })
    setRecoveryCases((current) => current.map((item) => item.id === payload.case.id ? payload.case : item))
  }

  const runDemoStep = (step: DemoStep) => {
    setNotificationsOpen(false)
    setSearchOpen(false)
    setPeriodMenuOpen(false)
    if (step === dataEntryNav) setActiveNav(userCanEditData ? dataEntryNav : 'Data health')
    if (step === 'Leak command') setActiveNav('Leak command')
    if (step === 'Revenue at risk') {
      setActiveNav('Leak command')
      if (revenueAtRiskMetric) setSelectedMetric(revenueAtRiskMetric)
    }
    if (step === 'Detected leak') {
      setActiveNav('Leak command')
      if (primaryLeak) setSelectedLeak(primaryLeak)
    }
    if (step === 'Recovery case') {
      setActiveNav('Leak feed')
      if (primaryLeak) setSelectedLeak(primaryLeak)
    }
    if (step === 'Closer signals') setActiveNav('Team')
  }

  const demoSteps: { step: DemoStep; label: string; detail: string; ready: boolean }[] = [
    { step: dataEntryNav, label: 'Connect detection sources', detail: isFullDemoWorkspace ? 'Full sample CRM, calendar, payment, call and team evidence loaded' : hasImportedData ? 'Evidence loaded and ready for detection' : 'Connect, import or preview the evidence LeakLine checks', ready: hasDisplayData },
    { step: 'Leak command', label: 'Leak command', detail: isFullDemoWorkspace ? 'Ascend Growth sample funnel analysed' : hasImportedData ? `${Object.values(importedWorkspace).reduce((sum, item) => sum + item.rows.length, 0)} records analysed` : 'Find the revenue leaks before you scale harder', ready: true },
    { step: 'Revenue at risk', label: 'Revenue at risk', detail: revenueAtRiskMetric?.value ?? 'Open risk total', ready: Boolean(revenueAtRiskMetric) },
    { step: 'Detected leak', label: 'Detected leak', detail: primaryLeak ? primaryLeak.title : 'No active leak detected', ready: Boolean(primaryLeak) },
    { step: 'Recovery case', label: 'Recovery case', detail: primaryLeak ? 'Evidence, owner, deadline and recovery actions' : 'No recovery case required', ready: Boolean(primaryLeak) },
    { step: 'Closer signals', label: 'Closer signals', detail: `${displayClosers.length} closer${displayClosers.length === 1 ? '' : 's'} checked for conversion and retention gaps`, ready: displayClosers.length > 0 },
  ]

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
        setNotificationsOpen(false)
        setPeriodMenuOpen(false)
        setWorkspaceMenuOpen(false)
      }
      if (event.key === 'Escape') {
        setSearchOpen(false)
        setNotificationsOpen(false)
        setPeriodMenuOpen(false)
        setWorkspaceMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    const closeWorkspaceMenu = (event: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeWorkspaceMenu)
    return () => document.removeEventListener('pointerdown', closeWorkspaceMenu)
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
    setImportedWorkspace(readSavedWorkspace(user.workspaceId))
    setResolvedRecovery(readSavedResolvedRecovery(user.workspaceId))
    setReviewedLeaks(readSavedReviewedLeaks(user.workspaceId))
    setCustomDateRange(null)
    setDateRangeOpen(false)
    setIntegrationStatuses([])
    setSyncedCalls(0)
    setRecoveryCases([])
  }, [user.workspaceId])

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
          saveWorkspace(user.workspaceId, next)
          return next
        })
      } catch { /* CSV mode continues to work when the integration service is unavailable. */ }
    }
    void refreshLiveWorkspace()
    const timer = window.setInterval(refreshLiveWorkspace, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [user.workspaceId])

  useEffect(() => {
    let active = true
    const loadCases = async () => {
      try {
        const payload = userCanEditData && hasDisplayData
          ? await recoveryCaseRequest<{ cases: RecoveryCase[] }>('/api/recovery-cases/sync', { method: 'POST', body: JSON.stringify({ cases: detectedCasesPayload }) })
          : await recoveryCaseRequest<{ cases: RecoveryCase[] }>('/api/recovery-cases')
        if (active) setRecoveryCases(payload.cases)
      } catch { /* Leak detection remains available if shared case storage is temporarily unavailable. */ }
    }
    void loadCases()
    return () => { active = false }
  }, [detectedCasesKey, hasDisplayData, user.workspaceId, userCanEditData])

  const applyIntegratedWorkspace = (workspace: ImportWorkspace) => {
    saveWorkspace(user.workspaceId, workspace)
    clearResolvedRecovery(user.workspaceId)
    clearReviewedLeaks(user.workspaceId)
    setImportedWorkspace(workspace)
    setResolvedRecovery(new Set())
    setReviewedLeaks(new Set())
  }

  const applyIntegrationSnapshot = (snapshot: IntegrationSnapshot) => {
    setIntegrationStatuses(snapshot.statuses ?? [])
    setSyncedCalls(snapshot.calls?.length ?? 0)
  }

  const openWorkspacePage = (target: string) => {
    setActiveNav(target)
    setWorkspaceMenuOpen(false)
    setMobileNav(false)
  }

  const selectPresetPeriod = (nextPeriod: Period) => {
    setPeriod(nextPeriod)
    setCustomDateRange(null)
    setPeriodMenuOpen(false)
  }

  const openCustomDateRange = () => {
    if (customDateRange) setDateRangeDraft(customDateRange)
    else {
      const timestamps = Object.entries(importedWorkspace).flatMap(([kind, item]) => (item?.rows ?? []).flatMap((row) =>
        (importedDateFields[kind] ?? []).map((field) => row[field]).filter((value): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))).map(Date.parse),
      ))
      const end = new Date(timestamps.length ? Math.max(...timestamps) : Date.now())
      const start = new Date(end)
      start.setUTCDate(start.getUTCDate() - 29)
      setDateRangeDraft({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) })
    }
    setDateRangeError('')
    setDateRangeOpen(true)
    setPeriodMenuOpen(false)
  }

  const applyCustomDateRange = (event: FormEvent) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget as HTMLFormElement)
    const nextRange = { start: String(formData.get('startDate') ?? ''), end: String(formData.get('endDate') ?? '') }
    if (!nextRange.start || !nextRange.end) {
      setDateRangeError('Choose both a start date and an end date.')
      return
    }
    if (Date.parse(nextRange.start) > Date.parse(nextRange.end)) {
      setDateRangeError('The start date must be before the end date.')
      return
    }
    setDateRangeDraft(nextRange)
    setCustomDateRange(nextRange)
    setDateRangeOpen(false)
    setDateRangeError('')
  }

  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === user.workspaceId) {
      setWorkspaceMenuOpen(false)
      return
    }
    await adminRequest<{ user: AuthUser }>('/api/workspaces/active', { method: 'POST', body: JSON.stringify({ workspaceId }) })
    window.location.reload()
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><span>LEAKLINE</span></div>
        <button className="close-nav" onClick={() => setMobileNav(false)}><X size={20} /></button>
        <div className="workspace-switcher" ref={workspaceMenuRef}>
          <button className={`workspace-card ${workspaceMenuOpen ? 'open' : ''}`} type="button" aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}>
            <span className="workspace-logo">{initials(currentWorkspace.name)}</span>
            <span><strong>{currentWorkspace.name}</strong><small>{currentWorkspace.clientName}</small></span>
            <ChevronDown size={16} />
          </button>
          {workspaceMenuOpen && <div className="workspace-menu" role="menu">
            <span className="workspace-menu-label">Client workspaces</span>
            {user.workspaces.map((workspace) => <button className={workspace.id === user.workspaceId ? 'workspace-menu-current' : ''} role="menuitem" key={workspace.id} onClick={() => void switchWorkspace(workspace.id)}>
              <span className="workspace-logo">{initials(workspace.name)}</span>
              <span><strong>{workspace.clientName}</strong><small>{workspace.recordCount} stored records{workspace.id === user.workspaceId ? ' · active' : ''}</small></span>
              {workspace.id === user.workspaceId && <CheckCircle2 size={15} />}
            </button>)}
            {userCanEditData && <button role="menuitem" onClick={() => openWorkspacePage(dataEntryNav)}><FileUp size={14} /><span>Connect or import data</span></button>}
            <button role="menuitem" onClick={() => openWorkspacePage('Data health')}><ShieldCheck size={14} /><span>Review detection coverage</span></button>
            {userCanAdminister && <button role="menuitem" onClick={() => openWorkspacePage('Admin')}><UserCog size={14} /><span>Manage users</span></button>}
            <div className="workspace-menu-note">Each workspace keeps its own detection sources, leak evidence and recovery cases separate.</div>
          </div>}
        </div>
        <nav>
          <p>Workspace</p>
          {navItems.map(({ label, display, icon: Icon, badge }) => (
            <button key={label} className={activeNav === label ? 'active' : ''} onClick={() => { setActiveNav(label); setMobileNav(false); setWorkspaceMenuOpen(false) }}>
              <Icon size={18} /><span>{display}</span>{badge && <em>{badge}</em>}
            </button>
          ))}
          <p>Analysis</p>
          {supportingNavItems.map(({ label, display, icon: Icon }) => <button key={label} className={activeNav === label ? 'active' : ''} onClick={() => openWorkspacePage(label)}><Icon size={18} /><span>{display}</span></button>)}
          <p>Manage</p>
          {userCanEditData && <button className={activeNav === dataEntryNav || activeNav === 'Integrations' ? 'active' : ''} onClick={() => openWorkspacePage(dataEntryNav)}><Gauge size={18} /><span>Data sources</span></button>}
          <button className={activeNav === 'Data health' ? 'active' : ''} onClick={() => openWorkspacePage('Data health')}><ShieldCheck size={18} /><span>Data confidence</span></button>
          {userCanAdminister && <button className={activeNav === 'Admin' ? 'active' : ''} onClick={() => openWorkspacePage('Admin')}><UserCog size={18} /><span>Admin</span></button>}
        </nav>
        <div className="sidebar-bottom">
          <button className={activeNav === 'Settings' ? 'active' : ''} onClick={() => openWorkspacePage('Settings')}><Settings size={18} /><span>Detection rules</span></button>
          <button className="profile" onClick={onLogout} title="Sign out of Leakline"><span>{initials(user.name || user.email)}</span><div><strong>{user.name || user.email}</strong><small>{roleLabels[user.role]} · {user.email}</small></div><ChevronDown size={15} /></button>
        </div>
      </aside>

      <main>
        <header>
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={21} /></button>
          <div className={`search ${searchOpen ? 'open' : ''}`} onClick={() => { setSearchOpen(true); setNotificationsOpen(false); setPeriodMenuOpen(false) }}>
            <Search size={17} />
            <input ref={searchInputRef} aria-label="Search leaks, recovery cases or records" placeholder="Search leaks, cases or records" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onFocus={() => setSearchOpen(true)} />
            <kbd>⌘ K</kbd>
            {searchOpen && <div className="header-popover search-popover" onClick={(event) => event.stopPropagation()}>
              <span className="popover-label">{searchQuery ? `${searchResults.length} results` : 'Open leaks'}</span>
              {searchResults.length ? searchResults.map((item) => <button key={item.key} onClick={() => openSearchItem(item)}><Search size={14} /><span><strong>{item.label}</strong><small>{item.meta}</small></span><ArrowRight size={14} /></button>) : <div className="popover-empty">No matching records</div>}
            </div>}
          </div>
          <div className="header-control">
            <button className="icon-button" aria-label="Leak alerts" onClick={() => { setNotificationsOpen((open) => !open); setSearchOpen(false); setPeriodMenuOpen(false) }}><Bell size={19} />{unreadAlerts.length > 0 && <i />}</button>
            {notificationsOpen && <div className="header-popover notification-popover">
              <div className="popover-head"><span><strong>Leak alerts</strong><small>{unreadAlerts.length} need acknowledgement</small></span>{unreadAlerts.length > 0 && userCanEditData && <button onClick={markAllAlertsReviewed}>Acknowledge all</button>}</div>
              {activeLeaks.length ? activeLeaks.slice(0, 6).map((leak) => <button className={reviewedLeaks.has(leak.id) ? 'reviewed' : ''} key={leak.id} onClick={() => { setSelectedLeak(leak); setNotificationsOpen(false) }}><span className={`severity-dot ${leak.severity}`} /><span><strong>{leak.title}</strong><small>{money.format(leak.impact)} estimated revenue at risk</small></span></button>) : <div className="popover-empty">No open leaks</div>}
            </div>}
          </div>
          <div className="header-control">
            <button className="period-button" aria-label="Select leak detection window" onClick={() => { setPeriodMenuOpen((open) => !open); setSearchOpen(false); setNotificationsOpen(false) }}><CalendarDays size={17} /><span>{reportingPeriodLabel}</span><ChevronDown size={15} /></button>
            {periodMenuOpen && <div className="header-popover period-popover"><span className="popover-label">Detection window</span>{(['7 days', 'This month', 'Quarter'] as Period[]).map((item) => <button key={item} className={!customDateRange && period === item ? 'active' : ''} onClick={() => selectPresetPeriod(item)}><span>{item}</span>{!customDateRange && period === item && <CheckCircle2 size={15} />}</button>)}<button className={customDateRange ? 'active custom-period-option' : 'custom-period-option'} onClick={openCustomDateRange}><CalendarDays size={15} /><span><strong>Custom detection window</strong><small>{customDateRange ? reportingPeriodLabel : 'Choose exact start and end dates'}</small></span>{customDateRange && <CheckCircle2 size={15} />}</button></div>}
          </div>
        </header>

        <div className="content">
          {activeNav === dataEntryNav && userCanEditData ? <ImportPage initialWorkspace={importedWorkspace} onOpenIntegrations={() => setActiveNav('Integrations')} onSandboxSnapshot={applyIntegrationSnapshot} onApply={(workspace, _alerts, sourceMode) => { if (sourceMode === 'exports') { setIntegrationStatuses([]); setSyncedCalls(0) } applyIntegratedWorkspace(workspace); setActiveNav('Leak command') }} onClear={() => { clearSavedWorkspace(user.workspaceId); clearResolvedRecovery(user.workspaceId); clearReviewedLeaks(user.workspaceId); setImportedWorkspace({}); setResolvedRecovery(new Set()); setReviewedLeaks(new Set()); setIntegrationStatuses([]); setSyncedCalls(0) }} /> : activeNav === 'Integrations' && userCanEditData ? <IntegrationPage initialWorkspace={importedWorkspace} onWorkspace={applyIntegratedWorkspace} canManage={userCanManageIntegrations} canSync={userCanEditData} /> : activeNav === 'Calls' ? <CallsPage /> : activeNav === 'Admin' && userCanAdminister ? <AdminPage currentUser={user} /> : activeNav !== 'Leak command' ? <SectionPage section={activeNav === dataEntryNav || activeNav === 'Integrations' ? 'Data health' : activeNav} onOpenLeak={setSelectedLeak} alertData={activeLeaks} workspace={periodWorkspace} funnelData={displayFunnel} closerData={displayClosers} recoveryData={displayRecovery} healthData={displayHealth} onResolveRecovery={resolveRecovery} reviewedLeaks={reviewedLeaks} recoveryCases={recoveryCases} canAct={userCanEditData} /> : <>
          <section className="page-heading">
            <div><p>Leak command · {currentWorkspace.clientName}</p><h1>Detect, assign and recover leaking revenue.</h1><span>{isFullDemoWorkspace ? `${openLeaks.length} open recovery case${openLeaks.length === 1 ? '' : 's'} across the full sample funnel in ${reportingPeriodLabel}.` : hasImportedData ? `${openLeaks.length} open recovery case${openLeaks.length === 1 ? '' : 's'} across ${Object.values(periodWorkspace).reduce((sum, item) => sum + item.rows.length, 0)} records in ${reportingPeriodLabel}.` : `Turn detected funnel problems into owned recovery work and measurable outcomes.`}</span></div>
            <div className="period-controls">
              <div className="period-switcher">
                {(['7 days', 'This month', 'Quarter'] as Period[]).map((item) => <button key={item} className={!customDateRange && period === item ? 'active' : ''} onClick={() => selectPresetPeriod(item)}>{item}</button>)}
              </div>
              <button className={`custom-period-button ${customDateRange ? 'active' : ''}`} onClick={openCustomDateRange}><CalendarDays size={14} /><span>{customDateRange ? reportingPeriodLabel : 'Custom dates'}</span></button>
            </div>
          </section>

          <section className="priority-command" aria-label="Detected leaks and recovery actions">
            <article className="panel leak-panel">
              <div className="panel-head">
                <div><span className="eyebrow"><Sparkles size={14} /> Detected and ranked by impact</span><h2>Priority leaks</h2></div>
                <span className="live-pill"><i /> {isFullDemoWorkspace ? 'Sample' : hasImportedData ? 'Imported' : 'Live'}</span>
              </div>
              <div className="filter-row">
                {(['All', 'critical', 'warning', 'opportunity'] as const).map((filter) => (
                  <button key={filter} className={leakFilter === filter ? 'active' : ''} onClick={() => setLeakFilter(filter)}>{filter === 'All' ? 'All leaks' : filter}</button>
                ))}
              </div>
              {visibleLeaks.length ? <div className="leak-list">{visibleLeaks.slice(0, 4).map((leak) => <LeakRow key={leak.id} leak={leak} onOpen={setSelectedLeak} reviewed={reviewedLeaks.has(leak.id)} recoveryCase={caseByLeakId.get(leak.id)} />)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>No open recovery cases</h3><p>Every detected leak is currently resolved.</p></div>}
              <button className="text-button" onClick={() => setActiveNav('Leak feed')}>Review all detected leaks <ArrowRight size={16} /></button>
            </article>

            <article className={`panel priority-action-panel ${primaryLeak?.severity ?? ''}`}>
              <div className="panel-head">
                <div><span className="eyebrow"><Target size={14} /> What to do next</span><h2>Highest-impact recovery action</h2></div>
                {primaryLeak && <span className={`action-severity ${primaryLeak.severity}`}>{primaryLeak.severity}</span>}
              </div>
              {primaryLeak ? <>
                <div className="priority-action-summary">
                  <span>{primaryLeak.type} leak</span>
                  <h3>{primaryLeak.title}</h3>
                  <p>{primaryLeak.description}</p>
                </div>
                <div className="priority-action-impact"><span>Estimated impact</span><strong>{money.format(primaryLeak.impact)}</strong></div>
                <div className="priority-action-owner"><span>Accountable owner</span><strong>{caseByLeakId.get(primaryLeak.id)?.owner ?? primaryLeak.owner}</strong></div>
                <div className="priority-action-list">
                  <span>Recommended next steps</span>
                  {primaryLeak.suggestedActions.slice(0, 3).map((action, index) => <div key={action}><i>{index + 1}</i><p>{action}</p></div>)}
                </div>
                <button className="primary-button" onClick={() => setSelectedLeak(primaryLeak)}>Review evidence and affected records <ArrowRight size={16} /></button>
              </> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>No action needed</h3><p>No active leak currently requires a recovery action.</p></div>}
            </article>
          </section>

          <section className="kpi-grid" aria-label="Financial context">
            {displayMetrics.map((kpi) => (
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

          <div className="overview-section-label"><span>Supporting analysis</span><p>Use these views to understand what is driving each detected issue and where the response should focus.</p></div>
          <section className="analytics-grid">
            <article className="panel funnel-panel">
              <div className="panel-head"><div><span className="eyebrow">Funnel evidence</span><h2>Revenue funnel</h2></div><button className="ghost-button" onClick={() => setActiveNav('Funnel')}>View funnel analysis</button></div>
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
              <div className="funnel-action-card compact">
                <span className="eyebrow"><Target size={13} /> Recommended response</span>
                <h3>{largestFunnelAction.title}</h3>
                <p>{largestFunnelAction.action}</p>
                <div className="funnel-action-meta"><span><small>Suggested owner</small><strong>{largestFunnelAction.owner}</strong></span><span><small>Measure next</small><strong>{largestFunnelAction.measure}</strong></span></div>
                <button className="secondary-button" onClick={() => setActiveNav('Funnel')}>Open funnel actions <ArrowRight size={14} /></button>
              </div>
            </article>

            <article className="panel trend-panel">
              <div className="panel-head"><div><span className="eyebrow">{hasImportedData ? 'Payment evidence' : periodMetrics[period].rangeLabel}</span><div className="chart-title"><h2>Revenue exposure</h2><button aria-label="Explain revenue exposure" onClick={() => setShowChartInfo((open) => !open)}><Info size={14} /></button>{showChartInfo && <div className="chart-info-popover"><strong>Three revenue states</strong><span>Retained revenue remains after confirmed losses. Revenue at risk is linked to open recovery cases and may still be recovered. Confirmed lost revenue includes completed refunds, lost chargebacks and formal write-offs.</span></div>}</div></div><div className="legend"><span><i className="retained" />Retained</span><span><i className="leaked" />At risk</span><span><i className="lost" />Confirmed lost</span></div></div>
              <TrendChart data={displayRevenueTrend} />
            </article>
          </section>

          <section className="bottom-grid">
            <article className="panel team-panel">
              <div className="panel-head"><div><span className="eyebrow">Closer analysis · {hasImportedData ? 'Imported cohort' : 'Comparable cohort'}</span><h2>Conversion and retention signals</h2></div><button className="ghost-button" onClick={() => setActiveNav('Team')}>Review closer signals</button></div>
              <CloserHealthTable rows={displayClosers} />
            </article>

            <article className="panel recovery-panel">
              <div className="panel-head"><div><span className="eyebrow">Action queue</span><h2>Recover before adding volume</h2></div><span className="amount">{money.format(displayRecovery.reduce((sum, item) => sum + item.value, 0))}</span></div>
              {displayRecovery.length ? <div className="recovery-list">{displayRecovery.map((item) => <div className="recovery-item" key={`${item.prospect}-${item.reason}`}>
                <span className={`priority ${item.priority.toLowerCase()}`} />
                <div><strong>{item.prospect}</strong><span>{item.reason} · {item.inactive}d inactive</span></div>
                <strong>{money.format(item.value)}</strong>
                <button><ArrowRight size={15} /></button>
              </div>)}</div> : <div className="empty-alerts"><CheckCircle2 size={24} /><h3>No recoverable records detected</h3><p>LeakLine found no stale opportunities or at-risk payments in this detection window.</p></div>}
              <button className="primary-button" onClick={() => setActiveNav('Recovery')}>Open recovery queue <ArrowRight size={16} /></button>
            </article>
          </section>

          <section className={`data-confidence panel ${sourceConfidence.level.toLowerCase()}`}>
            <div className="data-confidence-head">
              <div><span className="eyebrow"><ShieldCheck size={14} /> Detection confidence</span><h2>{sourceConfidence.level} confidence</h2><p>{sourceConfidence.note}</p></div>
              <span>{sourceConfidence.freshness}</span>
            </div>
            <div className="confidence-grid">
              <div><strong>Evidence available</strong><span>{sourceConfidence.connectedSources.length ? sourceConfidence.connectedSources.join(', ') : 'None yet'}</span></div>
              <div><strong>Evidence missing</strong><span>{sourceConfidence.missingSources.length ? sourceConfidence.missingSources.join(', ') : 'None'}</span></div>
              <div><strong>Detection confidence</strong><span>{sourceConfidence.level === 'High' ? 'CRM, calendar and payments support reliable leak detection.' : sourceConfidence.level === 'Medium' ? 'Usable detections, with missing evidence clearly flagged.' : 'Treat detections as provisional until key sources are added.'}</span></div>
            </div>
          </section>

          <section className="demo-path panel overview-resource" aria-label="Demo path">
            <div className="demo-path-head">
              <div><span className="eyebrow"><Target size={14} /> Demo path</span><h2>Walk through the full revenue recovery story.</h2></div>
              {userCanEditData && <button className="ghost-button" onClick={() => runDemoStep(dataEntryNav)}>{hasDisplayData ? 'Replace data' : 'Load data'}</button>}
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
              <p>Send, export, or connect leads, calls, deals, payments, refunds and team performance data. LeakLine maps where revenue is leaking before the business adds more volume.</p>
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
          </>}
        </div>
      </main>

      {dateRangeOpen && <div className="date-range-backdrop" onClick={() => setDateRangeOpen(false)}>
        <form className="date-range-modal" onSubmit={applyCustomDateRange} onClick={(event) => event.stopPropagation()}>
          <button type="button" className="modal-close" aria-label="Close custom date range" onClick={() => setDateRangeOpen(false)}><X size={18} /></button>
          <span className="eyebrow"><CalendarDays size={14} /> Leak detection window</span>
          <h2>Choose the records LeakLine should check</h2>
          <p>LeakLine will rerun leak detection, revenue-at-risk estimates, funnel evidence and recovery queues using only dated records inside this window.</p>
          <div className="date-range-fields">
            <label>Start date<input name="startDate" type="date" required value={dateRangeDraft.start} onChange={(event) => setDateRangeDraft((current) => ({ ...current, start: event.target.value }))} /></label>
            <label>End date<input name="endDate" type="date" required value={dateRangeDraft.end} onChange={(event) => setDateRangeDraft((current) => ({ ...current, end: event.target.value }))} /></label>
          </div>
          {dateRangeError && <div className="modal-error"><AlertTriangle size={14} />{dateRangeError}</div>}
          <div className="date-range-actions">
            {customDateRange && <button type="button" className="clear-range-button" onClick={() => { setCustomDateRange(null); setDateRangeOpen(false) }}>Use {period}</button>}
            <button type="button" className="secondary-button" onClick={() => setDateRangeOpen(false)}>Cancel</button>
            <button className="primary-button">Rerun detection</button>
          </div>
        </form>
      </div>}

      {selectedLeak && <RecoveryCaseDrawer
        leak={selectedLeak}
        recoveryCase={caseByLeakId.get(selectedLeak.id)}
        canAct={userCanEditData}
        ownerOptions={Array.from(new Set([selectedLeak.owner, ...displayClosers.map((item) => item.name), 'Setter / SDR', 'Sales manager', 'Revenue operations', 'Finance']))}
        onClose={() => setSelectedLeak(null)}
        onUpdate={updateRecoveryCase}
        onOpenRecords={(leak) => { setActiveNav(sectionForLeakAction(leak.action)); setSelectedLeak(null) }}
      />}

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
