import type { Leak } from './leakEngine'

export type DatasetKind = 'leads' | 'appointments' | 'deals' | 'payments' | 'closers'
export type NormalizedRow = Record<string, string | number | boolean | null>

export type DatasetImport = {
  kind: DatasetKind
  fileName: string
  rows: NormalizedRow[]
  sourceRows: number
  issues: string[]
  mappedFields: string[]
  headers: string[]
  mapping: Record<string, string>
  sourceText?: string
}

export type ImportWorkspace = Partial<Record<DatasetKind, DatasetImport>>

type Field = { key: string; aliases: string[]; type?: 'number' | 'date' | 'boolean' }

export const datasetConfig: Record<DatasetKind, { label: string; description: string; fields: Field[] }> = {
  leads: {
    label: 'Leads', description: 'People, acquisition source, status and ownership.',
    fields: [
      { key: 'id', aliases: ['lead_id', 'contact_id', 'id'] }, { key: 'name', aliases: ['full_name', 'contact_name', 'name'] },
      { key: 'email', aliases: ['email_address', 'email'] }, { key: 'source', aliases: ['lead_source', 'utm_source', 'source'] },
      { key: 'status', aliases: ['lead_status', 'stage', 'status'] }, { key: 'owner', aliases: ['assigned_to', 'closer', 'owner'] },
      { key: 'created_at', aliases: ['created_date', 'date_created', 'created_at'], type: 'date' },
      { key: 'last_activity_at', aliases: ['last_contacted', 'last_activity', 'updated_at'], type: 'date' },
    ],
  },
  appointments: {
    label: 'Appointments', description: 'Booked calls, attendance and campaign attribution.',
    fields: [
      { key: 'id', aliases: ['appointment_id', 'event_id', 'id'] }, { key: 'lead_id', aliases: ['contact_id', 'lead_id'] },
      { key: 'email', aliases: ['contact_email', 'email_address', 'email'] },
      { key: 'start_at', aliases: ['appointment_date', 'start_time', 'start_at'], type: 'date' },
      { key: 'status', aliases: ['attendance_status', 'outcome', 'status'] }, { key: 'source', aliases: ['campaign', 'lead_source', 'source'] },
      { key: 'closer', aliases: ['assigned_to', 'host', 'closer'] },
    ],
  },
  deals: {
    label: 'Deals', description: 'Pipeline value, stages, outcomes and next actions.',
    fields: [
      { key: 'id', aliases: ['deal_id', 'opportunity_id', 'id'] }, { key: 'lead_id', aliases: ['contact_id', 'lead_id'] },
      { key: 'name', aliases: ['deal_name', 'opportunity_name', 'name'] }, { key: 'stage', aliases: ['deal_stage', 'pipeline_stage', 'status', 'stage'] },
      { key: 'value', aliases: ['deal_value', 'amount', 'value'], type: 'number' }, { key: 'owner', aliases: ['assigned_to', 'closer', 'owner'] },
      { key: 'updated_at', aliases: ['last_activity', 'modified_at', 'updated_at'], type: 'date' },
      { key: 'next_action', aliases: ['next_step', 'next_task', 'next_action'] },
    ],
  },
  payments: {
    label: 'Payments', description: 'Collected cash, failures, refunds and overdue balances.',
    fields: [
      { key: 'id', aliases: ['payment_id', 'transaction_id', 'id'] }, { key: 'deal_id', aliases: ['opportunity_id', 'deal_id'] },
      { key: 'customer', aliases: ['customer_name', 'contact_name', 'customer'] }, { key: 'amount', aliases: ['payment_amount', 'total', 'amount'], type: 'number' },
      { key: 'status', aliases: ['payment_status', 'outcome', 'status'] }, { key: 'due_at', aliases: ['due_date', 'payment_due', 'due_at'], type: 'date' },
      { key: 'paid_at', aliases: ['payment_date', 'paid_date', 'paid_at'], type: 'date' },
    ],
  },
  closers: {
    label: 'Closers', description: 'Sales owners and optional performance benchmarks.',
    fields: [
      { key: 'id', aliases: ['closer_id', 'user_id', 'id'] }, { key: 'name', aliases: ['full_name', 'closer_name', 'name'] },
      { key: 'email', aliases: ['email_address', 'email'] }, { key: 'calls', aliases: ['call_count', 'appointments', 'calls'], type: 'number' },
      { key: 'close_rate', aliases: ['conversion_rate', 'win_rate', 'close_rate'], type: 'number' },
      { key: 'active', aliases: ['is_active', 'enabled', 'active'], type: 'boolean' },
    ],
  },
}

const cleanHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell.trim()); cell = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

function convert(value: string, type?: Field['type']): string | number | boolean | null {
  const cleaned = value.trim()
  if (!cleaned) return null
  if (type === 'number') {
    const number = Number(cleaned.replace(/[£$€,%\s]/g, '').replace(/\((.+)\)/, '-$1'))
    return Number.isFinite(number) ? number : null
  }
  if (type === 'boolean') return ['true', 'yes', '1', 'active'].includes(cleaned.toLowerCase())
  if (type === 'date') {
    const timestamp = Date.parse(cleaned)
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
  }
  return cleaned
}

export function normaliseCsv(kind: DatasetKind, fileName: string, text: string, overrides: Record<string, string> = {}): DatasetImport {
  const parsed = parseCsv(text)
  if (parsed.length < 2) return { kind, fileName, rows: [], sourceRows: 0, issues: ['The file has no data rows.'], mappedFields: [], headers: parsed[0] ?? [], mapping: {}, sourceText: text }
  const originalHeaders = parsed[0].map((header) => header.trim())
  const headers = originalHeaders.map(cleanHeader)
  const config = datasetConfig[kind]
  const mapping = new Map<number, Field>()
  const resolvedMapping: Record<string, string> = {}
  config.fields.forEach((field) => {
    const override = overrides[field.key]
    const index = override
      ? headers.findIndex((header) => header === cleanHeader(override))
      : headers.findIndex((header) => field.aliases.includes(header) || header === field.key)
    if (index >= 0) {
      mapping.set(index, field)
      resolvedMapping[field.key] = originalHeaders[index]
    }
  })
  const issues: string[] = []
  if (!mapping.size) issues.push('No recognised columns were found. Check the template headers.')
  const rows = parsed.slice(1).map((source, rowIndex) => {
    const target: NormalizedRow = {}
    mapping.forEach((field, index) => {
      const raw = source[index] ?? ''
      const value = convert(raw, field.type)
      target[field.key] = value
      if (raw && value === null && (field.type === 'date' || field.type === 'number')) issues.push(`Row ${rowIndex + 2}: invalid ${field.key}.`)
    })
    return target
  }).filter((row) => Object.values(row).some((value) => value !== null && value !== ''))
  return { kind, fileName, rows, sourceRows: parsed.length - 1, issues: [...new Set(issues)].slice(0, 8), mappedFields: [...mapping.values()].map((field) => field.key), headers: originalHeaders, mapping: resolvedMapping, sourceText: text }
}

const daysSince = (value: unknown) => typeof value === 'string' ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000)) : 0
const textValue = (value: unknown) => String(value ?? '').toLowerCase()
const numberValue = (value: unknown) => typeof value === 'number' ? value : 0
const money = (value: number) => Math.round(value)
const confirmedLossPaymentStatuses = new Set(['refunded', 'chargeback', 'charged back', 'written off', 'written_off', 'write-off'])

