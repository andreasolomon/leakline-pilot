import type { CallRecord, ClickUpCredential, ClickUpRenewalRow, CoachingParticipantRecord, CoachingSessionRecord, DatasetImport, FathomCredential, GoogleCredential, HighLevelCredential, HighLevelOpportunitySyncRecord, HighLevelPipelineStageRecord, NormalizedRow, QuoCredential, StripeCredential, WhopCredential, ZoomCredential } from './types.js'

type Fetcher = typeof fetch
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function dataset(kind: DatasetImport['kind'], provider: string, rows: NormalizedRow[]): DatasetImport {
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return { kind, fileName: `${provider} live sync`, rows, sourceRows: rows.length, issues: [], mappedFields: fields, headers: fields, mapping: Object.fromEntries(fields.map((field) => [field, field])) }
}

async function jsonRequest<T>(url: string, init: RequestInit, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, init)
  const body = await response.text()
  if (!response.ok) {
    let message = body.slice(0, 300)
    try { message = (JSON.parse(body) as { error?: { message?: string }; message?: string }).error?.message ?? (JSON.parse(body) as { message?: string }).message ?? message } catch { /* Keep response text. */ }
    throw new Error(`${response.status} ${message || response.statusText}`)
  }
  return body ? JSON.parse(body) as T : {} as T
}

function retryAfterSeconds(response: Response) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(1, seconds)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000))
  }
  const reset = Number(response.headers.get('ratelimit-reset'))
  return Number.isFinite(reset) && reset > 0 ? Math.max(1, reset) : 60
}

async function fathomRequest<T>(url: string, apiKey: string, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, { headers: { 'X-Api-Key': apiKey } })
  const body = await response.text()
  if (response.status === 429) {
    const waitSeconds = retryAfterSeconds(response)
    throw new Error(`Fathom is rate limiting transcript/summary imports. Wait about ${waitSeconds} seconds, then click Sync now again. Leakline saved the connection and will continue from a slower sync path.`)
  }
  if (!response.ok) {
    let message = body.slice(0, 300)
    try { message = (JSON.parse(body) as { error?: { message?: string }; message?: string }).error?.message ?? (JSON.parse(body) as { message?: string }).message ?? message } catch { /* Keep response text. */ }
    throw new Error(`${response.status} ${message || response.statusText}`)
  }
  return body ? JSON.parse(body) as T : {} as T
}

const stripeHeaders = (secretKey: string) => ({ Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` })

async function stripeList<T>(path: string, secretKey: string, fetcher: Fetcher) {
  const items: T[] = []
  let startingAfter = ''
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.stripe.com/v1/${path}`)
    url.searchParams.set('limit', '100')
    if (startingAfter) url.searchParams.set('starting_after', startingAfter)
    const result = await jsonRequest<{ data: Array<T & { id: string }>; has_more: boolean }>(url.toString(), { headers: stripeHeaders(secretKey) }, fetcher)
    items.push(...result.data)
    if (!result.has_more || !result.data.length) break
    startingAfter = result.data.at(-1)?.id ?? ''
  }
  return items
}

export async function validateStripe(credential: StripeCredential, fetcher: Fetcher = fetch) {
  await jsonRequest<{ data: unknown[] }>('https://api.stripe.com/v1/charges?limit=1', { headers: stripeHeaders(credential.secretKey) }, fetcher)
  return { accountLabel: 'Stripe account' }
}

