import express from 'express'
import { createHmac, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { EncryptedStore, defaultPilotValidation, defaultRecoveryPolicy } from './store.js'
import { IntegrationService } from './integrationService.js'
import type { KpiSnapshotRecord, ProviderId, RenewalClientRecord } from './types.js'
import { safeErrorMessage } from './safety.js'
import { AuthService, type PublicUser } from './authService.js'
import { frontendEntryForPath } from './frontendRoutes.js'
import { EncryptedPaymentRecoveryRepository } from './paymentRecoveryRepository.js'
import { PaymentRecoveryService } from './paymentRecoveryService.js'
import { normalizeFanBasisPayment } from './providers.js'
import { reconcilePaymentRecoveryCases } from './paymentRecovery.js'
import { createRateLimiter, requireSameOriginMutation, securityHeaders } from './requestProtection.js'
import { upsertClickUpRenewalClients } from './renewalImport.js'
import { RenewalOutreachService } from './renewalOutreach.js'

const providerSchema = z.enum(['stripe', 'whop', 'fanbasis', 'highlevel', 'google-calendar', 'fathom', 'clickup'])
const isValidationError = (error: unknown) => error instanceof z.ZodError || Boolean(error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues))
const roleSchema = z.enum(['owner', 'admin', 'manager', 'viewer'])
const inviteRoleSchema = z.enum(['admin', 'manager', 'viewer'])
const newPasswordSchema = z.string().min(10).max(128)
const loginPasswordSchema = z.string().min(1).max(128)
const marketingEventSchema = z.enum(['page_view', 'apply_click', 'vsl_click', 'sample_report_click', 'client_login_click', 'application_details_submitted', 'application_completed'])
const recoveryCaseStatusSchema = z.enum(['detected', 'assigned', 'in_progress', 'resolved'])
const datasetKindSchema = z.enum(['leads', 'appointments', 'deals', 'payments', 'closers'])
const normalizedValueSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()])
const normalizedRowSchema = z.record(z.string().min(1).max(100), normalizedValueSchema).refine((row) => Object.keys(row).length <= 100, 'Each imported row can contain at most 100 fields.')
const datasetImportSchema = z.object({
  kind: datasetKindSchema,
  fileName: z.string().min(1).max(255),
  rows: z.array(normalizedRowSchema).max(25_000),
  sourceRows: z.number().int().min(0).max(1_000_000),
  issues: z.array(z.string().max(300)).max(20),
  mappedFields: z.array(z.string().min(1).max(100)).max(100),
  headers: z.array(z.string().max(200)).max(200),
  mapping: z.record(z.string().min(1).max(100), z.string().max(200)).refine((mapping) => Object.keys(mapping).length <= 100, 'An import can contain at most 100 column mappings.'),
}).strict()
const importWorkspaceSchema = z.object({
  leads: datasetImportSchema.optional(),
  appointments: datasetImportSchema.optional(),
  deals: datasetImportSchema.optional(),
  payments: datasetImportSchema.optional(),
  closers: datasetImportSchema.optional(),
}).strict().superRefine((workspace, context) => {
  for (const [kind, dataset] of Object.entries(workspace)) {
    if (dataset && dataset.kind !== kind) context.addIssue({ code: 'custom', path: [kind, 'kind'], message: `Dataset kind must be ${kind}.` })
  }
})
const paymentRecoveryStatusSchema = z.enum(['retry_in_progress', 'payment_method_required', 'authentication_required', 'secure_payment_link_required', 'promise_pending', 'human_intervention', 'recovered', 'closed_unrecovered'])
const paymentClassificationSchema = z.enum(['retryable_failure', 'payment_method_required', 'authentication_required', 'secure_payment_link', 'human_review'])
const recoveryTemplateSchema = z.object({ sms: z.string().min(10).max(1500), emailSubject: z.string().min(3).max(180), emailBody: z.string().min(10).max(5000) })
const timezoneSchema = z.string().min(3).max(80).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true }
  catch { return false }
}, 'Use a valid IANA timezone such as America/New_York or Europe/London.')
const recoveryPolicySchema = z.object({
  businessName: z.string().min(2).max(120), senderName: z.string().min(2).max(100), senderEmail: z.string().max(160), senderPhone: z.string().max(50), defaultOwner: z.string().min(2).max(100), timezone: timezoneSchema, escalationDays: z.number().int().min(1).max(60), maxTouches: z.number().int().min(1).max(20), tone: z.enum(['warm', 'direct', 'formal']),
  followUpDelaysHours: z.array(z.number().int().min(1).max(24 * 30)).min(1).max(8), promiseGraceHours: z.number().int().min(0).max(72),
  templates: z.record(paymentClassificationSchema, recoveryTemplateSchema),
  templatesApprovedAt: z.string().optional(), templatesApprovedBy: z.string().optional(),
})
const pilotValidationSchema = z.object({
  monthlyFee: z.number().min(0).max(100_000),
  startedAt: z.string().date().optional(),
  baselineWindowDays: z.number().int().min(30).max(90),
  historicEligibleBalance: z.number().min(0).max(100_000_000),
  historicRecoveredAmount: z.number().min(0).max(100_000_000),
  onboardingMinutes: z.number().int().min(0).max(100_000),
  supportMinutes: z.number().int().min(0).max(100_000),
  renewalStatus: z.enum(['not_asked', 'yes', 'no', 'undecided']),
  notes: z.string().max(2000),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})