export function generateImportLeaks(workspace: ImportWorkspace): Leak[] {
  const alerts: Leak[] = []
  const leads = workspace.leads?.rows ?? []
  const appointments = workspace.appointments?.rows ?? []
  const bookedLeadIds = new Set(appointments.map((row) => textValue(row.lead_id)).filter(Boolean))
  const bookedEmails = new Set(appointments.map((row) => textValue(row.email)).filter(Boolean))
  const eligibleOptIns = leads.filter((row) => {
    const status = textValue(row.status)
    const canMatch = Boolean(textValue(row.id) || textValue(row.email))
    const excluded = ['disqualified', 'spam', 'customer', 'converted', 'closed'].includes(status)
    return canMatch && !excluded && daysSince(row.created_at) >= 2
  })
  const unbookedOptIns = eligibleOptIns.filter((row) => !bookedLeadIds.has(textValue(row.id)) && !bookedEmails.has(textValue(row.email)))
  if (unbookedOptIns.length) {
    const bookingRate = eligibleOptIns.length ? Math.round((eligibleOptIns.length - unbookedOptIns.length) / eligibleOptIns.length * 100) : 0
    alerts.push({
      id: 106,
      type: 'Booking gap',
      title: `${unbookedOptIns.length} opted-in leads have not booked`,
      description: `${bookingRate}% of matchable leads booked within the current 48-hour window.`,
      impact: unbookedOptIns.length * 300,
      severity: bookingRate < 60 ? 'critical' : 'warning',
      owner: 'Setter / SDR',
      count: unbookedOptIns.length,
      action: 'Review unbooked leads',
      periodLabel: 'Imported data',
      evidence: [`${eligibleOptIns.length} eligible opt-ins`, `${eligibleOptIns.length - unbookedOptIns.length} matched appointments`, `${unbookedOptIns.length} leads without a booking`],
      suggestedActions: [`Work the ${unbookedOptIns.length}-lead unbooked queue within 24 hours, starting with the newest high-intent opt-ins`, 'Run a three-touch booking recovery sequence across phone, SMS and email over the next 48 hours', 'Record recovered bookings against this case and compare the 7-day booking rate by source'],
      relatedRecords: unbookedOptIns.slice(0, 25).map((row, index) => ({
        id: String(row.id ?? `unbooked-${index + 1}`),
        name: String(row.name ?? row.email ?? `Unbooked lead ${index + 1}`),
        email: row.email ? String(row.email) : undefined,
        source: row.source ? String(row.source) : undefined,
        owner: row.owner ? String(row.owner) : undefined,
        status: row.status ? String(row.status) : undefined,
        createdAt: row.created_at ? String(row.created_at) : undefined,
      })),
    })
  }

  const deals = workspace.deals?.rows ?? []
  const staleDeals = deals.filter((row) => !['won', 'closed won', 'lost', 'closed lost'].includes(textValue(row.stage)) && !row.next_action && daysSince(row.updated_at) >= 3)
  if (staleDeals.length) {
    const impact = money(staleDeals.reduce((sum, row) => sum + numberValue(row.value), 0) * .25)
    alerts.push({ id: 101, type: 'Follow-up', title: `${staleDeals.length} open deals have no next action`, description: `These opportunities have been inactive for at least three days with no next step recorded.`, impact, severity: 'critical', owner: 'Sales manager', count: staleDeals.length, action: 'Review deals', periodLabel: 'Imported data', evidence: [`${staleDeals.length} inactive open deals`, `$${money(staleDeals.reduce((sum, row) => sum + numberValue(row.value), 0)).toLocaleString('en-US')} total pipeline value`], suggestedActions: [`Assign every one of the ${staleDeals.length} deals an owner, dated next step and decision deadline before the next sales stand-up`, 'Work the highest-value inactive opportunities first and record the outcome of every contact attempt', 'Review the queue after 7 days and record pipeline value recovered, lost or still blocked'] })
  }

  const completed = appointments.filter((row) => ['attended', 'showed', 'completed', 'no show', 'no_show', 'missed'].includes(textValue(row.status)))
  const noShows = completed.filter((row) => ['no show', 'no_show', 'missed'].includes(textValue(row.status)))
  if (completed.length >= 5 && noShows.length / completed.length > .25) {
    const showRate = Math.round((1 - noShows.length / completed.length) * 100)
    alerts.push({ id: 102, type: 'Attendance', title: `Show rate is ${showRate}% across imported appointments`, description: `${noShows.length} of ${completed.length} completed appointments were marked as no-shows.`, impact: noShows.length * 750, severity: showRate < 60 ? 'critical' : 'warning', owner: 'Setter / SDR manager', count: noShows.length, action: 'Inspect appointments', periodLabel: 'Imported data', evidence: [`${completed.length} completed appointments`, `${noShows.length} no-shows`], suggestedActions: [`Launch a same-day rebooking sequence for the ${noShows.length} no-shows and assign each record to a setter`, 'Identify the weakest source and booking-delay cohort before changing the whole reminder process', 'Run a 7-day confirmation test and record recovered appointments and show-rate movement'] })
  }

  const payments = workspace.payments?.rows ?? []
  const atRisk = payments.filter((row) => {
    const status = textValue(row.status)
    if (confirmedLossPaymentStatuses.has(status)) return false
    return ['failed', 'overdue', 'past due', 'past_due', 'unpaid'].includes(status) || (row.due_at && daysSince(row.due_at) > 0 && !row.paid_at)
  })
  if (atRisk.length) {
    const impact = money(atRisk.reduce((sum, row) => sum + numberValue(row.amount), 0))
    alerts.push({ id: 103, type: 'Collection', title: `${atRisk.length} payments need recovery`, description: `${impact.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} is failed, overdue or unpaid.`, impact, severity: 'critical', owner: 'Finance / Revenue operations', count: atRisk.length, action: 'Review payments', periodLabel: 'Imported data', evidence: [`${atRisk.length} at-risk payment records`, `$${impact.toLocaleString('en-US')} outstanding`], suggestedActions: [`Retry every eligible failed payment today and assign the ${atRisk.length}-account queue to a named owner`, 'Contact unresolved accounts within one business day with a payment link or approved payment-plan option', 'Record cash recovered, balances rescheduled and amounts written off before closing this case'] })
  }

  const untouched = leads.filter((row) => ['new', 'open', 'uncontacted', ''].includes(textValue(row.status)) && daysSince(row.created_at) >= 2 && !row.last_activity_at)
  if (untouched.length) alerts.push({ id: 104, type: 'Lead response', title: `${untouched.length} new leads have no recorded activity`, description: 'These leads are at least two days old and have no last-activity timestamp.', impact: untouched.length * 300, severity: 'warning', owner: 'Setter / SDR manager', count: untouched.length, action: 'Review leads', periodLabel: 'Imported data', evidence: [`${untouched.length} untouched leads`], suggestedActions: [`Route all ${untouched.length} untouched leads to named setters before the next dialling block`, 'Attempt the oldest leads first using the team response sequence and record every disposition', 'Review contact, booking and disqualification outcomes after 48 hours'] })

  const closers = workspace.closers?.rows ?? []
  const lowPerformers = closers.filter((row) => numberValue(row.calls) >= 10 && numberValue(row.close_rate) > 0 && numberValue(row.close_rate) < 20)
  if (lowPerformers.length) {
    const closerNoun = lowPerformers.length === 1 ? 'closer is' : 'closers are'
    alerts.push({ id: 105, type: 'Conversion', title: `${lowPerformers.length} ${closerNoun} below a 20% close rate`, description: 'LeakLine detected a possible closer-level conversion leak with enough call volume to investigate.', impact: lowPerformers.reduce((sum, row) => sum + numberValue(row.calls), 0) * 250, severity: 'opportunity', owner: 'Revenue operator / Sales manager', count: lowPerformers.length, action: 'View team', periodLabel: 'Imported data', evidence: lowPerformers.slice(0, 3).map((row) => `${row.name ?? 'Closer'}: ${row.close_rate}% across ${row.calls} calls`), suggestedActions: ['Compare lead source, qualification and offer mix before treating the gap as a closer-performance issue', 'Review three lost calls and three successful calls with each affected closer and document the repeated behaviour', 'Run the agreed coaching intervention for the next 10 qualified calls, then record conversion and cash movement'] })
  }

  return alerts.sort((a, b) => b.impact - a.impact)
}

export function importSummary(workspace: ImportWorkspace) {
  const imports = Object.values(workspace)
  return {
    files: imports.length,
    records: imports.reduce((sum, item) => sum + item.rows.length, 0),
    issues: imports.reduce((sum, item) => sum + item.issues.length, 0),
  }
}

export function mergeIntegrationWorkspace(base: ImportWorkspace, live: ImportWorkspace): ImportWorkspace {
  const preserved = { ...base }
  for (const [kind, item] of Object.entries(preserved)) {
    if (item?.fileName.endsWith('live sync')) delete preserved[kind as DatasetKind]
  }
  return { ...preserved, ...live }
}