export async function syncStripe(credential: StripeCredential, fetcher: Fetcher = fetch) {
  type StripeRef = string | { id: string; last_payment_error?: { code?: string; decline_code?: string; message?: string } }
  type Charge = { id: string; amount: number; amount_refunded: number; currency: string; created: number; paid: boolean; status: string; failure_code?: string; failure_message?: string; payment_intent?: StripeRef; invoice?: string; customer?: string; metadata?: Record<string, string>; billing_details?: { name?: string; email?: string; phone?: string } }
  type Invoice = { id: string; status: string; amount_due: number; amount_paid: number; amount_remaining: number; currency: string; created: number; due_date?: number; customer?: string; customer_name?: string; customer_email?: string; attempt_count?: number; next_payment_attempt?: number; hosted_invoice_url?: string; payment_intent?: StripeRef; charge?: string; metadata?: Record<string, string>; status_transitions?: { paid_at?: number } }
  const [charges, invoices] = await Promise.all([
    stripeList<Charge>('charges', credential.secretKey, fetcher),
    stripeList<Invoice>('invoices', credential.secretKey, fetcher),
  ])
  const rows: NormalizedRow[] = []
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id))
  charges.forEach((charge) => {
    const paidAt = new Date(charge.created * 1000).toISOString()
    const customer = charge.billing_details?.name ?? charge.billing_details?.email ?? 'Stripe customer'
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
    const dealId = charge.metadata?.opportunity_id ?? charge.metadata?.deal_id ?? paymentIntentId ?? null
    const base = { id: charge.id, payment_provider: 'stripe', invoice_id: charge.invoice ?? null, payment_intent_id: paymentIntentId ?? null, customer_id: charge.customer ?? null, customer, customer_email: charge.billing_details?.email ?? null, customer_phone: charge.billing_details?.phone ?? null, deal_id: dealId, amount: charge.amount / 100, currency: charge.currency.toUpperCase(), due_at: paidAt }
    if (!charge.invoice || !invoiceIds.has(charge.invoice)) {
      if (charge.paid) rows.push({ ...base, status: 'paid', paid_at: paidAt })
      else rows.push({ ...base, status: 'failed', paid_at: null, failure_code: charge.failure_code ?? null, failure_reason: charge.failure_message ?? null })
    }
    if (charge.amount_refunded > 0) rows.push({ id: `${charge.id}_refund`, deal_id: dealId, customer, amount: charge.amount_refunded / 100, currency: charge.currency.toUpperCase(), status: 'refunded', due_at: paidAt, paid_at: paidAt })
  })
  invoices.forEach((invoice) => {
    const paymentIntentId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id
    const error = typeof invoice.payment_intent === 'object' ? invoice.payment_intent.last_payment_error : undefined
    const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null
    const dueAt = invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : new Date(invoice.created * 1000).toISOString()
    const isPaid = invoice.status === 'paid'
    const amount = (isPaid ? invoice.amount_paid || invoice.amount_due : invoice.amount_remaining || invoice.amount_due) / 100
    rows.push({
      id: invoice.id,
      payment_provider: 'stripe',
      invoice_id: invoice.id,
      payment_intent_id: paymentIntentId ?? null,
      customer_id: invoice.customer ?? null,
      deal_id: invoice.metadata?.opportunity_id ?? invoice.metadata?.deal_id ?? null,
      customer: invoice.customer_name ?? invoice.customer_email ?? 'Stripe customer',
      customer_email: invoice.customer_email ?? null,
      amount,
      currency: invoice.currency.toUpperCase(),
      status: isPaid ? 'paid' : invoice.status === 'open' && Date.parse(dueAt) < Date.now() ? 'overdue' : invoice.status === 'open' ? 'pending' : invoice.status,
      due_at: dueAt,
      paid_at: paidAt,
      failure_code: error?.decline_code ?? error?.code ?? null,
      failure_reason: error?.message ?? null,
      attempt_count: invoice.attempt_count ?? 0,
      next_retry_at: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000).toISOString() : null,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    })
  })
  return dataset('payments', 'Stripe', rows)
}

type ClickUpCustomField = {
  id: string
  name: string
  type?: string
  value?: unknown
  type_config?: { options?: Array<{ id?: string; name?: string; label?: string; orderindex?: number }> }
}

type ClickUpTask = {
  id: string
  name: string
  status?: { status?: string }
  custom_fields?: ClickUpCustomField[]
}

const clickUpHeaders = (apiToken: string) => ({ Authorization: apiToken, Accept: 'application/json' })
const normaliseClickUpField = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

function clickUpFieldValue(field: ClickUpCustomField | undefined) {
  if (!field || field.value === undefined || field.value === null) return ''
  if (field.type === 'drop_down') {
    const selected = field.type_config?.options?.find((option) => option.id === String(field.value) || String(option.orderindex) === String(field.value))
    return selected?.name ?? selected?.label ?? String(field.value)
  }
  if (Array.isArray(field.value)) return field.value.map(String).join(', ')
  return String(field.value)
}

function clickUpDate(value: string) {
  if (!value.trim()) return undefined
  const numeric = Number(value)
  const timestamp = Number.isFinite(numeric) && numeric > 10_000_000_000 ? numeric : Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : undefined
}

function normalisePhone(value: string) {
  const raw = value.trim()
  if (!raw) return undefined
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return undefined
}

