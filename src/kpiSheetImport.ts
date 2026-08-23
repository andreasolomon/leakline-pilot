import { parseCsv } from './csvEngine'
import type { KpiSnapshotInput } from './kpiTracking'

export type KpiSheetPreview = {
  fileName: string
  sourceRows: number
  format: 'gross_totals' | 'onboarding_tracker'
  appointmentRows?: number
  input?: KpiSnapshotInput
  issues: string[]
  matchedFields: string[]
}

const labels = {
  bookedCalls: ['booked_calls', 'calls_booked'],
  callsTaken: ['calls_taken'],
  deals: ['deals', 'deals_closed'],
  refunds: ['refunds'],
  totalRevenue: ['total_revenue', 'revenue'],
  cashCollected: ['cash_collected', 'cash'],
} as const

const fieldNames: Record<keyof typeof labels, string> = {
  bookedCalls: 'Booked Calls',
  callsTaken: 'Calls Taken',
  deals: 'Deals',
  refunds: 'Refunds',
  totalRevenue: 'Total Revenue',
  cashCollected: 'Cash Collected',
}

const clean = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

function numberValue(value: string) {
  const negative = /^\s*\(.*\)\s*$/.test(value)
  const parsed = Number(value.replace(/[,$£€%\s()]/g, ''))
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : undefined
}

function isoDate(value: string, dayFirst = false) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const localDate = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(trimmed)
  if (dayFirst && localDate) {
    const [, day, month, year] = localDate
    const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    const parsed = new Date(`${candidate}T00:00:00.000Z`)
    if (parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day)) return candidate
    return undefined
  }
  const timestamp = Date.parse(trimmed)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString().slice(0, 10)
}

function findValue(rows: string[][], candidates: readonly string[], preferredColumn?: number) {
  const columns = preferredColumn === undefined
    ? rows.flatMap((row) => row.map((_, index) => index)).filter((value, index, values) => values.indexOf(value) === index)
    : [preferredColumn]
  for (const column of columns) {
    for (const row of rows) {
      if (candidates.includes(clean(row[column] ?? ''))) return row[column + 1] ?? ''
    }
  }
  return undefined
}

function parseOnboardingTracker(fileName: string, rows: string[][]): KpiSheetPreview | undefined {
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map(clean)
    return cells.includes('date') && cells.includes('name') && cells.includes('outcome_of_the_call')
  })
  if (headerIndex < 0) return undefined

  const header = rows[headerIndex].map(clean)
  const dateColumn = header.indexOf('date')
  const nameColumn = header.indexOf('name')
  const outcomeColumn = header.indexOf('outcome_of_the_call')
  const issues: string[] = []
  const appointments: Array<{ date: string; outcome: string }> = []
  const allowedOutcomes = new Set(['no_show', 'rescheduled', 'showed_up_started', 'showed_up_did_not_convert'])

  rows.slice(headerIndex + 1).forEach((row, index) => {
    const sourceRow = headerIndex + index + 2
    const rawDate = row[dateColumn]?.trim() ?? ''
    const name = row[nameColumn]?.trim() ?? ''
    const outcome = clean(row[outcomeColumn] ?? '')
    if (!rawDate && !name && !outcome) return
    const date = isoDate(rawDate, true)
    if (!date) issues.push(`Row ${sourceRow} has an invalid date.`)
    if (!name) issues.push(`Row ${sourceRow} is missing the client name.`)
    if (!allowedOutcomes.has(outcome)) issues.push(`Row ${sourceRow} has an unsupported call outcome.`)
    if (date && name && allowedOutcomes.has(outcome)) appointments.push({ date, outcome })
  })

  if (!appointments.length && !issues.length) issues.push('No appointment rows were found below the onboarding tracker headings.')
  const dates = appointments.map((appointment) => appointment.date).sort()
  const callsTaken = appointments.filter((appointment) => appointment.outcome === 'showed_up_started' || appointment.outcome === 'showed_up_did_not_convert').length
  const deals = appointments.filter((appointment) => appointment.outcome === 'showed_up_started').length

  return {
    fileName,
    sourceRows: Math.max(0, rows.length - headerIndex - 1),
    format: 'onboarding_tracker',
    appointmentRows: appointments.length,
    issues,
    matchedFields: ['Booked Calls', 'Calls Taken', 'Deals'],
    input: issues.length || !dates.length ? undefined : {
      periodStart: dates[0],
      periodEnd: dates[dates.length - 1],
      bookedCalls: appointments.length,
      callsTaken,
      deals,
      refunds: 0,
      totalRevenue: 0,
      cashCollected: 0,
      financialsPending: true,
      notes: `Imported from ${fileName}. Calculated from ${appointments.length} onboarding appointment rows. Refunds, revenue and cash were not included and remain pending.`,
    },
  }
}

export function parseKpiSheetCsv(fileName: string, text: string, now = new Date()): KpiSheetPreview {
  const rows = parseCsv(text)
  const sourceRows = Math.max(0, rows.length - 1)
  if (!rows.length) return { fileName, sourceRows, format: 'gross_totals', issues: ['The KPI file is empty.'], matchedFields: [] }

  const onboardingTracker = parseOnboardingTracker(fileName, rows)
  if (onboardingTracker) return onboardingTracker

  const firstRow = rows[0].map(clean)
  const grossTotalsColumn = firstRow.findIndex((value) => value === 'gross_totals' || value === 'gross_total')
  const values = {} as Record<keyof typeof labels, number>
  const matchedFields: string[] = []
  const issues: string[] = []
  let financialsPending = false

  for (const [field, aliases] of Object.entries(labels) as Array<[keyof typeof labels, readonly string[]]>) {
    const raw = findValue(rows, aliases, grossTotalsColumn >= 0 ? grossTotalsColumn : undefined)
      ?? findValue(rows, aliases)
    const parsed = raw === undefined ? undefined : numberValue(raw)
    if (parsed === undefined || parsed < 0) {
      if (field === 'refunds' || field === 'totalRevenue' || field === 'cashCollected') {
        values[field] = 0
        financialsPending = true
      } else issues.push(`${fieldNames[field]} was missing or was not a valid non-negative number.`)
    }
    else {
      values[field] = parsed
      matchedFields.push(fieldNames[field])
    }
  }

  if (issues.length) return { fileName, sourceRows, format: 'gross_totals', issues, matchedFields }

  const periodStartRaw = findValue(rows, ['period_start', 'start_date', 'from'])
  const periodEndRaw = findValue(rows, ['period_end', 'end_date', 'to'])
  const today = now.toISOString().slice(0, 10)
  return {
    fileName,
    sourceRows,
    format: 'gross_totals',
    issues,
    matchedFields,
    input: {
      periodStart: periodStartRaw ? isoDate(periodStartRaw) ?? today : today,
      periodEnd: periodEndRaw ? isoDate(periodEndRaw) ?? today : today,
      ...values,
      financialsPending,
      notes: `Imported from ${fileName}`,
    },
  }
}
