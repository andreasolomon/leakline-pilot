import { parseCsv } from './csvEngine'
import type { KpiSnapshotInput } from './kpiTracking'

export type KpiSheetPreview = {
  fileName: string
  sourceRows: number
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

function isoDate(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
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

export function parseKpiSheetCsv(fileName: string, text: string, now = new Date()): KpiSheetPreview {
  const rows = parseCsv(text)
  const sourceRows = Math.max(0, rows.length - 1)
  if (!rows.length) return { fileName, sourceRows, issues: ['The KPI file is empty.'], matchedFields: [] }

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

  if (issues.length) return { fileName, sourceRows, issues, matchedFields }

  const periodStartRaw = findValue(rows, ['period_start', 'start_date', 'from'])
  const periodEndRaw = findValue(rows, ['period_end', 'end_date', 'to'])
  const today = now.toISOString().slice(0, 10)
  return {
    fileName,
    sourceRows,
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