function clickUpTaskRow(task: ClickUpTask, now = new Date()): ClickUpRenewalRow {
  const fields = new Map((task.custom_fields ?? []).map((field) => [normaliseClickUpField(field.name), field]))
  const field = (...names: string[]) => names.map((name) => fields.get(name)).find(Boolean)
  const emailValue = clickUpFieldValue(field('email_short_text', 'email')).trim().toLowerCase()
  const phoneValue = clickUpFieldValue(field('phone_short_text', 'phone', 'phone_number'))
  const today = now.toISOString().slice(0, 10)
  const completedDates = [...fields.entries()]
    .filter(([name]) => /^webinar_\d+(?:_date)?$/.test(name))
    .map(([, value]) => clickUpDate(clickUpFieldValue(value)))
    .filter((value): value is string => typeof value === 'string' && value <= today)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort()
  const futureDates = [...fields.entries()]
    .filter(([name]) => name === 'webinar_next_date' || name === 'webinar_next' || /^webinar_\d+(?:_date)?$/.test(name))
    .map(([, value]) => clickUpDate(clickUpFieldValue(value)))
    .filter((value): value is string => typeof value === 'string' && value > today)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort()
  return {
    clickUpTaskId: task.id,
    name: task.name.trim(),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue) ? emailValue : undefined,
    phone: normalisePhone(phoneValue),
    firstWebinarAt: completedDates[0],
    lastWebinarAt: completedDates.at(-1),
    nextWebinarAt: futureDates[0],
    webinarsHosted: completedDates.length,
    clickUpStatus: clickUpFieldValue(field('z_webinar_plan_status_z_drop_down', 'webinar_plan_status')) || task.status?.status,
  }
}

export async function validateClickUp(credential: ClickUpCredential, fetcher: Fetcher = fetch) {
  const list = await jsonRequest<{ id?: string; name?: string }>(`https://api.clickup.com/api/v2/list/${encodeURIComponent(credential.listId)}`, { headers: clickUpHeaders(credential.apiToken) }, fetcher)
  return { accountLabel: list.name ? `${list.name} · ${credential.listId}` : `ClickUp list ${credential.listId}` }
}

export async function syncClickUp(credential: ClickUpCredential, fetcher: Fetcher = fetch) {
  const tasks: ClickUpTask[] = []
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(`https://api.clickup.com/api/v2/list/${encodeURIComponent(credential.listId)}/task`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('include_closed', 'true')
    url.searchParams.set('subtasks', 'false')
    const result = await jsonRequest<{ tasks?: ClickUpTask[] }>(url.toString(), { headers: clickUpHeaders(credential.apiToken) }, fetcher)
    const batch = result.tasks ?? []
    tasks.push(...batch)
    if (batch.length < 100) break
  }
  return tasks.filter((task) => task.id && task.name?.trim()).map((task) => clickUpTaskRow(task))
}

type QuoPhoneNumber = {
  id: string
  name?: string
  number?: string
  formattedNumber?: string
}

const quoHeaders = (apiKey: string) => ({ Authorization: apiKey, Accept: 'application/json' })

export async function validateQuo(credential: QuoCredential, fetcher: Fetcher = fetch) {
  const result = await jsonRequest<{ data?: QuoPhoneNumber[] }>('https://api.quo.com/v1/phone-numbers', { headers: quoHeaders(credential.apiKey) }, fetcher)
  const phone = (result.data ?? []).find((item) => item.number === credential.from || item.formattedNumber === credential.from)
  if (!phone) throw new Error('The sending number was not found in this Quo workspace. Use the full number including country code, for example +15551234567.')
  return { accountLabel: `${phone.name || 'Quo'} · ${credential.from}`, phoneNumberId: phone.id }
}

export async function sendQuoMessage(credential: QuoCredential, input: { to: string; body: string }, fetcher: Fetcher = fetch) {
  const result = await jsonRequest<{ data?: { id?: string; conversationId?: string } }>('https://api.quo.com/v1/messages', {
    method: 'POST',
    headers: { ...quoHeaders(credential.apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: input.body, from: credential.from, to: [input.to] }),
  }, fetcher)
  return { messageId: result.data?.id, conversationId: result.data?.conversationId }
}

export type QuoConversationMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  status: string
  createdAt: string
  conversationId?: string
}

