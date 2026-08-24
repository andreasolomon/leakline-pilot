import { randomBytes } from 'node:crypto'
import type { NormalizedRow, PaymentProviderId, PaymentRecoveryCaseRecord, PaymentRecoveryClassification, PaymentRecoveryStatus, RecoveryFollowUpRecord, RecoveryPolicyRecord, RecoveryReplyIntent, WorkspaceRecord } from './types.js'
import { explicitSmsOptOutReason } from './safety.js'

const atRiskStatuses = new Set(['failed', 'overdue', 'past due', 'past_due', 'unpaid', 'open'])
const paidStatuses = new Set(['paid', 'succeeded', 'successful'])
const paymentMethodCodes = new Set(['expired_card', 'incorrect_number', 'lost_card', 'stolen_card', 'no_payment_method', 'payment_method_missing'])
const authenticationCodes = new Set(['authentication_required', 'payment_intent_authentication_failure'])

const text = (value: unknown) => String(value ?? '').trim()
const lower = (value: unknown) => text(value).toLowerCase()
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
const iso = (value: unknown) => {
  const raw = text(value)
  const timestamp = Date.parse(raw)
  return raw && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

export function classifyPayment(row: NormalizedRow): PaymentRecoveryClassification {
  const code = lower(row.failure_code)
  const reason = lower(row.failure_reason ?? row.failure_message)
  if (authenticationCodes.has(code) || reason.includes('authentication')) return 'authentication_required'
  if (paymentMethodCodes.has(code) || reason.includes('expired') || reason.includes('payment method')) return 'payment_method_required'
  if (lower(row.manual_review) === 'true' || reason.includes('dispute') || reason.includes('refund') || reason.includes('hardship')) return 'human_review'
  if (iso(row.next_retry_at) || ['insufficient_funds', 'generic_decline', 'do_not_honor', 'processing_error'].includes(code)) return 'retryable_failure'
  return 'secure_payment_link'
}

export function statusForClassification(classification: PaymentRecoveryClassification): PaymentRecoveryStatus {
  if (classification === 'retryable_failure') return 'retry_in_progress'
  if (classification === 'payment_method_required') return 'payment_method_required'
  if (classification === 'authentication_required') return 'authentication_required'
  if (classification === 'human_review') return 'human_intervention'
  return 'secure_payment_link_required'
}

export function recommendedAction(classification: PaymentRecoveryClassification, nextRetryAt?: string, provider = 'payment provider') {
  const providerName = provider === 'stripe' ? 'Stripe' : provider === 'whop' ? 'Whop' : provider === 'fanbasis' ? 'FanBasis' : provider
  if (classification === 'retryable_failure') return nextRetryAt ? `Confirm the customer knows ${providerName} will retry on ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(nextRetryAt))}; send a secure link if they prefer to pay sooner.` : `Send a polite reminder and let ${providerName} manage the authorised retry schedule.`
  if (classification === 'payment_method_required') return 'Send the secure payment-method update link and confirm when the customer has updated their card.'
  if (classification === 'authentication_required') return 'Send the secure authentication link and ask the customer to complete the bank verification step.'
  if (classification === 'human_review') return 'Pause routine collection and assign this account for a personal review before contacting the customer.'
  return 'Send the hosted payment link and ask the customer to confirm the date they will complete payment.'
}

export function classifyRecoveryReply(body: string): { intent: RecoveryReplyIntent; confidence: number; recommendedAction: string; pauseRoutine: boolean } {
  const message = lower(body).replace(/<[^>]*>/g, ' ')
  if (explicitSmsOptOutReason(message)) return { intent: 'opt_out', confidence: 0.99, recommendedAction: 'Confirm the opt-out, stop all recovery messages and update the contact record.', pauseRoutine: true }
  if (/\b(wrong (person|number|email)|not me|don['’]?t know)\b/.test(message)) return { intent: 'wrong_contact', confidence: 0.98, recommendedAction: 'Stop outreach and correct the CRM-to-payment contact match before doing anything else.', pauseRoutine: true }
  if (/\b(dispute|chargeback|refund|cancel the payment)\b/.test(message)) return { intent: 'dispute_or_refund', confidence: 0.97, recommendedAction: 'Pause routine recovery and assign this response for a personal dispute or refund review.', pauseRoutine: true }
  if (/\b(can['’]?t afford|cannot afford|hardship|lost my job|no money|financial difficulty)\b/.test(message)) return { intent: 'hardship', confidence: 0.96, recommendedAction: 'Pause routine recovery and ask an authorised person to review the available payment-term options.', pauseRoutine: true }
  if (/\b(already paid|i paid|payment went through|just paid|sent the payment)\b/.test(message)) return { intent: 'already_paid', confidence: 0.94, recommendedAction: 'Reconcile the payment provider before replying, then close the case if the payment is verified.', pauseRoutine: false }
  if (/\b(send|need|where|share).{0,24}\b(link|invoice)\b|\bpayment link\b/.test(message)) return { intent: 'payment_link', confidence: 0.92, recommendedAction: 'Reply with the verified provider-hosted payment link.', pauseRoutine: false }
  if (/\b(update|change|new|different).{0,20}\b(card|payment method)\b|\bexpired card\b/.test(message)) return { intent: 'payment_method_update', confidence: 0.91, recommendedAction: 'Send the provider-hosted payment-method update page—never collect card details in chat.', pauseRoutine: false }
  if (/\b(retry|try (it|the card) again|charge (it|the card) again)\b/.test(message)) return { intent: 'retry_request', confidence: 0.9, recommendedAction: 'Check the provider retry state and send the secure payment page if the customer wants to pay sooner.', pauseRoutine: false }
  if (/\b(i['’]?ll|i will|can pay|pay (on|by)|tomorrow|friday|monday|next week|payday)\b/.test(message)) return { intent: 'promise_to_pay', confidence: 0.86, recommendedAction: 'Confirm the exact amount and date, then record a promise-to-pay deadline before replying.', pauseRoutine: false }
  if (/\b(why|what is this|don['’]?t understand|how much|what do i owe|invoice details)\b/.test(message)) return { intent: 'payment_question', confidence: 0.82, recommendedAction: 'Review the account context and answer the question without inventing terms or concessions.', pauseRoutine: false }
  return { intent: 'unclear', confidence: 0.45, recommendedAction: 'Review this response manually and clarify what the customer needs before sending anything.', pauseRoutine: false }
}

export function suggestedReplyForIntent(intent: RecoveryReplyIntent, recoveryCase: PaymentRecoveryCaseRecord, policy: RecoveryPolicyRecord) {
  const firstName = recoveryCase.customerName.split(/\s+/)[0] || 'there'
  const link = recoveryCase.hostedPaymentUrl ?? '[secure payment link unavailable]'
  const sender = policy.senderName
  const business = policy.businessName
  const replies: Record<RecoveryReplyIntent, string> = {
    payment_link: `Hi ${firstName}, of course — here is the secure payment link: ${link}. Please let me know once it has gone through or if you have any trouble opening it. — ${sender}, ${business}`,
    promise_to_pay: `Thanks for letting us know, ${firstName}. We can note the payment date on your account. Please confirm the exact date and amount you expect to pay so we can update it correctly. — ${sender}, ${business}`,
    retry_request: `Thanks, ${firstName}. We’ll check the payment-provider retry status. If you would prefer to complete it now, you can use this secure link: ${link}. — ${sender}, ${business}`,
    payment_method_update: `Hi ${firstName}, you can update the payment method securely through this provider-hosted page: ${link}. Please do not send card details in this conversation. — ${sender}, ${business}`,
    payment_question: `Thanks for checking, ${firstName}. We’re reviewing the account details before answering so we do not give you incorrect information. A member of the team will confirm the payment context shortly. — ${sender}, ${business}`,
    hardship: `Thanks for letting us know, ${firstName}. We’ve paused the routine payment reminders and asked the appropriate person to review the account with you. — ${sender}, ${business}`,
    dispute_or_refund: `Thanks for raising this, ${firstName}. We’ve paused the routine payment reminders while the account and your request are reviewed personally. — ${sender}, ${business}`,
    wrong_contact: `Thanks for telling us. We’ll stop these messages and review the contact details on the account. — ${sender}, ${business}`,
    opt_out: `Understood. We’ll stop routine recovery messages to this contact. — ${sender}, ${business}`,
    already_paid: `Thanks for letting us know, ${firstName}. We’re checking the payment provider now and will update the account once the payment is verified. — ${sender}, ${business}`,
    unclear: `Thanks for replying, ${firstName}. Could you clarify what you need help with regarding the outstanding payment? — ${sender}, ${business}`,
  }
  return replies[intent]
}

export function promiseConfirmationDraft(recoveryCase: PaymentRecoveryCaseRecord, policy: RecoveryPolicyRecord, amount: number, dueAt: string) {
  const firstName = recoveryCase.customerName.split(/\s+/)[0] || 'there'
  const amountText = new Intl.NumberFormat('en-US', { style: 'currency', currency: recoveryCase.currency || 'USD', maximumFractionDigits: 2 }).format(amount)
  const dateText = new Intl.DateTimeFormat('en-US', { timeZone: policy.timezone, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(dueAt))
  const link = recoveryCase.hostedPaymentUrl ? ` You can complete it securely here when ready: ${recoveryCase.hostedPaymentUrl}.` : ''
  return `Thanks for confirming, ${firstName}. We’ve recorded your promise to pay ${amountText} by ${dateText}.${link} Please let us know if anything changes before then. — ${policy.senderName}, ${policy.businessName}`
}

export function followUpDraft(recoveryCase: PaymentRecoveryCaseRecord, policy: RecoveryPolicyRecord, followUp: RecoveryFollowUpRecord) {
  const firstName = recoveryCase.customerName.split(/\s+/)[0] || 'there'
  const link = recoveryCase.hostedPaymentUrl ?? '[secure payment link unavailable]'
  if (followUp.kind === 'promise_due') return `Hi ${firstName}, I’m following up on the payment you expected to complete. We have not yet seen it confirmed by the payment provider. Here is the secure link again: ${link}. Please let us know if anything has changed. — ${policy.senderName}, ${policy.businessName}`
  if (followUp.attemptNumber >= 3) return `Hi ${firstName}, this is a final routine follow-up regarding the outstanding instalment. Please use the secure link ${link} or reply today so the team knows how to handle the account. — ${policy.senderName}, ${policy.businessName}`
  if (followUp.attemptNumber === 2) return `Hi ${firstName}, the instalment is still showing as outstanding. Could you confirm when you expect to complete it? You can use the secure payment link here: ${link}. — ${policy.senderName}, ${policy.businessName}`
  return `Hi ${firstName}, just checking that you saw the payment message. You can resolve the instalment securely here: ${link}. Reply if you need any help. — ${policy.senderName}, ${policy.businessName}`
}

export function refreshRecoveryWorkflow(recoveryCase: PaymentRecoveryCaseRecord, policy: RecoveryPolicyRecord, now = new Date().toISOString()) {
  recoveryCase.suggestions ??= []
  recoveryCase.followUps ??= []
  const nowMs = Date.parse(now)
  const terminal = ['recovered', 'closed_unrecovered', 'human_intervention'].includes(recoveryCase.status)
  if (terminal) {
    recoveryCase.followUps = recoveryCase.followUps.map((item) => ['scheduled', 'due'].includes(item.status) ? { ...item, status: 'cancelled', completedAt: now } : item)
    return recoveryCase
  }
  for (const promise of recoveryCase.promises) {
    const dueMs = Date.parse(promise.dueAt) + policy.promiseGraceHours * 3_600_000
    if (promise.status === 'pending' && dueMs <= nowMs) promise.status = 'missed'
    if (promise.status === 'missed' && !recoveryCase.followUps.some((item) => item.kind === 'promise_due' && item.reason.includes(promise.id))) {
      recoveryCase.followUps.push({ id: `follow-up-${promise.id}`, kind: 'promise_due', channel: recoveryCase.customerPhone ? 'sms' : 'email', dueAt: new Date(dueMs).toISOString(), status: dueMs <= nowMs ? 'due' : 'scheduled', attemptNumber: 1, reason: `Promise ${promise.id} passed without a verified payment.`, createdAt: now })
    }
  }
  const outbound = recoveryCase.attempts.filter((item) => item.direction === 'outbound' && item.deliveryStatus !== 'pending' && item.deliveryStatus !== 'failed').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const inbound = recoveryCase.attempts.filter((item) => item.direction === 'inbound').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latestOutbound = outbound[0]
  const latestInbound = inbound[0]
  if (latestOutbound && (!latestInbound || latestInbound.createdAt < latestOutbound.createdAt) && outbound.length < policy.maxTouches) {
    const delay = policy.followUpDelaysHours[Math.min(outbound.length - 1, policy.followUpDelaysHours.length - 1)] ?? 24
    const dueAt = new Date(Date.parse(latestOutbound.createdAt) + delay * 3_600_000).toISOString()
    if (!recoveryCase.followUps.some((item) => item.kind === 'no_response' && item.reason.includes(latestOutbound.id))) recoveryCase.followUps.push({ id: `follow-up-${latestOutbound.id}`, kind: 'no_response', channel: latestOutbound.channel === 'email' ? 'email' : 'sms', dueAt, status: Date.parse(dueAt) <= nowMs ? 'due' : 'scheduled', attemptNumber: outbound.length, reason: `No customer response recorded after ${latestOutbound.id}.`, createdAt: now })
  }
  if (latestInbound && (!latestOutbound || latestInbound.createdAt > latestOutbound.createdAt)) recoveryCase.followUps = recoveryCase.followUps.map((item) => item.kind === 'no_response' && ['scheduled', 'due'].includes(item.status) ? { ...item, status: 'cancelled', completedAt: now } : item)
  recoveryCase.followUps = recoveryCase.followUps.map((item) => item.status === 'scheduled' && Date.parse(item.dueAt) <= nowMs ? { ...item, status: 'due' } : item)
  return recoveryCase
}

function priority(amount: number, dueAt?: string): PaymentRecoveryCaseRecord['priority'] {
  const days = dueAt ? Math.max(0, Math.floor((Date.now() - Date.parse(dueAt)) / 86_400_000)) : 0
  if (amount >= 5_000 || days >= 14) return 'critical'
  if (amount >= 2_000 || days >= 5) return 'high'
  return 'medium'
}

function obligationKey(row: NormalizedRow) {
  return text(row.invoice_id ?? row.source_invoice_id ?? row.id ?? row.payment_intent_id)
}

function paymentIdentity(row: NormalizedRow) {
  return [row.invoice_id, row.source_invoice_id, row.payment_intent_id, row.id].map(text).filter(Boolean)
}

function findContact(workspace: WorkspaceRecord, row: NormalizedRow) {
  const leads = workspace.workspace.leads?.rows ?? []
  const deals = workspace.workspace.deals?.rows ?? []
  const dealId = text(row.deal_id)
  const deal = deals.find((item) => text(item.id) === dealId)
  const email = lower(row.customer_email)
  const customerName = lower(row.customer)
  const lead = leads.find((item) => deal && text(item.id) === text(deal.lead_id))
    ?? leads.find((item) => email && lower(item.email) === email)
    ?? leads.find((item) => customerName && lower(item.name) === customerName)
  return { lead, deal }
}

function isProtectedStatus(status: PaymentRecoveryStatus) {
  return status === 'promise_pending' || status === 'human_intervention' || status === 'closed_unrecovered'
}

export function reconcilePaymentRecoveryCases(workspace: WorkspaceRecord, now = new Date().toISOString()) {
  const rows = workspace.workspace.payments?.rows ?? []
  const atRisk = rows.filter((row) => atRiskStatuses.has(lower(row.status)) || (!row.paid_at && iso(row.due_at) && Date.parse(String(row.due_at)) < Date.now()))
  const paid = rows.filter((row) => paidStatuses.has(lower(row.status)) || Boolean(row.paid_at))
  const outstandingByCustomer = new Map<string, number>()
  for (const row of atRisk) {
    const key = lower(row.customer_id ?? row.customer_email ?? row.customer ?? row.deal_id)
    outstandingByCustomer.set(key, (outstandingByCustomer.get(key) ?? 0) + number(row.amount))
  }

  for (const row of atRisk) {
    const sourcePaymentId = obligationKey(row)
    if (!sourcePaymentId) continue
    const provider = (['stripe', 'whop', 'fanbasis'].includes(text(row.payment_provider)) ? text(row.payment_provider) : 'stripe') as PaymentProviderId
    const identities = paymentIdentity(row)
    const existing = workspace.paymentRecoveryCases.find((item) => item.provider === provider && (identities.includes(item.sourcePaymentId) || Boolean(item.sourceInvoiceId && identities.includes(item.sourceInvoiceId)) || Boolean(item.sourcePaymentIntentId && identities.includes(item.sourcePaymentIntentId))))
    const classification = classifyPayment(row)
    const dueAt = iso(row.due_at)
    const nextRetryAt = iso(row.next_retry_at)
    const contact = findContact(workspace, row)
    const customerKey = lower(row.customer_id ?? row.customer_email ?? row.customer ?? row.deal_id)
    const customerName = text(row.customer ?? contact.lead?.name ?? contact.deal?.name) || 'Unknown customer'
    const owner = text(contact.deal?.owner ?? contact.lead?.owner) || workspace.recoveryPolicy.defaultOwner
    const fields = {
      provider,
      sourcePaymentId,
      sourceInvoiceId: text(row.invoice_id ?? row.source_invoice_id) || undefined,
      sourcePaymentIntentId: text(row.payment_intent_id) || undefined,
      dealId: text(row.deal_id) || undefined,
      customerId: text(row.customer_id) || undefined,
      contactId: text(contact.lead?.id) || undefined,
      customerName,
      customerEmail: text(row.customer_email ?? contact.lead?.email) || undefined,
      customerPhone: text(contact.lead?.phone) || undefined,
      owner,
      amountDue: number(row.amount),
      totalOutstanding: outstandingByCustomer.get(customerKey) ?? number(row.amount),
      currency: text(row.currency).toUpperCase() || 'USD',
      dueAt,
      failureCode: text(row.failure_code) || undefined,
      failureReason: text(row.failure_reason ?? row.failure_message) || undefined,
      attemptCount: Math.max(0, Math.round(number(row.attempt_count))),
      nextRetryAt,
      hostedPaymentUrl: safeHostedPaymentUrl(row.hosted_invoice_url ?? row.payment_link),
      classification,
      priority: priority(number(row.amount), dueAt),
      recommendedAction: recommendedAction(classification, nextRetryAt, provider),
    }
    if (existing) {
      Object.assign(existing, fields)
      if (!isProtectedStatus(existing.status) && existing.status !== 'recovered') existing.status = statusForClassification(classification)
      existing.updatedAt = now
    } else {
      workspace.paymentRecoveryCases.push({
        id: `payment-case-${randomBytes(8).toString('hex')}`,
        ...fields,
        status: statusForClassification(classification),
      attempts: [],
      promises: [],
      suggestions: [],
      followUps: [],
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  for (const row of paid) {
    const identities = paymentIdentity(row)
    const provider = (['stripe', 'whop', 'fanbasis'].includes(text(row.payment_provider)) ? text(row.payment_provider) : 'stripe') as PaymentProviderId
    const recoveredAt = iso(row.paid_at) ?? now
    const match = workspace.paymentRecoveryCases.find((item) => item.provider === provider && (identities.includes(item.sourcePaymentId) || Boolean(item.sourceInvoiceId && identities.includes(item.sourceInvoiceId)) || Boolean(item.sourcePaymentIntentId && identities.includes(item.sourcePaymentIntentId))))
    if (!match || match.status === 'recovered') continue
    match.status = 'recovered'
    match.recoveredAt = recoveredAt
    match.outcome = { type: 'recovered', amount: Math.min(match.amountDue, number(row.amount) || match.amountDue), source: 'provider_sync', note: `Payment verified automatically during ${match.provider} sync.`, recordedAt: now, recordedBy: `${match.provider} sync` }
    match.promises = match.promises.map((promise) => promise.status === 'pending' ? { ...promise, status: 'kept' } : promise)
    match.followUps = (match.followUps ?? []).map((followUp) => ['scheduled', 'due'].includes(followUp.status) ? { ...followUp, status: 'cancelled', completedAt: now } : followUp)
    match.updatedAt = now
  }

  return workspace.paymentRecoveryCases
}

export function safeHostedPaymentUrl(value: unknown) {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    const approved = ['stripe.com', 'whop.com', 'fanbasis.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    if (url.protocol !== 'https:' || !approved) return undefined
    return url.toString()
  } catch { return undefined }
}

export function renderRecoveryMessage(template: string, recoveryCase: PaymentRecoveryCaseRecord, policy: RecoveryPolicyRecord) {
  const firstName = recoveryCase.customerName.split(/\s+/)[0] || 'there'
  const dueDate = recoveryCase.dueAt ? new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(recoveryCase.dueAt)) : 'the agreed date'
  const amountDue = new Intl.NumberFormat('en-US', { style: 'currency', currency: recoveryCase.currency || 'USD' }).format(recoveryCase.amountDue)
  const values: Record<string, string> = {
    first_name: firstName,
    sender_name: policy.senderName,
    business_name: policy.businessName,
    amount_due: amountDue,
    due_date: dueDate,
    payment_link: recoveryCase.hostedPaymentUrl ?? '[secure payment link unavailable]',
  }
  return template.replace(/{{([a-z_]+)}}/g, (_match, key: string) => values[key] ?? '')
}

export function recoveryReport(cases: PaymentRecoveryCaseRecord[]) {
  const open = cases.filter((item) => item.status !== 'recovered' && item.status !== 'closed_unrecovered')
  const contacted = cases.filter((item) => item.attempts.some((attempt) => attempt.direction === 'outbound' && attempt.deliveryStatus !== 'pending' && attempt.deliveryStatus !== 'failed'))
  const responded = cases.filter((item) => item.attempts.some((attempt) => attempt.direction === 'inbound'))
  const recovered = cases.filter((item) => item.status === 'recovered')
  const recoveryDurations = recovered.map((item) => item.recoveredAt ? Math.max(0, (Date.parse(item.recoveredAt) - Date.parse(item.createdAt)) / 3_600_000) : 0).sort((a, b) => a - b)
  const promises = cases.flatMap((item) => item.promises)
  const byClassification = Object.fromEntries((['retryable_failure', 'payment_method_required', 'authentication_required', 'secure_payment_link', 'human_review'] as PaymentRecoveryClassification[]).map((classification) => {
    const group = cases.filter((item) => item.classification === classification)
    return [classification, { cases: group.length, recovered: group.filter((item) => item.status === 'recovered').reduce((sum, item) => sum + (item.outcome?.amount ?? 0), 0) }]
  }))
  return {
    totalOverdue: open.reduce((sum, item) => sum + item.amountDue, 0),
    eligibleBalance: open.filter((item) => item.classification !== 'human_review').reduce((sum, item) => sum + item.amountDue, 0),
    contactedCases: contacted.length,
    responseRate: contacted.length ? Math.round(responded.length / contacted.length * 1000) / 10 : 0,
    promisesMade: promises.length,
    promisesKept: promises.filter((item) => item.status === 'kept').length,
    cashRecovered: recovered.reduce((sum, item) => sum + (item.outcome?.amount ?? 0), 0),
    medianRecoveryHours: recoveryDurations.length ? Math.round(recoveryDurations[Math.floor(recoveryDurations.length / 2)] * 10) / 10 : 0,
    humanEscalationRate: cases.length ? Math.round(cases.filter((item) => item.status === 'human_intervention').length / cases.length * 1000) / 10 : 0,
    replyNeeded: cases.filter((item) => item.suggestions?.some((suggestion) => suggestion.status === 'draft' && Boolean(suggestion.triggerAttemptId))).length,
    followUpsDue: cases.reduce((sum, item) => sum + (item.followUps?.filter((followUp) => followUp.kind === 'no_response' && followUp.status === 'due').length ?? 0), 0),
    promisesDue: cases.reduce((sum, item) => sum + (item.followUps?.filter((followUp) => followUp.kind === 'promise_due' && followUp.status === 'due').length ?? 0), 0),
    assistedRepliesSent: cases.reduce((sum, item) => sum + (item.suggestions?.filter((suggestion) => suggestion.status === 'sent').length ?? 0), 0),
    recoveredAfterAssistance: recovered.filter((item) => item.attempts.some((attempt) => attempt.direction === 'outbound' && attempt.deliveryStatus !== 'pending' && attempt.deliveryStatus !== 'failed')).reduce((sum, item) => sum + (item.outcome?.amount ?? 0), 0),
    byClassification,
  }
}

export function samplePaymentRecoveryCases(policy: RecoveryPolicyRecord, now = new Date()) {
  const date = (days: number, hours = 0) => new Date(now.getTime() + days * 86_400_000 + hours * 3_600_000).toISOString()
  const base = (input: Partial<PaymentRecoveryCaseRecord> & Pick<PaymentRecoveryCaseRecord, 'sourcePaymentId' | 'customerName' | 'amountDue' | 'classification' | 'status'>): PaymentRecoveryCaseRecord => ({
    id: `payment-case-sample-${input.sourcePaymentId}`,
    provider: 'stripe',
    totalOutstanding: input.amountDue,
    currency: 'USD',
    owner: policy.defaultOwner,
    priority: 'high',
    attemptCount: 1,
    recommendedAction: recommendedAction(input.classification, input.nextRetryAt, input.provider),
    attempts: [],
    promises: [],
    suggestions: [],
    followUps: [],
    createdAt: date(-8),
    updatedAt: date(-1),
    ...input,
  })
  return [
    base({ sourcePaymentId: 'in_sample_retry', sourceInvoiceId: 'in_sample_retry', customerId: 'cus_sample_nina', contactId: 'L-SBX-3', customerName: 'Nina Patel', customerEmail: 'nina@example.com', customerPhone: '+1555010101', amountDue: 2_400, dueAt: date(-2), failureCode: 'insufficient_funds', failureReason: 'Insufficient funds', nextRetryAt: date(1), hostedPaymentUrl: 'https://invoice.stripe.com/i/acct_sample/in_sample_retry', classification: 'retryable_failure', status: 'retry_in_progress', recommendedAction: recommendedAction('retryable_failure', date(1)) }),
    base({ sourcePaymentId: 'pay_sample_card', sourceInvoiceId: 'pay_sample_card', provider: 'whop', contactId: 'L-SAMPLE-LEO', customerName: 'Leo Carter', customerEmail: 'leo@example.com', customerPhone: '+1555010102', amountDue: 1_800, dueAt: date(-11), failureCode: 'expired_card', failureReason: 'The customer’s card has expired.', hostedPaymentUrl: 'https://whop.com/manage/sample', classification: 'payment_method_required', status: 'payment_method_required', priority: 'critical', attempts: [{ id: 'attempt-sample-leo-1', channel: 'sms', direction: 'outbound', summary: 'Card-update request sent; no reply recorded.', simulated: true, createdAt: date(-6), createdBy: 'Andrea' }], followUps: [{ id: 'follow-up-attempt-sample-leo-1', kind: 'no_response', channel: 'sms', dueAt: date(-5), status: 'due', attemptNumber: 1, reason: 'No customer response recorded after attempt-sample-leo-1.', createdAt: date(-6) }] }),
    base({ sourcePaymentId: 'in_sample_auth', sourceInvoiceId: 'in_sample_auth', customerName: 'Maya Brown', customerEmail: 'maya@example.com', customerPhone: '+1555010104', contactId: 'L-SBX-1', amountDue: 3_200, dueAt: date(-4), failureCode: 'authentication_required', failureReason: 'Bank authentication is required.', hostedPaymentUrl: 'https://invoice.stripe.com/i/acct_sample/in_sample_auth', classification: 'authentication_required', status: 'authentication_required', conversationId: 'conv-sample-maya', lastOutboundAt: date(-1, -2), lastInboundAt: date(-1), attempts: [{ id: 'attempt-sample-maya-in', channel: 'sms', direction: 'inbound', summary: 'Customer asked for the secure payment link.', body: 'Can you send me the link so I can sort it today?', intent: 'payment_link', conversationId: 'conv-sample-maya', simulated: true, createdAt: date(-1), createdBy: 'Maya Brown' }, { id: 'attempt-sample-maya-out', channel: 'sms', direction: 'outbound', summary: 'Authentication reminder sent.', simulated: true, createdAt: date(-1, -2), createdBy: 'Andrea' }], suggestions: [{ id: 'suggestion-sample-maya', triggerAttemptId: 'attempt-sample-maya-in', intent: 'payment_link', confidence: 0.92, recommendedAction: 'Reply with the verified provider-hosted payment link.', channel: 'sms', body: `Hi Maya, of course — here is the secure payment link: https://invoice.stripe.com/i/acct_sample/in_sample_auth. Please let me know once it has gone through or if you have any trouble opening it. — ${policy.senderName}, ${policy.businessName}`, status: 'draft', createdAt: date(-1), updatedAt: date(-1) }] }),
    base({ sourcePaymentId: 'fb_sample_promise', sourceInvoiceId: 'fb_sample_promise', provider: 'fanbasis', contactId: 'L-SAMPLE-JORDAN', customerName: 'Jordan Wells', customerEmail: 'jordan@example.com', customerPhone: '+1555010103', amountDue: 2_500, dueAt: date(-6), failureCode: 'generic_decline', failureReason: 'Customer requested a new payment date after missing the first promise.', hostedPaymentUrl: 'https://fanbasis.com/pay/sample', classification: 'secure_payment_link', status: 'promise_pending', promises: [{ id: 'promise-sample-1', amount: 2_500, dueAt: date(1), note: 'Customer said they will pay Friday.', status: 'pending', createdAt: date(-1), createdBy: 'Andrea' }, { id: 'promise-sample-missed', amount: 2_500, dueAt: date(-3), note: 'First promised date passed without payment.', status: 'missed', createdAt: date(-5), createdBy: 'Andrea' }], attempts: [{ id: 'attempt-sample-1', channel: 'sms', direction: 'outbound', summary: 'Secure payment link sent.', body: 'Payment reminder sent through the sample workspace.', simulated: true, createdAt: date(-2), createdBy: 'Andrea' }], followUps: [{ id: 'follow-up-promise-sample-missed', kind: 'promise_due', channel: 'sms', dueAt: date(-3), status: 'due', attemptNumber: 1, reason: 'Promise promise-sample-missed passed without a verified payment.', createdAt: date(-3) }] }),
    base({ sourcePaymentId: 'fb_sample_review', sourceInvoiceId: 'fb_sample_review', provider: 'fanbasis', contactId: 'L-SAMPLE-ELENA', customerName: 'Elena Brooks', customerEmail: 'elena@example.com', amountDue: 4_800, dueAt: date(-15), failureReason: 'Customer disputed the agreed service start date.', classification: 'human_review', status: 'human_intervention', priority: 'critical', escalationReason: 'Dispute mentioned — automation paused.' }),
    base({ sourcePaymentId: 'pay_sample_recovered', sourceInvoiceId: 'pay_sample_recovered', provider: 'whop', contactId: 'L-SAMPLE-MARCUS', customerName: 'Marcus Hall', customerEmail: 'marcus@example.com', amountDue: 2_000, totalOutstanding: 0, dueAt: date(-9), classification: 'secure_payment_link', status: 'recovered', recoveredAt: date(-2), attempts: [{ id: 'attempt-sample-2', channel: 'email', direction: 'outbound', summary: 'Hosted invoice link sent.', simulated: true, createdAt: date(-4), createdBy: 'Andrea' }], outcome: { type: 'recovered', amount: 2_000, source: 'provider_sync', note: 'Payment verified after assisted outreach.', recordedAt: date(-2), recordedBy: 'Whop sync' } }),
  ]
}
