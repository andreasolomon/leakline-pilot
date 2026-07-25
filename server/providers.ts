import type { CallRecord, DatasetImport, FathomCredential, GoogleCredential, HighLevelCredential, NormalizedRow, StripeCredential, WhopCredential } from './types.js'

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

const highLevelHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', Version: '2021-07-28' })

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
  const location = await jsonRequest<{ location?: { name?: string }; name?: string }>(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(credential.locationId)}`, { headers: highLevelHeaders(credential.accessToken) }, fetcher)
  return { accountLabel: location.location?.name ?? location.name ?? credential.locationId }
}

export async function syncHighLevel(credential: HighLevelCredential, fetcher: Fetcher = fetch) {
  const headers = highLevelHeaders(credential.accessToken)
  const locationId = encodeURIComponent(credential.locationId)
  const [contacts, opportunities, pipelineResult, userResult] = await Promise.all([
    highLevelList<Record<string, unknown>>(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`, 'contacts', headers, fetcher),
    highLevelList<Record<string, unknown>>(`https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&limit=100`, 'opportunities', headers, fetcher),
    jsonRequest<{ pipelines?: Array<{ stages?: Array<{ id: string; name: string }> }> }>(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers }, fetcher),
    jsonRequest<{ users?: Array<Record<string, unknown>> }>(`https://services.leadconnectorhq.com/users/?locationId=${locationId}`, { headers }, fetcher),
  ])
  const stages = new Map((pipelineResult.pipelines ?? []).flatMap((pipeline) => pipeline.stages ?? []).map((stage) => [stage.id, stage.name]))
  const users = userResult.users ?? []
  const userNames = new Map(users.map((user) => {
    const name = String(user.name ?? '').trim() || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || String(user.email ?? 'Unassigned')
    return [String(user.id ?? ''), name]
  }))
  const leads = contacts.map((contact) => ({ id: String(contact.id ?? ''), name: String(contact.contactName ?? contact.name ?? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()), email: String(contact.email ?? ''), phone: String(contact.phone ?? ''), source: String(contact.source ?? 'GoHighLevel'), status: String(contact.type ?? 'new'), owner: userNames.get(String(contact.assignedTo ?? '')) ?? 'Unassigned', created_at: String(contact.dateAdded ?? contact.createdAt ?? ''), last_activity_at: String(contact.dateUpdated ?? contact.updatedAt ?? '') || null }))
  const deals = opportunities.map((opportunity) => {
    const status = String(opportunity.status ?? 'open').toLowerCase()
    const contact = opportunity.contact as Record<string, unknown> | undefined
    return { id: String(opportunity.id ?? ''), lead_id: String(opportunity.contactId ?? ''), name: String(opportunity.name ?? contact?.name ?? 'Opportunity'), stage: status === 'won' ? 'closed won' : status === 'lost' ? 'closed lost' : stages.get(String(opportunity.pipelineStageId ?? '')) ?? status, value: Number(opportunity.monetaryValue ?? opportunity.value ?? 0), owner: userNames.get(String(opportunity.assignedTo ?? '')) ?? 'Unassigned', updated_at: String(opportunity.updatedAt ?? opportunity.lastStatusChangeAt ?? ''), next_action: null }
  })
  const closerRows = users.map((user) => {
    const name = userNames.get(String(user.id ?? '')) ?? 'Unknown user'
    const owned = deals.filter((deal) => deal.owner === name)
    const won = owned.filter((deal) => deal.stage === 'closed won').length
    return { id: String(user.id ?? ''), name, email: String(user.email ?? ''), calls: 0, close_rate: owned.length ? Math.round(won / owned.length * 1000) / 10 : 0, active: !user.deleted }
  })
  return { leads: dataset('leads', 'GoHighLevel', leads), deals: dataset('deals', 'GoHighLevel', deals), closers: dataset('closers', 'GoHighLevel', closerRows) }
}

export async function sendHighLevelRecoveryMessage(credential: HighLevelCredential, input: { contactId: string; channel: 'sms' | 'email'; body: string; subject?: string; fromEmail?: string; fromNumber?: string }, fetcher: Fetcher = fetch) {
  const payload = input.channel === 'sms'
    ? { type: 'SMS', contactId: input.contactId, message: input.body, status: 'pending', ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}) }
    : { type: 'Email', contactId: input.contactId, subject: input.subject ?? 'Payment follow-up', html: input.body.replace(/\n/g, '<br>'), message: input.body, status: 'pending', ...(input.fromEmail ? { emailFrom: input.fromEmail } : {}) }
  const result = await jsonRequest<{ messageId?: string; conversationId?: string; id?: string }>('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: { ...highLevelHeaders(credential.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, fetcher)
  return { messageId: result.messageId ?? result.id, conversationId: result.conversationId }
}

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