export async function listQuoMessages(credential: QuoCredential, participant: string, fetcher: Fetcher = fetch): Promise<QuoConversationMessage[]> {
  let phoneNumberId = credential.phoneNumberId
  if (!phoneNumberId) phoneNumberId = (await validateQuo(credential, fetcher)).phoneNumberId
  const url = new URL('https://api.quo.com/v1/messages')
  url.searchParams.set('phoneNumberId', phoneNumberId)
  url.searchParams.append('participants', participant)
  url.searchParams.set('maxResults', '100')
  const result = await jsonRequest<{ data?: Array<{ id?: string; from?: string; to?: string[]; text?: string; content?: string; direction?: string; status?: string; createdAt?: string; conversationId?: string }> }>(url.toString(), { headers: quoHeaders(credential.apiKey) }, fetcher)
  return (result.data ?? []).filter((message) => message.id && (message.text || message.content)).map((message) => ({
    id: message.id!,
    direction: message.from === credential.from || message.direction === 'outgoing' || message.direction === 'outbound' ? 'outbound' as const : 'inbound' as const,
    body: message.text || message.content || '',
    status: message.status || 'unknown',
    createdAt: message.createdAt || new Date(0).toISOString(),
    conversationId: message.conversationId,
  })).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

type WhopPayment = {
  id: string
  status?: string | null
  substatus?: string
  retryable?: boolean
  created_at: string
  updated_at?: string
  paid_at?: string | null
  last_payment_attempt?: string | null
  next_payment_attempt?: string | null
  currency?: string | null
  total?: number | null
  usd_total?: number | null
  payments_failed?: number | null
  failure_message?: string | null
  metadata?: Record<string, unknown>
  user?: Record<string, unknown> | null
  member?: Record<string, unknown> | null
  membership?: Record<string, unknown> | null
}

const whopBaseUrl = (sandbox: boolean) => sandbox ? 'https://sandbox-api.whop.com/api/v1' : 'https://api.whop.com/api/v1'
const whopHeaders = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, Accept: 'application/json' })

function whopPaymentRow(payment: WhopPayment): NormalizedRow {
  const user = payment.user ?? payment.member ?? {}
  const membership = payment.membership ?? {}
  const firstName = String(user.first_name ?? user.firstName ?? '')
  const lastName = String(user.last_name ?? user.lastName ?? '')
  const customer = String(user.name || `${firstName} ${lastName}`.trim() || user.username || user.email || 'Whop customer')
  const substatus = String(payment.substatus ?? payment.status ?? '').toLowerCase()
  const status = substatus === 'succeeded' ? 'paid' : substatus === 'past_due' ? 'overdue' : substatus === 'failed' || payment.status === 'open' ? 'failed' : substatus
  return {
    id: payment.id,
    invoice_id: payment.id,
    payment_provider: 'whop',
    customer_id: String(user.id ?? membership.id ?? ''),
    customer,
    customer_email: String(user.email ?? ''),
    customer_phone: String(user.phone ?? user.phone_number ?? ''),
    deal_id: String(payment.metadata?.opportunity_id ?? payment.metadata?.deal_id ?? ''),
    amount: Number(payment.total ?? payment.usd_total ?? 0),
    currency: String(payment.currency ?? 'usd').toUpperCase(),
    status,
    due_at: payment.last_payment_attempt ?? payment.created_at,
    paid_at: payment.paid_at ?? null,
    failure_reason: payment.failure_message ?? null,
    attempt_count: Number(payment.payments_failed ?? 0),
    next_retry_at: payment.next_payment_attempt ?? null,
    retryable: Boolean(payment.retryable),
    hosted_invoice_url: String(membership.manage_url ?? membership.manageUrl ?? ''),
  }
}

export async function validateWhop(credential: WhopCredential, fetcher: Fetcher = fetch) {
  const url = new URL(`${whopBaseUrl(credential.sandbox)}/payments`)
  url.searchParams.set('company_id', credential.companyId)
  url.searchParams.set('first', '1')
  await jsonRequest<{ data: WhopPayment[] }>(url.toString(), { headers: whopHeaders(credential.apiKey) }, fetcher)
  return { accountLabel: `${credential.companyId}${credential.sandbox ? ' · sandbox' : ''}` }
}