const optionalDateSchema = z.union([z.string().date(), z.literal('')]).transform((value) => value || undefined)
const renewalStatusSchema = z.enum(['not_started', 'renewal_opportunity', 'conversation_needed', 'call_booked', 'decision_pending', 'renewed', 'declined'])
const renewalOutreachKindSchema = z.enum(['feedback_request', 'renewal_invitation', 'no_response_follow_up'])
const renewalOutreachPreviewSchema = z.object({ channel: z.enum(['sms', 'email']), kind: renewalOutreachKindSchema }).strict()
const renewalOutreachSendSchema = renewalOutreachPreviewSchema.extend({
  subject: z.string().trim().max(180).optional(),
  body: z.string().trim().min(10).max(5_000),
  approved: z.literal(true),
  idempotencyKey: z.string().trim().min(8).max(100),
}).strict()
const renewalClientFieldsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.union([z.string().trim().email().max(160), z.literal('')]).optional().transform((value) => value || undefined),
  owner: z.string().trim().min(2).max(100),
  enrolledAt: optionalDateSchema.optional(),
  firstWebinarAt: optionalDateSchema.optional(),
  lastWebinarAt: optionalDateSchema.optional(),
  nextWebinarAt: optionalDateSchema.optional(),
  webinarsHosted: z.number().int().min(0).max(10_000),
  feedbackScore: z.union([z.number().int().min(1).max(5), z.null()]).optional().transform((value) => value ?? undefined),
  feedbackNote: z.string().trim().max(2_000).optional(),
  renewalCallAt: optionalDateSchema.optional(),
  renewalStatus: renewalStatusSchema,
  expectedRenewalValue: z.number().min(0).max(100_000_000),
  renewalCashCollected: z.number().min(0).max(100_000_000),
  nextAction: z.string().trim().max(500).optional(),
}).strict()
const validateRenewalClient = (client: z.infer<typeof renewalClientFieldsSchema>, context: z.RefinementCtx) => {
  if (client.webinarsHosted > 0 && !client.firstWebinarAt) context.addIssue({ code: 'custom', path: ['firstWebinarAt'], message: 'Add the first webinar date when completed webinars are recorded.' })
  if (client.firstWebinarAt && client.webinarsHosted === 0) context.addIssue({ code: 'custom', path: ['webinarsHosted'], message: 'A first webinar date requires at least one completed webinar.' })
  if (client.lastWebinarAt && !client.firstWebinarAt) context.addIssue({ code: 'custom', path: ['firstWebinarAt'], message: 'Add the first webinar date before the latest webinar date.' })
  if (client.firstWebinarAt && client.lastWebinarAt && client.lastWebinarAt < client.firstWebinarAt) context.addIssue({ code: 'custom', path: ['lastWebinarAt'], message: 'The latest webinar cannot be before the first webinar.' })
}
const renewalClientInputSchema = renewalClientFieldsSchema.superRefine(validateRenewalClient)
const renewalClientPatchSchema = renewalClientFieldsSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.')
function renewalInputFromRecord(client: RenewalClientRecord) {
  return {
    name: client.name,
    email: client.email,
    owner: client.owner,
    enrolledAt: client.enrolledAt,
    firstWebinarAt: client.firstWebinarAt,
    lastWebinarAt: client.lastWebinarAt,
    nextWebinarAt: client.nextWebinarAt,
    webinarsHosted: client.webinarsHosted,
    feedbackScore: client.feedbackScore,
    feedbackNote: client.feedbackNote,
    renewalCallAt: client.renewalCallAt,
    renewalStatus: client.renewalStatus,
    expectedRenewalValue: client.expectedRenewalValue,
    renewalCashCollected: client.renewalCashCollected,
    nextAction: client.nextAction,
  }
}
const clickUpRenewalRowSchema = z.object({
  clickUpTaskId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(2).max(120),
  email: z.union([z.string().trim().email().max(160), z.literal('')]).optional().transform((value) => value || undefined),
  firstWebinarAt: optionalDateSchema.optional(),
  lastWebinarAt: optionalDateSchema.optional(),
  nextWebinarAt: optionalDateSchema.optional(),
  webinarsHosted: z.number().int().min(0).max(10_000),
  clickUpStatus: z.string().trim().max(100).optional(),
}).strict().superRefine((row, context) => {
  if (row.webinarsHosted > 0 && !row.firstWebinarAt) context.addIssue({ code: 'custom', path: ['firstWebinarAt'], message: 'Completed webinars require a first webinar date.' })
  if (row.firstWebinarAt && row.webinarsHosted === 0) context.addIssue({ code: 'custom', path: ['webinarsHosted'], message: 'A first webinar date requires a completed webinar.' })
  if (row.firstWebinarAt && row.lastWebinarAt && row.lastWebinarAt < row.firstWebinarAt) context.addIssue({ code: 'custom', path: ['lastWebinarAt'], message: 'The latest webinar cannot be before the first webinar.' })
})
const clickUpRenewalImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  sourceRows: z.number().int().min(1).max(5_000),
  rows: z.array(clickUpRenewalRowSchema).min(1).max(500),
}).strip()
const kpiSnapshotFieldsSchema = z.object({
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  bookedCalls: z.number().int().min(0).max(10_000_000),
  callsTaken: z.number().int().min(0).max(10_000_000),
  deals: z.number().int().min(0).max(10_000_000),
  refunds: z.number().int().min(0).max(10_000_000),
  totalRevenue: z.number().min(0).max(1_000_000_000),
  cashCollected: z.number().min(0).max(1_000_000_000),
  notes: z.string().trim().max(2_000).optional(),
}).strict()
const validateKpiSnapshot = (snapshot: z.infer<typeof kpiSnapshotFieldsSchema>, context: z.RefinementCtx) => {
  if (snapshot.periodEnd < snapshot.periodStart) context.addIssue({ code: 'custom', path: ['periodEnd'], message: 'The reporting-period end cannot be before its start.' })
}
const kpiSnapshotInputSchema = kpiSnapshotFieldsSchema.superRefine(validateKpiSnapshot)
const kpiSnapshotPatchSchema = kpiSnapshotFieldsSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.')
function kpiInputFromRecord(snapshot: KpiSnapshotRecord) {
  return {
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    bookedCalls: snapshot.bookedCalls,
    callsTaken: snapshot.callsTaken,
    deals: snapshot.deals,
    refunds: snapshot.refunds,
    totalRevenue: snapshot.totalRevenue,
    cashCollected: snapshot.cashCollected,
    notes: snapshot.notes,
  }
}
function dateInTimezone(date: string, timezone: string) {
  const guess = Date.parse(`${date}T09:00:00.000Z`)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map((part) => [part.type, part.value]))
  const representedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return new Date(guess - (representedAsUtc - guess)).toISOString()
}
function localDateInTimezone(timezone: string, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
const detectedCaseSchema = z.object({
  leakId: z.number().int(),
  type: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(600),
  impact: z.number().min(0),
  affectedRecords: z.number().int().min(0),
  severity: z.enum(['critical', 'warning', 'opportunity']),
  suggestedOwner: z.string().min(1).max(100),
  suggestedActions: z.array(z.string().min(1).max(300)).max(8),
})

export function createApp(store = new EncryptedStore(), fetcher: typeof fetch = fetch) {
  const app = express()
  const service = new IntegrationService(store, fetcher)
  const auth = new AuthService(store)
  const recoveryRepository = new EncryptedPaymentRecoveryRepository(store)
  const paymentRecovery = new PaymentRecoveryService(store, recoveryRepository, fetcher)
  const renewalOutreach = new RenewalOutreachService(store, fetcher)
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use(securityHeaders)
  app.use('/api', requireSameOriginMutation)
  const standardJsonParser = express.json({ limit: '256kb', verify: (request, _response, buffer) => { (request as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer) } })
  app.use((request, response, next) => request.path.startsWith('/api/imports') ? next() : standardJsonParser(request, response, next))
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next() })
  const authLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 20 })
  const leadLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 20 })
  const marketingLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 300 })
  const webhookLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 600 })

  app.get('/api/health', (_request, response) => response.json({ ok: true, version: 2 }))

  app.post('/api/marketing-events', marketingLimiter, async (request, response) => {
    try {
      const input = z.object({
        event: marketingEventSchema,
        path: z.string().min(1).max(160),
        leadId: z.string().max(80).optional(),
      }).parse(request.body)
      await store.update((state) => {
        state.marketingEvents.push({ id: `event-${randomBytes(8).toString('hex')}`, event: input.event, path: input.path, leadId: input.leadId, createdAt: new Date().toISOString() })
        if (state.marketingEvents.length > 5_000) state.marketingEvents.splice(0, state.marketingEvents.length - 5_000)
      })
      response.status(202).json({ ok: true })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 500).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/leads', leadLimiter, async (request, response) => {
    try {
      const input = z.object({
        name: z.string().min(2).max(80),
        email: z.string().email().max(120),
        phone: z.string().max(40).optional().default(''),
        company: z.string().min(2).max(120),
        website: z.string().max(180).optional().default(''),
        role: z.string().max(80).optional().default(''),
        monthlyBookedCalls: z.string().max(60).optional().default(''),
        offerPrice: z.string().max(60).optional().default(''),
        monthlyOverdueVolume: z.string().max(60).optional().default(''),
        monthlyFailedPayments: z.string().max(60).optional().default(''),
        paymentProvider: z.string().max(80).optional().default(''),
        crm: z.string().max(80).optional().default(''),
        suspectedLeak: z.string().max(160).optional().default(''),
        currentRecoveryProcess: z.string().max(160).optional().default(''),
        notes: z.string().max(600).optional().default(''),
      }).parse(request.body)
      let leadId = ''
      await store.update((state) => {
        leadId = `lead-${randomBytes(8).toString('hex')}`
        state.leadApplications.push({
          id: leadId,
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          phone: input.phone.trim() || undefined,
          company: input.company.trim(),
          website: input.website.trim() || undefined,
          role: input.role.trim() || undefined,
          monthlyBookedCalls: input.monthlyBookedCalls.trim() || undefined,
          offerPrice: input.offerPrice.trim() || undefined,
          monthlyOverdueVolume: input.monthlyOverdueVolume.trim() || undefined,
          monthlyFailedPayments: input.monthlyFailedPayments.trim() || undefined,
          paymentProvider: input.paymentProvider.trim() || undefined,
          crm: input.crm.trim() || undefined,
          suspectedLeak: input.suspectedLeak.trim() || undefined,
          currentRecoveryProcess: input.currentRecoveryProcess.trim() || undefined,
          notes: input.notes.trim() || undefined,
          source: 'landing-page',
          status: 'new',
          createdAt: new Date().toISOString(),
        })
        if (state.leadApplications.length > 10_000) state.leadApplications.splice(0, state.leadApplications.length - 10_000)
      })
      response.status(201).json({ ok: true, leadId })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 500).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/leads/:leadId/qualify', leadLimiter, async (request, response) => {
    try {
      const input = z.object({
        website: z.string().max(180).optional().default(''),
        monthlyBookedCalls: z.string().max(60).optional().default(''),
        offerPrice: z.string().max(60).optional().default(''),
        monthlyOverdueVolume: z.string().max(60).optional().default(''),
        monthlyFailedPayments: z.string().max(60).optional().default(''),
        paymentProvider: z.string().max(80).optional().default(''),
        crm: z.string().max(80).optional().default(''),
        suspectedLeak: z.string().max(160).optional().default(''),
        currentRecoveryProcess: z.string().max(160).optional().default(''),
        notes: z.string().max(600).optional().default(''),
      }).parse(request.body)
      let updated = false
      await store.update((state) => {
        const lead = state.leadApplications.find((item) => item.id === request.params.leadId)
        if (!lead) throw new Error('Application not found.')
        lead.website = input.website.trim() || lead.website
        lead.monthlyBookedCalls = input.monthlyBookedCalls.trim() || lead.monthlyBookedCalls
        lead.offerPrice = input.offerPrice.trim() || lead.offerPrice
        lead.monthlyOverdueVolume = input.monthlyOverdueVolume.trim() || lead.monthlyOverdueVolume
        lead.monthlyFailedPayments = input.monthlyFailedPayments.trim() || lead.monthlyFailedPayments
        lead.paymentProvider = input.paymentProvider.trim() || lead.paymentProvider
        lead.crm = input.crm.trim() || undefined
        lead.suspectedLeak = input.suspectedLeak.trim() || lead.suspectedLeak
        lead.currentRecoveryProcess = input.currentRecoveryProcess.trim() || lead.currentRecoveryProcess
        lead.notes = input.notes.trim() || undefined
        lead.status = 'qualified'
        lead.qualifiedAt = new Date().toISOString()
        updated = true
      })
      response.json({ ok: updated })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 404).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/payment-sources/fanbasis/:workspaceId/events', webhookLimiter, async (request, response) => {
    try {
      const input = z.object({ payments: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }).parse(request.body)
      const supplied = String(request.headers['x-leakline-signature'] ?? '')
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === request.params.workspaceId && !item.archivedAt)
        const credential = workspace?.credentials.fanbasis
        if (!workspace || !credential) throw new Error('FanBasis recovery bridge is not configured.')
        const left = Buffer.from(supplied, 'hex')
        const rawBody = (request as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(request.body))
        const right = Buffer.from(createHmac('sha256', credential.webhookSecret).update(rawBody).digest('hex'), 'hex')
        if (!left.length || left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('FanBasis recovery bridge signature is invalid.')
        const incoming = input.payments.map(normalizeFanBasisPayment).filter((row) => row.id)
        const existing = workspace.workspace.payments?.rows.filter((row) => row.payment_provider !== 'fanbasis') ?? []
        const byId = new Map(incoming.map((row) => [String(row.id), row]))
        const previousFanBasis = workspace.workspace.payments?.rows.filter((row) => row.payment_provider === 'fanbasis' && !byId.has(String(row.id))) ?? []
        const rows = [...existing, ...previousFanBasis, ...incoming]
        const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]
        workspace.workspace.payments = { kind: 'payments', fileName: 'Connected payment providers', rows, sourceRows: rows.length, issues: [], mappedFields: fields, headers: fields, mapping: Object.fromEntries(fields.map((field) => [field, field])) }
        workspace.connections.fanbasis = { ...(workspace.connections.fanbasis ?? { connectedAt: new Date().toISOString() }), lastSyncAt: new Date().toISOString(), accountLabel: credential.accountLabel, recordCounts: { payments: incoming.length }, mode: 'live' }
        reconcilePaymentRecoveryCases(workspace)
      })
      response.status(202).json({ ok: true, accepted: input.payments.length })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(/signature/i.test(message) ? 403 : /configured/i.test(message) ? 404 : 400).json({ error: message })
    }
  })

  app.post('/api/webhooks/highlevel/inbound', webhookLimiter, async (request, response) => {
    const publicKey = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----`
    try {
      const rawBody = (request as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(request.body))
      const signature = String(request.headers['x-ghl-signature'] ?? '')
      const localTest = process.env.NODE_ENV === 'test' && request.headers['x-leakline-test-webhook'] === 'true'
      if (!localTest && (!signature || !verifySignature(null, rawBody, publicKey, Buffer.from(signature, 'base64')))) return response.status(401).json({ error: 'Invalid GoHighLevel webhook signature.' })
      const input = z.object({ type: z.literal('InboundMessage'), locationId: z.string().min(1), contactId: z.string().min(1), conversationId: z.string().optional(), messageId: z.string().optional(), emailMessageId: z.string().optional(), body: z.string().min(1).max(10_000), messageType: z.string().optional(), direction: z.string().optional(), dateAdded: z.string().optional() }).parse(request.body)
      const state = await store.read()
      const workspace = state.workspaces.find((item) => item.credentials.highlevel?.locationId === input.locationId && !item.archivedAt)
      if (!workspace) return response.status(200).json({ ok: true, ignored: 'workspace_not_found' })
      const providerMessageId = input.messageId ?? input.emailMessageId
      if (providerMessageId && (workspace.paymentRecoveryCases.some((item) => item.attempts.some((attempt) => attempt.providerMessageId === providerMessageId))
        || workspace.renewalClients.some((client) => client.outreach?.some((activity) => activity.providerMessageId === providerMessageId)))) {
        return response.status(200).json({ ok: true, ignored: 'duplicate_message' })
      }
      const candidates = workspace.paymentRecoveryCases.filter((item) => item.contactId === input.contactId && !['recovered', 'closed_unrecovered'].includes(item.status))
      const latestOutboundAt = (item: typeof candidates[number]) => item.attempts.filter((attempt) => attempt.direction === 'outbound').map((attempt) => attempt.createdAt).sort().at(-1) ?? item.updatedAt
      const exactRecoveryCase = candidates.find((item) => input.conversationId && item.conversationId === input.conversationId)
      const renewalCandidates = workspace.renewalClients.filter((client) => client.crmContactId === input.contactId && !['call_booked', 'decision_pending', 'renewed', 'declined'].includes(client.renewalStatus))
      const exactRenewalClient = renewalCandidates.find((client) => input.conversationId && client.outreach?.some((activity) => activity.conversationId === input.conversationId))
      if (exactRenewalClient && !exactRecoveryCase) {
        const channel = input.messageType?.toLowerCase() === 'email' ? 'email' : 'sms'
        await renewalOutreach.recordInbound(workspace.id, exactRenewalClient.id, { channel, body: input.body, providerMessageId, conversationId: input.conversationId }, exactRenewalClient.name)
        return response.status(202).json({ ok: true, renewalClientId: exactRenewalClient.id })
      }
      const recoveryCase = exactRecoveryCase
        ?? [...candidates].sort((left, right) => latestOutboundAt(right).localeCompare(latestOutboundAt(left)))[0]
      if (!recoveryCase) {
        const latestRenewalClient = [...renewalCandidates].sort((left, right) => {
          const latest = (client: typeof renewalCandidates[number]) => client.outreach?.filter((activity) => activity.direction === 'outbound').map((activity) => activity.createdAt).sort().at(-1) ?? client.updatedAt
          return latest(right).localeCompare(latest(left))
        })[0]
        if (!latestRenewalClient) return response.status(200).json({ ok: true, ignored: 'outreach_record_not_found' })
        const channel = input.messageType?.toLowerCase() === 'email' ? 'email' : 'sms'
        await renewalOutreach.recordInbound(workspace.id, latestRenewalClient.id, { channel, body: input.body, providerMessageId, conversationId: input.conversationId }, latestRenewalClient.name)
        return response.status(202).json({ ok: true, renewalClientId: latestRenewalClient.id })
      }
      const channel = input.messageType?.toLowerCase() === 'email' ? 'email' : 'sms'
      await recoveryRepository.addAttempt(workspace.id, recoveryCase.id, { channel, direction: 'inbound', summary: 'Customer response received through GoHighLevel.', body: input.body, providerMessageId, conversationId: input.conversationId, createdBy: recoveryCase.customerName })
      response.status(202).json({ ok: true, caseId: recoveryCase.id })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 200).json({ ok: false, error: safeErrorMessage(error) })
    }
  })

  app.get('/api/auth/me', async (request, response, next) => {
    try {
      const user = await auth.currentUser(request)
      response.json({ ...(await auth.meta()), authenticated: Boolean(user), user })
    } catch (error) { next(error) }
  })

  app.post('/api/auth/signup', authLimiter, async (request, response, next) => {
    try {
      const input = z.object({ name: z.string().max(80).default(''), email: z.string().email(), password: newPasswordSchema, inviteCode: z.string().optional() }).parse(request.body)
      const result = await auth.signup(input)
      auth.setSessionCookie(response, result.sessionId)
      response.status(201).json({ user: result.user })
    } catch (error) {
      if (error instanceof z.ZodError) return next(error)
      response.status(400).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/auth/login', authLimiter, async (request, response, next) => {
    try {
      const input = z.object({ email: z.string().email(), password: loginPasswordSchema }).parse(request.body)
      const result = await auth.login(input)
      auth.setSessionCookie(response, result.sessionId)
      response.json({ user: result.user })
    } catch (error) {
      if (error instanceof z.ZodError) return next(error)
      response.status(401).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/auth/logout', async (request, response, next) => {
    try {
      await auth.logout(request)
      auth.clearSessionCookie(response)
      response.json({ ok: true })
    } catch (error) { next(error) }
  })

  app.get('/api/invites/:token', authLimiter, async (request, response) => {
    try {
      response.json({ invite: await auth.previewInvite(z.string().min(1).parse(request.params.token)) })
    } catch (error) {
      response.status(404).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/invites/:token/accept', authLimiter, async (request, response, next) => {
    try {
      const input = z.object({ name: z.string().max(80).default(''), password: newPasswordSchema }).parse(request.body)
      const result = await auth.acceptInvite(z.string().min(1).parse(request.params.token), input)
      auth.setSessionCookie(response, result.sessionId)
      response.status(201).json({ user: result.user })
    } catch (error) {
      if (error instanceof z.ZodError) return next(error)
      response.status(400).json({ error: safeErrorMessage(error) })
    }
  })

  app.use('/api', async (request, response, next) => {
    try {
      if (!auth.enabled()) {
        response.locals.user = await auth.currentUser(request)
        return next()
      }
      const user = await auth.currentUser(request)
      if (!user) return response.status(401).json({ error: 'Login required.' })
      response.locals.user = user
      next()
    } catch (error) { next(error) }
  })
  app.use('/api/imports', express.json({ limit: '5mb' }))

  const activeWorkspaceId = (response: express.Response) => (response.locals.user as PublicUser).workspaceId

  app.get('/api/payment-recovery', async (_request, response, next) => {
    try { response.json(await recoveryRepository.snapshot(activeWorkspaceId(response))) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/sync', async (_request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); await recoveryRepository.reconcile(activeWorkspaceId(response)); response.json(await recoveryRepository.snapshot(activeWorkspaceId(response))) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/process-due', async (_request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); await recoveryRepository.processDue(activeWorkspaceId(response)); response.json(await recoveryRepository.snapshot(activeWorkspaceId(response))) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/sample', async (_request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const actor = response.locals.user as PublicUser; await recoveryRepository.seedSample(activeWorkspaceId(response), actor.name || actor.email); response.json(await recoveryRepository.snapshot(activeWorkspaceId(response))) } catch (error) { next(error) }
  })

  app.patch('/api/payment-recovery/policy', async (request, response, next) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = z.object({ policy: recoveryPolicySchema, approve: z.boolean().default(false) }).parse(request.body)
      const actor = response.locals.user as PublicUser
      await recoveryRepository.updatePolicy(activeWorkspaceId(response), input.policy, actor.name || actor.email, input.approve)
      response.json(await recoveryRepository.snapshot(activeWorkspaceId(response)))
    } catch (error) { next(error) }
  })

  app.patch('/api/payment-recovery/pilot-validation', async (request, response, next) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const validation = pilotValidationSchema.parse(request.body)
      const actor = response.locals.user as PublicUser
      await recoveryRepository.updatePilotValidation(activeWorkspaceId(response), validation, actor.name || actor.email)
      response.json(await recoveryRepository.snapshot(activeWorkspaceId(response)))
    } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/preview', async (request, response, next) => {
    try { const input = z.object({ channel: z.enum(['sms', 'email']) }).parse(request.body); response.json(await paymentRecovery.preview(activeWorkspaceId(response), request.params.caseId, input.channel)) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/send', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ channel: z.enum(['sms', 'email']), approved: z.literal(true) }).parse(request.body); response.json(await paymentRecovery.send(activeWorkspaceId(response), request.params.caseId, input.channel, input.approved, response.locals.user as PublicUser)) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/follow-ups/:followUpId/prepare', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); response.json({ suggestion: await recoveryRepository.prepareFollowUp(activeWorkspaceId(response), request.params.caseId, request.params.followUpId) }) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/suggestions/:suggestionId/send', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ body: z.string().min(2).max(5000), subject: z.string().max(180).optional(), approved: z.literal(true) }).parse(request.body); response.json(await paymentRecovery.sendSuggestion(activeWorkspaceId(response), request.params.caseId, request.params.suggestionId, input, response.locals.user as PublicUser)) } catch (error) { next(error) }
  })

  app.patch('/api/payment-recovery/cases/:caseId/suggestions/:suggestionId', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ status: z.enum(['dismissed', 'escalated']) }).parse(request.body); response.json({ case: await recoveryRepository.updateSuggestion(activeWorkspaceId(response), request.params.caseId, request.params.suggestionId, input) }) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/inbound', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ channel: z.enum(['sms', 'email']), body: z.string().min(1).max(5000) }).parse(request.body); const recoveryCase = await recoveryRepository.getCase(activeWorkspaceId(response), request.params.caseId); response.json({ case: await recoveryRepository.addAttempt(activeWorkspaceId(response), request.params.caseId, { channel: input.channel, direction: 'inbound', summary: 'Customer response recorded by operator.', body: input.body, createdBy: recoveryCase.customerName }) }) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/attempts', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ channel: z.enum(['sms', 'email', 'call', 'note']), direction: z.enum(['inbound', 'outbound', 'internal']), summary: z.string().min(2).max(500), body: z.string().max(3000).optional() }).parse(request.body); response.json({ case: await paymentRecovery.recordAttempt(activeWorkspaceId(response), request.params.caseId, input, response.locals.user as PublicUser) }) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/promises', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ amount: z.number().positive().max(100_000_000), dueDate: z.string().date(), note: z.string().max(1000).optional() }).parse(request.body); const actor = response.locals.user as PublicUser; const timezone = (await recoveryRepository.snapshot(activeWorkspaceId(response))).policy.timezone; if (input.dueDate < localDateInTimezone(timezone)) return response.status(400).json({ error: 'A promise date cannot be in the past.' }); response.json({ case: await recoveryRepository.addPromise(activeWorkspaceId(response), request.params.caseId, { amount: input.amount, dueAt: dateInTimezone(input.dueDate, timezone), note: input.note, createdBy: actor.name || actor.email }) }) } catch (error) { next(error) }
  })

  app.post('/api/payment-recovery/cases/:caseId/suggestions/:suggestionId/promise', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ amount: z.number().positive().max(100_000_000), dueDate: z.string().date(), note: z.string().max(1000).optional() }).parse(request.body); const timezone = (await recoveryRepository.snapshot(activeWorkspaceId(response))).policy.timezone; if (input.dueDate < localDateInTimezone(timezone)) return response.status(400).json({ error: 'A promise date cannot be in the past.' }); response.json(await paymentRecovery.recordPromiseFromSuggestion(activeWorkspaceId(response), request.params.caseId, request.params.suggestionId, { amount: input.amount, dueAt: dateInTimezone(input.dueDate, timezone), note: input.note }, response.locals.user as PublicUser)) } catch (error) { next(error) }
  })

  app.patch('/api/payment-recovery/cases/:caseId', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); const input = z.object({ status: paymentRecoveryStatusSchema.optional(), owner: z.string().min(1).max(100).optional(), escalationReason: z.string().max(1000).optional(), recoveredAmount: z.number().min(0).max(100_000_000).optional(), note: z.string().max(1000).optional() }).parse(request.body); const actor = response.locals.user as PublicUser; response.json({ case: await recoveryRepository.updateCase(activeWorkspaceId(response), request.params.caseId, input, actor.name || actor.email) }) } catch (error) { next(error) }
  })

  app.get('/api/admin/users', async (_request, response, next) => {
    try { response.json({ users: await auth.listUsers(response.locals.user as PublicUser) }) }
    catch (error) { response.status(403).json({ error: safeErrorMessage(error) }) }
  })

  app.post('/api/admin/users', async (request, response) => {
    try {
      const input = z.object({
        name: z.string().max(80).default(''),
        email: z.string().email(),
        password: newPasswordSchema,
        role: roleSchema.default('manager'),
        workspaceIds: z.array(z.string()).optional(),
      }).parse(request.body)
      response.status(201).json({ user: await auth.createUser(response.locals.user as PublicUser, input) })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.patch('/api/admin/users/:userId', async (request, response) => {
    try {
      const input = z.object({
        name: z.string().max(80).optional(),
        role: roleSchema.optional(),
        status: z.enum(['active', 'disabled']).optional(),
      }).parse(request.body)
      response.json({ user: await auth.updateUser(response.locals.user as PublicUser, request.params.userId, input) })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/admin/users/:userId/reset-password', async (request, response) => {
    try {
      const input = z.object({ password: newPasswordSchema }).parse(request.body)
      response.json(await auth.resetPassword(response.locals.user as PublicUser, request.params.userId, input.password))
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/admin/invites', async (_request, response) => {
    try {
      response.json({ invites: await auth.listInvites(response.locals.user as PublicUser) })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/admin/marketing', async (_request, response) => {
    try {
      auth.requireOwner(response.locals.user as PublicUser)
      const state = await store.read()
      response.json({
        leads: [...state.leadApplications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        events: [...state.marketingEvents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/admin/invites', async (request, response) => {
    try {
      const input = z.object({
        email: z.string().email(),
        role: inviteRoleSchema.default('viewer'),
        workspaceIds: z.array(z.string()).optional(),
        expiresInDays: z.number().int().min(1).max(30).optional(),
      }).parse(request.body)
      response.status(201).json({ invite: await auth.createInvite(response.locals.user as PublicUser, input) })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/admin/invites/:inviteId/revoke', async (request, response) => {
    try {
      response.json({ invite: await auth.revokeInvite(response.locals.user as PublicUser, request.params.inviteId) })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/workspaces', async (_request, response) => {
    const user = response.locals.user as PublicUser
    response.json({ activeWorkspaceId: user.workspaceId, workspaces: user.workspaces })
  })

  app.post('/api/workspaces', async (request, response) => {
    try {
      auth.requireOwner(response.locals.user as PublicUser)
      const input = z.object({ name: z.string().min(2).max(80), clientName: z.string().min(2).max(120) }).parse(request.body)
      let workspaceId = ''
      await store.update((state) => {
        workspaceId = `workspace-${randomBytes(8).toString('hex')}`
        state.workspaces.push({
          id: workspaceId,
          name: input.name.trim(),
          clientName: input.clientName.trim(),
          createdAt: new Date().toISOString(),
          createdBy: (response.locals.user as PublicUser).id,
          credentials: {},
          connections: {},
          oauthConfig: {},
          workspace: {},
          imports: {},
          calls: [],
          oauthStates: {},
          recoveryCases: [],
          paymentRecoveryCases: [],
          recoveryPolicy: defaultRecoveryPolicy(input.clientName.trim()),
          pilotValidation: defaultPilotValidation(),
          renewalClients: [],
          kpiSnapshots: [],
        })
        for (const user of state.users.filter((item) => item.role === 'owner')) {
          user.workspaceIds = Array.from(new Set([...(user.workspaceIds ?? []), workspaceId]))
        }
      })
      response.status(201).json({ workspaceId })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/workspaces/active', async (request, response) => {
    try {
      const input = z.object({ workspaceId: z.string().min(1) }).parse(request.body)
      const user = await auth.setActiveWorkspace(request, response.locals.user as PublicUser, input.workspaceId)
      response.json({ user })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/workspaces/:workspaceId/members', async (request, response) => {
    try {
      auth.requireWorkspaceAdmin(response.locals.user as PublicUser, request.params.workspaceId)
      const input = z.object({ userId: z.string().min(1) }).parse(request.body)
      await store.update((state) => {
        if (!state.workspaces.some((workspace) => workspace.id === request.params.workspaceId && !workspace.archivedAt)) throw new Error('Workspace not found.')
        const user = state.users.find((item) => item.id === input.userId)
        if (!user) throw new Error('User not found.')
        user.workspaceIds = Array.from(new Set([...(user.workspaceIds ?? []), request.params.workspaceId]))
        user.defaultWorkspaceId ??= request.params.workspaceId
      })
      response.json({ ok: true })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.delete('/api/workspaces/:workspaceId/members/:userId', async (request, response) => {
    try {
      auth.requireWorkspaceAdmin(response.locals.user as PublicUser, request.params.workspaceId)
      await store.update((state) => {
        const user = state.users.find((item) => item.id === request.params.userId)
        if (!user) throw new Error('User not found.')
        if (user.role === 'owner') throw new Error('Owners keep access to every workspace.')
        user.workspaceIds = (user.workspaceIds ?? []).filter((id) => id !== request.params.workspaceId)
        if (user.defaultWorkspaceId === request.params.workspaceId) user.defaultWorkspaceId = user.workspaceIds[0]
        state.sessions = state.sessions.map((session) => session.userId === user.id && session.activeWorkspaceId === request.params.workspaceId ? { ...session, activeWorkspaceId: user.defaultWorkspaceId } : session)
      })
      response.json({ ok: true })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/renewal-clients', async (_request, response) => {
    const state = await store.read()
    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
    if (!workspace) return response.status(404).json({ error: 'Workspace not found.' })
    response.json({
      clients: [...workspace.renewalClients].sort((left, right) => left.name.localeCompare(right.name)),
      clickUpImport: workspace.clickUpRenewalImport,
    })
  })

  app.post('/api/renewal-clients/:clientId/outreach/preview', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      response.json(await renewalOutreach.preview(activeWorkspaceId(response), request.params.clientId, renewalOutreachPreviewSchema.parse(request.body)))
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : /manager|access/i.test(message) ? 403 : 409).json({ error: message })
    }
  })

  app.post('/api/renewal-clients/:clientId/outreach/send', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const result = await renewalOutreach.send(activeWorkspaceId(response), request.params.clientId, renewalOutreachSendSchema.parse(request.body), response.locals.user as PublicUser)
      response.json(result)
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : /manager|access/i.test(message) ? 403 : 409).json({ error: message })
    }
  })

  app.post('/api/renewal-clients', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = renewalClientInputSchema.parse(request.body)
      const now = new Date().toISOString()
      let client: RenewalClientRecord | undefined
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        client = { id: `renewal-${randomBytes(8).toString('hex')}`, ...input, outreach: [], source: 'manual', createdAt: now, updatedAt: now }
        workspace.renewalClients.push(client)
      })
      response.status(201).json({ client })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(isValidationError(error) ? 400 : /not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.patch('/api/renewal-clients/:clientId', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = renewalClientPatchSchema.parse(request.body)
      let client: RenewalClientRecord | undefined
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        client = workspace?.renewalClients.find((item) => item.id === request.params.clientId)
        if (!client) throw new Error('Renewal client not found.')
        const completeInput = renewalClientInputSchema.parse({ ...renewalInputFromRecord(client), ...input })
        Object.assign(client, completeInput, { updatedAt: new Date().toISOString() })
      })
      response.json({ client })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(isValidationError(error) ? 400 : /not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.delete('/api/renewal-clients/:clientId', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        const index = workspace.renewalClients.findIndex((item) => item.id === request.params.clientId)
        if (index < 0) throw new Error('Renewal client not found.')
        workspace.renewalClients.splice(index, 1)
      })
      response.json({ ok: true })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(/not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.post('/api/renewal-clients/import-clickup', async (request, response) => {
    try {
      const actor = response.locals.user as PublicUser
      auth.requireDataEditor(actor)
      const input = clickUpRenewalImportSchema.parse(request.body)
      const now = new Date().toISOString()
      let result = { created: 0, updated: 0, unchanged: 0 }
      let clients: RenewalClientRecord[] = []
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        result = upsertClickUpRenewalClients(workspace, input.rows, now)
        workspace.clickUpRenewalImport = {
          fileName: input.fileName.split(/[\\/]/).at(-1) ?? 'ClickUp export.csv',
          importedAt: now,
          importedBy: actor.name,
          sourceRows: input.sourceRows,
          acceptedRows: input.rows.length,
          ...result,
        }
        clients = [...workspace.renewalClients].sort((left, right) => left.name.localeCompare(right.name))
      })
      response.json({ clients, clickUpImport: { fileName: input.fileName.split(/[\\/]/).at(-1) ?? 'ClickUp export.csv', importedAt: now, importedBy: actor.name, sourceRows: input.sourceRows, acceptedRows: input.rows.length, ...result }, result })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(isValidationError(error) ? 400 : /not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.get('/api/kpi-snapshots', async (_request, response) => {
    const state = await store.read()
    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
    if (!workspace) return response.status(404).json({ error: 'Workspace not found.' })
    response.json({ snapshots: [...workspace.kpiSnapshots].sort((left, right) => right.periodEnd.localeCompare(left.periodEnd) || right.updatedAt.localeCompare(left.updatedAt)) })
  })

  app.post('/api/kpi-snapshots', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = kpiSnapshotInputSchema.parse(request.body)
      const now = new Date().toISOString()
      let snapshot: KpiSnapshotRecord | undefined
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        snapshot = { id: `kpi-${randomBytes(8).toString('hex')}`, ...input, source: 'manual', createdAt: now, updatedAt: now }
        workspace.kpiSnapshots.push(snapshot)
      })
      response.status(201).json({ snapshot })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(isValidationError(error) ? 400 : /not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.post('/api/kpi-snapshots/import', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = kpiSnapshotInputSchema.parse(request.body)
      const now = new Date().toISOString()
      let snapshot: KpiSnapshotRecord | undefined
      let action: 'created' | 'updated' = 'created'
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        snapshot = workspace.kpiSnapshots.find((item) => item.periodStart === input.periodStart && item.periodEnd === input.periodEnd)
        if (snapshot) {
          Object.assign(snapshot, input, { source: 'csv' as const, updatedAt: now })
          action = 'updated'
        } else {
          snapshot = { id: `kpi-${randomBytes(8).toString('hex')}`, ...input, source: 'csv', createdAt: now, updatedAt: now }
          workspace.kpiSnapshots.push(snapshot)
        }
      })
      response.status(action === 'created' ? 201 : 200).json({ snapshot, action })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(isValidationError(error) ? 400 : /access|manager/i.test(message) ? 403 : 400).json({ error: message })
    }
  })

  app.patch('/api/kpi-snapshots/:snapshotId', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = kpiSnapshotPatchSchema.parse(request.body)
      let snapshot: KpiSnapshotRecord | undefined
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        snapshot = workspace?.kpiSnapshots.find((item) => item.id === request.params.snapshotId)
        if (!snapshot) throw new Error('KPI snapshot not found.')
        const completeInput = kpiSnapshotInputSchema.parse({ ...kpiInputFromRecord(snapshot), ...input })
        Object.assign(snapshot, completeInput, { updatedAt: new Date().toISOString() })
      })
      response.json({ snapshot })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(isValidationError(error) ? 400 : /not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.delete('/api/kpi-snapshots/:snapshotId', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        const index = workspace.kpiSnapshots.findIndex((item) => item.id === request.params.snapshotId)
        if (index < 0) throw new Error('KPI snapshot not found.')
        workspace.kpiSnapshots.splice(index, 1)
      })
      response.json({ ok: true })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(/not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.get('/api/imports', async (_request, response) => {
    const state = await store.read()
    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
    if (!workspace) return response.status(404).json({ error: 'Workspace not found.' })
    response.json({ workspace: workspace.imports })
  })

  app.put('/api/imports', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = z.object({ workspace: importWorkspaceSchema }).parse(request.body)
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        workspace.imports = input.workspace
      })
      response.json({ workspace: input.workspace })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.delete('/api/imports', async (_request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        workspace.imports = {}
      })
      response.json({ workspace: {} })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(/not found/i.test(message) ? 404 : 403).json({ error: message })
    }
  })

  app.get('/api/recovery-cases', async (_request, response) => {
    const state = await store.read()
    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
    if (!workspace) return response.status(404).json({ error: 'Workspace not found.' })
    response.json({ cases: [...workspace.recoveryCases].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) })
  })

  app.post('/api/recovery-cases/sync', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = z.object({ cases: z.array(detectedCaseSchema).max(100) }).parse(request.body)
      const actor = response.locals.user as PublicUser
      const now = new Date().toISOString()
      let cases = [] as NonNullable<(Awaited<ReturnType<typeof store.read>>['workspaces'][number])['recoveryCases']>
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        for (const detected of input.cases) {
          const existing = workspace.recoveryCases.find((item) => item.leakId === detected.leakId)
          if (!existing) {
            const id = `case-${randomBytes(8).toString('hex')}`
            workspace.recoveryCases.push({
              id,
              leakId: detected.leakId,
              type: detected.type,
              title: detected.title,
              description: detected.description,
              impact: detected.impact,
              affectedRecords: detected.affectedRecords,
              severity: detected.severity,
              status: 'detected',
              owner: detected.suggestedOwner,
              recoveredAmount: 0,
              actions: detected.suggestedActions.map((text, index) => ({ id: `${id}-action-${index + 1}`, text, completed: false })),
              notes: [],
              activity: [{ id: `activity-${randomBytes(8).toString('hex')}`, type: 'detected', text: `Leak detected with ${detected.affectedRecords} affected record${detected.affectedRecords === 1 ? '' : 's'} and ${detected.impact.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} estimated impact.`, createdAt: now, createdBy: 'LeakLine detection engine' }],
              createdAt: now,
              updatedAt: now,
            })
            continue
          }
          existing.type = detected.type
          existing.title = detected.title
          existing.description = detected.description
          existing.impact = detected.impact
          existing.affectedRecords = detected.affectedRecords
          existing.severity = detected.severity
          existing.actions = detected.suggestedActions.map((text, index) => existing.actions.find((action) => action.text === text) ?? ({ id: `${existing.id}-action-${index + 1}`, text, completed: false }))
          existing.updatedAt = now
        }
        cases = [...workspace.recoveryCases].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      })
      response.json({ cases })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.patch('/api/recovery-cases/:caseId', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = z.object({
        status: recoveryCaseStatusSchema.optional(),
        owner: z.string().min(1).max(100).optional(),
        deadline: z.string().date().nullable().optional(),
        recoveredAmount: z.number().min(0).max(100_000_000).optional(),
        resolution: z.string().min(3).max(1000).optional(),
        actionId: z.string().min(1).max(120).optional(),
        actionCompleted: z.boolean().optional(),
        note: z.string().min(2).max(1000).optional(),
      }).refine((value) => value.actionId === undefined || value.actionCompleted !== undefined, { message: 'Action completion is required when an action is selected.' }).parse(request.body)
      const actor = response.locals.user as PublicUser
      const actorName = actor.name || actor.email
      const now = new Date().toISOString()
      let updatedCase: NonNullable<(Awaited<ReturnType<typeof store.read>>['workspaces'][number])['recoveryCases'][number]> | undefined
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        const recoveryCase = workspace?.recoveryCases.find((item) => item.id === request.params.caseId)
        if (!recoveryCase) throw new Error('Recovery case not found.')
        const activity = (type: string, text: string) => recoveryCase.activity.unshift({ id: `activity-${randomBytes(8).toString('hex')}`, type, text, createdAt: now, createdBy: actorName })
        if (input.owner !== undefined && input.owner !== recoveryCase.owner) {
          recoveryCase.owner = input.owner.trim()
          activity('assignment', `Assigned to ${recoveryCase.owner}.`)
          if (recoveryCase.status === 'detected') recoveryCase.status = 'assigned'
        }
        if (input.deadline !== undefined && input.deadline !== recoveryCase.deadline) {
          recoveryCase.deadline = input.deadline ?? undefined
          activity('deadline', input.deadline ? `Deadline set for ${input.deadline}.` : 'Deadline removed.')
        }
        if (input.actionId !== undefined) {
          const action = recoveryCase.actions.find((item) => item.id === input.actionId)
          if (!action) throw new Error('Recovery action not found.')
          action.completed = Boolean(input.actionCompleted)
          action.completedAt = action.completed ? now : undefined
          action.completedBy = action.completed ? actorName : undefined
          activity('action', `${action.completed ? 'Completed' : 'Reopened'} action: ${action.text}`)
          if (action.completed && recoveryCase.status !== 'resolved') recoveryCase.status = 'in_progress'
        }
        if (input.note !== undefined) {
          recoveryCase.notes.unshift({ id: `note-${randomBytes(8).toString('hex')}`, text: input.note.trim(), createdAt: now, createdBy: actorName })
          activity('note', 'Added a case note.')
        }
        if (input.recoveredAmount !== undefined) recoveryCase.recoveredAmount = input.recoveredAmount
        if (input.resolution !== undefined) recoveryCase.resolution = input.resolution.trim()
        if (input.status !== undefined && input.status !== recoveryCase.status) {
          if (input.status === 'resolved' && !(input.resolution ?? recoveryCase.resolution)) throw new Error('Add a resolution before resolving this case.')
          recoveryCase.status = input.status
          if (input.status === 'resolved') {
            recoveryCase.resolvedAt = now
            activity('resolved', `Resolved with ${recoveryCase.recoveredAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} recovered.`)
          } else {
            recoveryCase.resolvedAt = undefined
            activity('status', `Status changed to ${input.status.replace('_', ' ')}.`)
          }
        }
        recoveryCase.updatedAt = now
        updatedCase = recoveryCase
      })
      response.json({ case: updatedCase })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : /access|manager/i.test(message) ? 403 : 400).json({ error: message })
    }
  })

  app.get('/api/integrations', async (_request, response, next) => { try { response.json(await service.snapshot(activeWorkspaceId(response))) } catch (error) { next(error) } })
  app.get('/api/calls', async (request, response, next) => { try { response.json({ calls: await service.calls(activeWorkspaceId(response), Number(request.query.limit ?? 50)) }) } catch (error) { next(error) } })
  app.post('/api/integrations/sync-all', async (_request, response, next) => { try { auth.requireDataEditor(response.locals.user as PublicUser); response.json(await service.syncAll(activeWorkspaceId(response))) } catch (error) { next(error) } })

  app.post('/api/integrations/google-calendar/configure', async (request, response, next) => {
    try {
      const config = z.object({ clientId: z.string().min(12), clientSecret: z.string().min(12) }).parse(request.body)
      auth.requireIntegrationManager(response.locals.user as PublicUser)
      response.json(await service.configureGoogleOAuth(activeWorkspaceId(response), config.clientId, config.clientSecret))
    } catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/connect', async (request, response, next) => {
    try {
      const provider = providerSchema.parse(request.params.provider)
      const actor = response.locals.user as PublicUser
      if (provider === 'clickup') auth.requireDataEditor(actor)
      else auth.requireIntegrationManager(actor)
      if (provider === 'google-calendar') return response.status(400).json({ error: 'Use the Google OAuth start endpoint.' })
      const credential = provider === 'stripe'
        ? z.object({ secretKey: z.string().min(20).regex(/^(sk|rk)_(test|live)_/, 'Use a Stripe secret or restricted key.') }).parse(request.body)
        : provider === 'whop'
          ? z.object({ apiKey: z.string().min(20), companyId: z.string().regex(/^biz_/, 'Use a Whop company ID beginning with biz_.'), sandbox: z.boolean().default(false) }).parse(request.body)
          : provider === 'fanbasis'
            ? z.object({ webhookSecret: z.string().min(24), accountLabel: z.string().min(2).max(100) }).parse(request.body)
        : provider === 'highlevel'
          ? z.object({ accessToken: z.string().min(20), locationId: z.string().min(5) }).parse(request.body)
          : provider === 'clickup'
            ? z.object({ apiToken: z.string().min(20).regex(/^pk_/, 'Use a ClickUp personal API token beginning with pk_.'), listId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Use the List ID from the ClickUp List URL.') }).parse(request.body)
          : z.object({ apiKey: z.string().min(10) }).parse(request.body)
      await service.connect(activeWorkspaceId(response), provider, credential as never)
      response.json(await service.snapshot(activeWorkspaceId(response)))
    } catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/sync', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); response.json(await service.sync(activeWorkspaceId(response), providerSchema.parse(request.params.provider))) }
    catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/sandbox-sync', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); response.json(await service.syncSandbox(activeWorkspaceId(response), providerSchema.parse(request.params.provider))) }
    catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/disconnect', async (request, response, next) => {
    try {
      const provider = providerSchema.parse(request.params.provider)
      const actor = response.locals.user as PublicUser
      if (provider === 'clickup') auth.requireDataEditor(actor)
      else auth.requireIntegrationManager(actor)
      await service.disconnect(activeWorkspaceId(response), provider)
      response.json(await service.snapshot(activeWorkspaceId(response)))
    }
    catch (error) { next(error) }
  })

  app.get('/api/integrations/google-calendar/start', async (_request, response, next) => {
    try { auth.requireIntegrationManager(response.locals.user as PublicUser); response.json({ url: await service.googleAuthorizationUrl(activeWorkspaceId(response)) }) }
    catch (error) { next(error) }
  })

  app.get('/api/integrations/google-calendar/callback', async (request, response, next) => {
    try {
      const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query)
      const actor = response.locals.user as PublicUser
      auth.requireIntegrationManager(actor)
      await service.finishGoogleAuthorization(query.code, query.state, new Set(actor.workspaces.map((workspace) => workspace.id)))
      response.redirect('/app?integration=google-calendar&connected=1')
    } catch (error) { next(error) }
  })

  const dist = join(process.cwd(), 'dist')
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }))
    app.get(/.*/, (request, response, next) => {
      const entry = frontendEntryForPath(request.path)
      return entry ? response.sendFile(join(dist, entry)) : next()
    })
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(', ') : safeErrorMessage(error)
    const permissionDenied = /access required|access denied|permission|owner access|manager access|admin access/i.test(message)
    const notFound = /not found/i.test(message)
    const stateConflict = /no longer|already|paused|reached|unresolved placeholder|approve .* before|cannot exceed/i.test(message)
    const payloadTooLarge = (error as { status?: number }).status === 413
    response.status(error instanceof z.ZodError ? 400 : payloadTooLarge ? 413 : permissionDenied ? 403 : notFound ? 404 : stateConflict ? 409 : 502).json({ error: message })
  })
  return app
}
