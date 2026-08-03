import { parseCsv } from './csvEngine'
import type { RenewalClient } from './renewalCommand'

export type ClickUpRenewalRow = {
  clickUpTaskId: string
  name: string
  email?: string
  phone?: string
  firstWebinarAt?: string
  lastWebinarAt?: string
  nextWebinarAt?: string
  webinarsHosted: number
  clickUpStatus?: string
}

export type ClickUpRenewalPreview = {
  fileName: string
  sourceRows: number
  rows: ClickUpRenewalRow[]
  issues: string[]
  completedWebinarDates: number
  futureWebinarDates: number
}

const cleanHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

const aliases = {
  clickUpTaskId: ['task_id', 'id'],
  name: ['task_name', 'name', 'client_name'],
  email: ['email_short_text', 'email'],
  phone: ['phone_short_text', 'phone', 'phone_number'],
  webinarOne: ['webinar_1_date', 'webinar_1'],
  webinarTwo: ['webinar_2_date', 'webinar_2'],
  webinarNext: ['webinar_next_date', 'webinar_next', 'next_webinar_date'],
  status: ['z_webinar_plan_status_z_drop_down', 'webinar_plan_status', 'status'],
}

function columnIndex(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.includes(header))
}

function parseClickUpDate(value: string) {
  const cleaned = value.trim().replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
  if (!cleaned) return undefined
  const isoDate = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoDate) {
    const [, year, month, day] = isoDate
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day)
      ? `${year}-${month}-${day}`
      : null
  }
  const writtenDate = cleaned.match(/(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})/)
  if (writtenDate) {
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
    const month = months.indexOf(writtenDate[1].toLowerCase())
    const day = Number(writtenDate[2])
    const year = Number(writtenDate[3])
    if (month < 0) return null
    const date = new Date(Date.UTC(year, month, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10)
      : null
  }
  const timestamp = Date.parse(cleaned)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10)
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function normalisePhone(value: string) {
  const raw = value.trim()
  if (!raw) return undefined
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

export function parseClickUpRenewalCsv(fileName: string, text: string, now = new Date()): ClickUpRenewalPreview {
  const parsed = parseCsv(text)
  const sourceRows = Math.max(0, parsed.length - 1)
  if (parsed.length < 2) return { fileName, sourceRows, rows: [], issues: ['The ClickUp file has no client rows.'], completedWebinarDates: 0, futureWebinarDates: 0 }

  const headers = parsed[0].map(cleanHeader)
  const indexes = {
    clickUpTaskId: columnIndex(headers, aliases.clickUpTaskId),
    name: columnIndex(headers, aliases.name),
    email: columnIndex(headers, aliases.email),
    phone: columnIndex(headers, aliases.phone),
    webinarOne: columnIndex(headers, aliases.webinarOne),
    webinarTwo: columnIndex(headers, aliases.webinarTwo),
    webinarNext: columnIndex(headers, aliases.webinarNext),
    status: columnIndex(headers, aliases.status),
  }
  const issues: string[] = []
  if (indexes.clickUpTaskId < 0) issues.push('The required ClickUp “Task ID” column was not found.')
  if (indexes.name < 0) issues.push('The required ClickUp “Task Name” column was not found.')
  if (indexes.clickUpTaskId < 0 || indexes.name < 0) return { fileName, sourceRows, rows: [], issues, completedWebinarDates: 0, futureWebinarDates: 0 }

  const today = now.toISOString().slice(0, 10)
  const seenTaskIds = new Set<string>()
  let completedWebinarDates = 0
  let futureWebinarDates = 0
  const rows: ClickUpRenewalRow[] = []

  parsed.slice(1).forEach((source, rowIndex) => {
    const line = rowIndex + 2
    const clickUpTaskId = (source[indexes.clickUpTaskId] ?? '').trim()
    const name = (source[indexes.name] ?? '').trim()
    if (!clickUpTaskId || !name) {
      issues.push(`Row ${line}: skipped because the Task ID or Task Name is missing.`)
      return
    }
    if (seenTaskIds.has(clickUpTaskId)) {
      issues.push(`Row ${line}: duplicate ClickUp Task ID ${clickUpTaskId} was skipped.`)
      return
    }
    seenTaskIds.add(clickUpTaskId)

    const rawEmail = indexes.email >= 0 ? (source[indexes.email] ?? '').trim().toLowerCase() : ''
    const email = rawEmail && validEmail(rawEmail) ? rawEmail : undefined
    if (rawEmail && !email) issues.push(`Row ${line}: the email address is invalid and was left blank.`)
    const rawPhone = indexes.phone >= 0 ? (source[indexes.phone] ?? '').trim() : ''
    const parsedPhone = normalisePhone(rawPhone)
    const phone = parsedPhone || undefined
    if (rawPhone && parsedPhone === null) issues.push(`Row ${line}: the phone number could not be converted to international format and was left blank.`)

    const datedFields = [
      { label: 'Webinar 1', value: indexes.webinarOne >= 0 ? source[indexes.webinarOne] ?? '' : '', nextOnly: false },
      { label: 'Webinar 2', value: indexes.webinarTwo >= 0 ? source[indexes.webinarTwo] ?? '' : '', nextOnly: false },
      { label: 'Webinar NEXT', value: indexes.webinarNext >= 0 ? source[indexes.webinarNext] ?? '' : '', nextOnly: true },
    ].map((field) => ({ ...field, parsed: parseClickUpDate(field.value) }))

    datedFields.filter((field) => field.value.trim() && field.parsed === null)
      .forEach((field) => issues.push(`Row ${line}: ${field.label} contains an invalid date and was ignored.`))

    const completed = [...new Set(datedFields
      .filter((field) => !field.nextOnly && typeof field.parsed === 'string' && field.parsed <= today)
      .map((field) => field.parsed as string))].sort()
    const future = [...new Set(datedFields
      .filter((field) => typeof field.parsed === 'string' && field.parsed > today)
      .map((field) => field.parsed as string))].sort()

    completedWebinarDates += completed.length
    futureWebinarDates += future.length
    rows.push({
      clickUpTaskId,
      name,
      email,
      phone,
      firstWebinarAt: completed[0],
      lastWebinarAt: completed.at(-1),
      nextWebinarAt: future[0],
      webinarsHosted: completed.length,
      clickUpStatus: indexes.status >= 0 ? (source[indexes.status] ?? '').trim() || undefined : undefined,
    })
  })

  return { fileName, sourceRows, rows, issues: [...new Set(issues)].slice(0, 20), completedWebinarDates, futureWebinarDates }
}

function sourceFieldsMatch(client: RenewalClient, row: ClickUpRenewalRow) {
  return client.name === row.name
    && (client.email ?? '') === (row.email ?? '')
    && (client.phone ?? '') === (row.phone ?? '')
    && (client.firstWebinarAt ?? '') === (row.firstWebinarAt ?? '')
    && (client.lastWebinarAt ?? '') === (row.lastWebinarAt ?? '')
    && (client.nextWebinarAt ?? '') === (row.nextWebinarAt ?? '')
    && client.webinarsHosted === row.webinarsHosted
    && (client.clickUpStatus ?? '') === (row.clickUpStatus ?? '')
}

export function classifyClickUpImport(rows: ClickUpRenewalRow[], clients: RenewalClient[]) {
  let create = 0
  let update = 0
  let unchanged = 0
  rows.forEach((row) => {
    const existing = clients.find((client) => client.clickUpTaskId === row.clickUpTaskId)
      ?? (row.email ? clients.find((client) => client.email?.toLowerCase() === row.email) : undefined)
    if (!existing) create += 1
    else if (sourceFieldsMatch(existing, row)) unchanged += 1
    else update += 1
  })
  return { create, update, unchanged }
}