export async function syncWhop(credential: WhopCredential, fetcher: Fetcher = fetch) {
  const rows: NormalizedRow[] = []
  let after = ''
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${whopBaseUrl(credential.sandbox)}/payments`)
    url.searchParams.set('company_id', credential.companyId)
    url.searchParams.set('first', '100')
    url.searchParams.set('direction', 'desc')
    url.searchParams.set('order', 'created_at')
    if (after) url.searchParams.set('after', after)
    const result = await jsonRequest<{ data: WhopPayment[]; page_info?: { has_next_page?: boolean; end_cursor?: string } }>(url.toString(), { headers: whopHeaders(credential.apiKey) }, fetcher)
    rows.push(...result.data.map(whopPaymentRow))
    if (!result.page_info?.has_next_page || !result.page_info.end_cursor) break
    after = result.page_info.end_cursor
  }
  return dataset('payments', 'Whop', rows)
}

export function normalizeFanBasisPayment(input: Record<string, unknown>): NormalizedRow {
  const rawStatus = String(input.status ?? '').toLowerCase()
  const status = ['success', 'succeeded', 'complete', 'completed'].includes(rawStatus) ? 'paid'
    : ['declined', 'failure', 'failed'].includes(rawStatus) ? 'failed'
      : ['past_due', 'past due', 'late'].includes(rawStatus) ? 'overdue'
        : rawStatus
  return {
    id: String(input.id ?? input.transaction_id ?? input.payment_id ?? ''),
    invoice_id: String(input.invoice_id ?? input.transaction_id ?? input.payment_id ?? input.id ?? ''),
    payment_provider: 'fanbasis',
    customer_id: String(input.customer_id ?? input.user_id ?? ''),
    customer: String(input.customer_name ?? input.name ?? input.email ?? 'FanBasis customer'),
    customer_email: String(input.customer_email ?? input.email ?? ''),
    customer_phone: String(input.customer_phone ?? input.phone ?? ''),
    deal_id: String(input.opportunity_id ?? input.deal_id ?? ''),
    amount: Number(input.amount ?? input.amount_due ?? 0),
    currency: String(input.currency ?? 'USD').toUpperCase(),
    status,
    due_at: String(input.due_at ?? input.due_date ?? input.created_at ?? ''),
    paid_at: input.paid_at ? String(input.paid_at) : null,
    failure_code: input.failure_code ? String(input.failure_code) : null,
    failure_reason: input.failure_reason ?? input.failure_message ? String(input.failure_reason ?? input.failure_message) : null,
    attempt_count: Number(input.attempt_count ?? input.payments_failed ?? 0),
    next_retry_at: input.next_retry_at ? String(input.next_retry_at) : null,
    retryable: Boolean(input.retryable),
    hosted_invoice_url: String(input.hosted_invoice_url ?? input.payment_link ?? input.manage_url ?? ''),
  }
}

const highLevelHeaders = (token: string) => ({ Authorization: `Bearer ${token.trim()}`, Accept: 'application/json', Version: '2021-07-28' })

async function highLevelRequest<T>(url: string, init: RequestInit, fetcher: Fetcher): Promise<T> {
  try {
    return await jsonRequest<T>(url, init, fetcher)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/^401\b/.test(message)) {
      throw new Error('GoHighLevel rejected this token. Create a fresh Private Integration Token inside the same sub-account as this Location ID, then try again.')
    }
    if (/^403\b/.test(message)) {
      throw new Error('The GoHighLevel token is missing required read permissions. Enable Contacts, Opportunities and Users read access for this Private Integration, then try again.')
    }
    throw error
  }
}

async function highLevelList<T>(initialUrl: string, key: string, headers: Record<string, string>, fetcher: Fetcher) {
  const items: T[] = []
  let url = initialUrl
  for (let page = 0; page < 20 && url; page += 1) {
    const result = await jsonRequest<Record<string, unknown>>(url, { headers }, fetcher)
    items.push(...((result[key] as T[] | undefined) ?? []))
    const meta = result.meta as { nextPageUrl?: string } | undefined
    url = meta?.nextPageUrl ?? ''
  }
  return items
}

export async function validateHighLevel(credential: HighLevelCredential, fetcher: Fetcher = fetch) {
  const headers = highLevelHeaders(credential.accessToken)
  const rawLocationId = credential.locationId.trim()
  const locationId = encodeURIComponent(rawLocationId)
  await Promise.all([
    highLevelRequest(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`, { headers }, fetcher),
    highLevelRequest(`https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&limit=1`, { headers }, fetcher),
    highLevelRequest(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers }, fetcher),
    highLevelRequest(`https://services.leadconnectorhq.com/users/?locationId=${locationId}`, { headers }, fetcher),
  ])
  return { accountLabel: `GoHighLevel sub-account · ${rawLocationId}` }
}

export async function syncHighLevel(credential: HighLevelCredential, fetcher: Fetcher = fetch) {
  const headers = highLevelHeaders(credential.accessToken)
  const locationId = encodeURIComponent(credential.locationId.trim())
  const [contacts, opportunities, pipelineResult, userResult] = await Promise.all([
    highLevelList<Record<string, unknown>>(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`, 'contacts', headers, fetcher),
    highLevelList<Record<string, unknown>>(`https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&limit=100`, 'opportunities', headers, fetcher),
    jsonRequest<{ pipelines?: Array<{ id?: string; name?: string; stages?: Array<{ id: string; name: string }> }> }>(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers }, fetcher),
    jsonRequest<{ users?: Array<Record<string, unknown>> }>(`https://services.leadconnectorhq.com/users/?locationId=${locationId}`, { headers }, fetcher),
  ])
  const stageCatalog: HighLevelPipelineStageRecord[] = (pipelineResult.pipelines ?? []).flatMap((pipeline) => (pipeline.stages ?? []).map((stage) => ({
    pipelineId: String(pipeline.id ?? ''),
    pipelineName: String(pipeline.name ?? 'Unnamed pipeline'),
    stageId: String(stage.id ?? ''),
    stageName: String(stage.name ?? 'Unnamed stage'),
  })))
  const stages = new Map(stageCatalog.map((stage) => [stage.stageId, stage]))
  const users = userResult.users ?? []
  const userNames = new Map(users.map((user) => {
    const name = String(user.name ?? '').trim() || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || String(user.email ?? 'Unassigned')
    return [String(user.id ?? ''), name]
  }))
  const leads = contacts.map((contact) => ({ id: String(contact.id ?? ''), name: String(contact.contactName ?? contact.name ?? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()), email: String(contact.email ?? ''), phone: String(contact.phone ?? ''), source: String(contact.source ?? 'GoHighLevel'), status: String(contact.type ?? 'new'), owner: userNames.get(String(contact.assignedTo ?? '')) ?? 'Unassigned', created_at: String(contact.dateAdded ?? contact.createdAt ?? ''), last_activity_at: String(contact.dateUpdated ?? contact.updatedAt ?? '') || null }))
  const deals = opportunities.map((opportunity) => {
    const status = String(opportunity.status ?? 'open').toLowerCase()
    const contact = opportunity.contact as Record<string, unknown> | undefined
    const stage = stages.get(String(opportunity.pipelineStageId ?? ''))
    return { id: String(opportunity.id ?? ''), lead_id: String(opportunity.contactId ?? ''), name: String(opportunity.name ?? contact?.name ?? 'Opportunity'), stage: status === 'won' ? 'closed won' : status === 'lost' ? 'closed lost' : stage?.stageName ?? status, stage_name: stage?.stageName ?? status, pipeline_id: String(opportunity.pipelineId ?? stage?.pipelineId ?? ''), pipeline_name: stage?.pipelineName ?? '', pipeline_stage_id: String(opportunity.pipelineStageId ?? ''), value: Number(opportunity.monetaryValue ?? opportunity.value ?? 0), owner: userNames.get(String(opportunity.assignedTo ?? '')) ?? 'Unassigned', status, created_at: String(opportunity.createdAt ?? opportunity.dateAdded ?? ''), updated_at: String(opportunity.lastStatusChangeAt ?? opportunity.updatedAt ?? ''), next_action: null }
  })
  const closerRows = users.map((user) => {
    const name = userNames.get(String(user.id ?? '')) ?? 'Unknown user'
    const owned = deals.filter((deal) => deal.owner === name)
    const won = owned.filter((deal) => deal.stage === 'closed won').length
    return { id: String(user.id ?? ''), name, email: String(user.email ?? ''), calls: 0, close_rate: owned.length ? Math.round(won / owned.length * 1000) / 10 : 0, active: !user.deleted }
  })
  const kpiOpportunities: HighLevelOpportunitySyncRecord[] = opportunities.map((opportunity) => {
    const contact = opportunity.contact as Record<string, unknown> | undefined
    const stage = stages.get(String(opportunity.pipelineStageId ?? ''))
    return {
      opportunityId: String(opportunity.id ?? ''),
      contactId: String(opportunity.contactId ?? ''),
      personName: String(contact?.name ?? opportunity.name ?? 'Unnamed lead'),
      owner: userNames.get(String(opportunity.assignedTo ?? '')) ?? 'Unassigned',
      pipelineId: String(opportunity.pipelineId ?? stage?.pipelineId ?? ''),
      stageId: String(opportunity.pipelineStageId ?? ''),
      stageName: stage?.stageName ?? String(opportunity.status ?? 'Unknown stage'),
      status: String(opportunity.status ?? 'open').toLowerCase(),
      value: Number(opportunity.monetaryValue ?? opportunity.value ?? 0),
      enteredAt: String(opportunity.createdAt ?? opportunity.dateAdded ?? ''),
      changedAt: String(opportunity.lastStatusChangeAt ?? opportunity.updatedAt ?? opportunity.createdAt ?? ''),
    }
  })
  return { leads: dataset('leads', 'GoHighLevel', leads), deals: dataset('deals', 'GoHighLevel', deals), closers: dataset('closers', 'GoHighLevel', closerRows), highLevelKpi: { stages: stageCatalog, opportunities: kpiOpportunities } }
}

export async function sendHighLevelMessage(credential: HighLevelCredential, input: { contactId: string; channel: 'sms' | 'email'; body: string; subject?: string; fromEmail?: string; fromNumber?: string }, fetcher: Fetcher = fetch) {
  const emailHtml = input.body.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!).replace(/\n/g, '<br>')
  const payload = input.channel === 'sms'
    ? { type: 'SMS', contactId: input.contactId, message: input.body, status: 'pending', ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}) }
    : { type: 'Email', contactId: input.contactId, subject: input.subject ?? 'Follow-up', html: emailHtml, message: input.body, status: 'pending', ...(input.fromEmail ? { emailFrom: input.fromEmail } : {}) }
  const result = await jsonRequest<{ messageId?: string; conversationId?: string; id?: string }>('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: { ...highLevelHeaders(credential.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, fetcher)
  return { messageId: result.messageId ?? result.id, conversationId: result.conversationId }
}

export const sendHighLevelRecoveryMessage = sendHighLevelMessage

async function validGoogleToken(credential: GoogleCredential, clientId: string, clientSecret: string, fetcher: Fetcher) {
  if (credential.expiresAt > Date.now() + 60_000) return credential
  if (!credential.refreshToken) throw new Error('Google access expired and no refresh token is available. Reconnect Google Calendar.')
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: credential.refreshToken, grant_type: 'refresh_token' })
  const token = await jsonRequest<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, fetcher)
  return { ...credential, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 }
}

export async function syncGoogleCalendar(credential: GoogleCredential, clientId: string, clientSecret: string, fetcher: Fetcher = fetch) {
  const fresh = await validGoogleToken(credential, clientId, clientSecret, fetcher)
  const events: Array<Record<string, any>> = []
  let pageToken = ''
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '2500')
    url.searchParams.set('timeMin', new Date(Date.now() - 90 * 86400000).toISOString())
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const result = await jsonRequest<{ items?: Array<Record<string, any>>; nextPageToken?: string }>(url.toString(), { headers: { Authorization: `Bearer ${fresh.accessToken}` } }, fetcher)
    events.push(...(result.items ?? []))
    pageToken = result.nextPageToken ?? ''
    if (!pageToken) break
  }
  const rows = events.filter((event) => event.status !== 'cancelled' && event.start?.dateTime).map((event) => {
    const external = (event.attendees ?? []).find((attendee: Record<string, unknown>) => !attendee.self)
    return { id: String(event.id ?? ''), lead_id: String(event.extendedProperties?.private?.lead_id ?? ''), email: String(external?.email ?? ''), start_at: String(event.start.dateTime), status: String(event.extendedProperties?.private?.attendance_status ?? 'booked'), source: 'Google Calendar', closer: String(event.organizer?.displayName ?? event.organizer?.email ?? '') }
  })
  return { credential: fresh, appointments: dataset('appointments', 'Google Calendar', rows) }
}

export async function validateFathom(credential: FathomCredential, fetcher: Fetcher = fetch) {
  const result = await jsonRequest<{ items?: Array<{ recorded_by?: { name?: string; email?: string } }> }>('https://api.fathom.ai/external/v1/meetings?limit=1', { headers: { 'X-Api-Key': credential.apiKey } }, fetcher)
  const owner = result.items?.[0]?.recorded_by
  return { accountLabel: owner?.name ?? owner?.email ?? 'Fathom account' }
}

export async function syncFathom(credential: FathomCredential, fetcher: Fetcher = fetch): Promise<CallRecord[]> {
  const calls: CallRecord[] = []
  let cursor = ''
  const pageLimit = Math.max(1, Math.min(Number(process.env.FATHOM_SYNC_PAGE_LIMIT ?? 3), 10))
  for (let page = 0; page < pageLimit; page += 1) {
    const url = new URL('https://api.fathom.ai/external/v1/meetings')
    url.searchParams.set('limit', String(Math.max(1, Math.min(Number(process.env.FATHOM_SYNC_PAGE_SIZE ?? 25), 100))))
    url.searchParams.set('include_transcript', 'true')
    url.searchParams.set('include_summary', 'true')
    if (cursor) url.searchParams.set('cursor', cursor)
    if (page > 0) await sleep(Math.max(0, Number(process.env.FATHOM_SYNC_DELAY_MS ?? 1250)))
    const result = await fathomRequest<{ items?: Array<Record<string, any>>; next_cursor?: string }>(url.toString(), credential.apiKey, fetcher)
    for (const meeting of result.items ?? []) calls.push({
      id: String(meeting.recording_id ?? meeting.id ?? meeting.url ?? `${meeting.title}-${meeting.created_at}`),
      title: String(meeting.title ?? meeting.meeting_title ?? 'Fathom meeting'),
      startedAt: String(meeting.recording_start_time ?? meeting.scheduled_start_time ?? meeting.created_at ?? '') || null,
      owner: String(meeting.recorded_by?.name ?? meeting.recorded_by?.email ?? ''),
      participants: (meeting.calendar_invitees ?? []).map((invitee: Record<string, unknown>) => String(invitee.email ?? invitee.name ?? '')).filter(Boolean),
      transcript: (meeting.transcript ?? []).map((segment: Record<string, any>) => `${segment.speaker?.display_name ?? 'Speaker'}: ${segment.text ?? ''}`).join('\n'),
      summary: String(meeting.default_summary?.markdown_formatted ?? ''),
      url: String(meeting.share_url ?? meeting.url ?? ''),
    })
    cursor = result.next_cursor ?? ''
    if (!cursor) break
  }
  return calls
}

async function zoomAccessToken(credential: ZoomCredential, fetcher: Fetcher) {
  const body = new URLSearchParams({ grant_type: 'account_credentials', account_id: credential.accountId.trim() })
  const token = await jsonRequest<{ access_token: string }>('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credential.clientId.trim()}:${credential.clientSecret.trim()}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, fetcher)
  if (!token.access_token) throw new Error('Zoom did not return an access token. Check that the Server-to-Server OAuth app is active.')
  return token.access_token
}

const zoomHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` })

export async function validateZoom(credential: ZoomCredential, fetcher: Fetcher = fetch, meetingIds?: string | string[]) {
  const accessToken = await zoomAccessToken(credential, fetcher)
  const cleanMeetingIds = (Array.isArray(meetingIds) ? meetingIds : meetingIds ? [meetingIds] : []).map((meetingId) => meetingId.replace(/\D/g, ''))
  for (const meetingId of cleanMeetingIds) await jsonRequest(`https://api.zoom.us/v2/past_meetings/${encodeURIComponent(meetingId)}/instances`, { headers: zoomHeaders(accessToken) }, fetcher)
  return { accountLabel: cleanMeetingIds.length ? `${cleanMeetingIds.length} Zoom coaching series` : 'Zoom account' }
}

function zoomMeetingUuid(uuid: string) {
  const encoded = encodeURIComponent(uuid)
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(encoded) : encoded
}

export async function syncZoomCoachingAttendance(credential: ZoomCredential, meetingId: string, fetcher: Fetcher = fetch, topic = 'Coaching call'): Promise<CoachingSessionRecord[]> {
  const accessToken = await zoomAccessToken(credential, fetcher)
  const headers = zoomHeaders(accessToken)
  const cleanMeetingId = meetingId.replace(/\D/g, '')
  if (cleanMeetingId.length < 9) throw new Error('Enter the recurring Zoom meeting ID, not the full meeting link.')
  const instanceResult = await jsonRequest<{ meetings?: Array<{ uuid?: string; start_time?: string }> }>(`https://api.zoom.us/v2/past_meetings/${encodeURIComponent(cleanMeetingId)}/instances`, { headers }, fetcher)
  const sessions: CoachingSessionRecord[] = []
  for (const instance of (instanceResult.meetings ?? []).slice(-60)) {
    if (!instance.uuid || !instance.start_time) continue
    const participants: CoachingParticipantRecord[] = []
    let nextPageToken = ''
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`https://api.zoom.us/v2/past_meetings/${zoomMeetingUuid(instance.uuid)}/participants`)
      url.searchParams.set('page_size', '300')
      if (nextPageToken) url.searchParams.set('next_page_token', nextPageToken)
      const result = await jsonRequest<{ participants?: Array<{ id?: string; user_id?: string; name?: string; user_name?: string; user_email?: string; email?: string; join_time?: string; leave_time?: string; duration?: number }>; next_page_token?: string }>(url.toString(), { headers }, fetcher)
      for (const participant of result.participants ?? []) participants.push({
        id: String(participant.id ?? participant.user_id ?? `${participant.user_email ?? participant.email ?? participant.name}-${participant.join_time ?? participants.length}`),
        name: String(participant.name ?? participant.user_name ?? participant.user_email ?? participant.email ?? 'Unknown attendee'),
        email: String(participant.user_email ?? participant.email ?? '').trim().toLowerCase() || undefined,
        joinTime: participant.join_time,
        leaveTime: participant.leave_time,
        durationMinutes: Math.max(0, Math.round(Number(participant.duration ?? 0) / 60)),
        matchType: 'unmatched',
      })
      nextPageToken = result.next_page_token ?? ''
      if (!nextPageToken) break
    }
    sessions.push({
      id: `${cleanMeetingId}:${instance.uuid}`,
      meetingId: cleanMeetingId,
      topic,
      startedAt: instance.start_time,
      participants,
      syncedAt: new Date().toISOString(),
    })
  }
  return sessions
}
