import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHmac } from 'node:crypto'
import { classifyPayment, classifyRecoveryReply, reconcilePaymentRecoveryCases, safeHostedPaymentUrl } from './paymentRecovery.js'
import { defaultPilotValidation, defaultRecoveryPolicy, EncryptedStore } from './store.js'
import type { WorkspaceRecord } from './types.js'
import { createApp } from './app.js'
import { normalizeFanBasisPayment } from './providers.js'

function workspace(rows: Array<Record<string, string | number | boolean | null>>): WorkspaceRecord {
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return {
    id: 'workspace-test', name: 'Test', clientName: 'Test Company', createdAt: '2026-07-01T00:00:00.000Z', credentials: {}, connections: {}, oauthConfig: {}, calls: [], oauthStates: {}, recoveryCases: [], paymentRecoveryCases: [], recoveryPolicy: defaultRecoveryPolicy('Test Company'), pilotValidation: defaultPilotValidation(),
    workspace: { payments: { kind: 'payments', fileName: 'test', rows, sourceRows: rows.length, issues: [], mappedFields: fields, headers: fields, mapping: Object.fromEntries(fields.map((field) => [field, field])) } },
  }
}

describe('assisted payment recovery', () => {
  it('routes hard, retryable and human-review failures to distinct actions', () => {
    expect(classifyPayment({ failure_code: 'expired_card' })).toBe('payment_method_required')
    expect(classifyPayment({ failure_code: 'authentication_required' })).toBe('authentication_required')
    expect(classifyPayment({ failure_code: 'insufficient_funds', next_retry_at: '2026-07-20T10:00:00.000Z' })).toBe('retryable_failure')
    expect(classifyPayment({ failure_reason: 'Customer raised a dispute', manual_review: true })).toBe('human_review')
  })

  it('creates one provider-specific case and does not duplicate it on replay', () => {
    const target = workspace([{ id: 'pay_1', invoice_id: 'pay_1', payment_provider: 'whop', customer: 'Maya Brown', amount: 2500, currency: 'USD', status: 'failed', due_at: '2026-07-10T00:00:00.000Z', failure_code: 'insufficient_funds' }])
    reconcilePaymentRecoveryCases(target, '2026-07-18T12:00:00.000Z')
    reconcilePaymentRecoveryCases(target, '2026-07-18T12:05:00.000Z')
    expect(target.paymentRecoveryCases).toHaveLength(1)
    expect(target.paymentRecoveryCases[0]).toMatchObject({ provider: 'whop', sourcePaymentId: 'pay_1', amountDue: 2500 })
  })

  it('attributes a later successful payment only to the matching case', () => {
    const target = workspace([
      { id: 'in_1', invoice_id: 'in_1', payment_provider: 'stripe', customer: 'Nina', amount: 1200, currency: 'USD', status: 'failed', due_at: '2026-07-10T00:00:00.000Z' },
      { id: 'in_2', invoice_id: 'in_2', payment_provider: 'stripe', customer: 'Leo', amount: 1800, currency: 'USD', status: 'failed', due_at: '2026-07-10T00:00:00.000Z' },
    ])
    reconcilePaymentRecoveryCases(target, '2026-07-11T00:00:00.000Z')
    const ninaCase = target.paymentRecoveryCases.find((item) => item.sourcePaymentId === 'in_1')!
    ninaCase.promises.push({ id: 'promise-nina', amount: 1200, dueAt: '2026-07-13T09:00:00.000Z', status: 'pending', createdAt: '2026-07-11T08:00:00.000Z', createdBy: 'Operator' })
    ninaCase.followUps.push({ id: 'follow-up-promise-nina', kind: 'promise_due', channel: 'email', dueAt: '2026-07-13T09:00:00.000Z', status: 'scheduled', attemptNumber: 1, reason: 'Promise promise-nina passed without a verified payment.', createdAt: '2026-07-11T08:00:00.000Z' })
    target.workspace.payments!.rows = [{ id: 'in_1', invoice_id: 'in_1', payment_provider: 'stripe', customer: 'Nina', amount: 1200, currency: 'USD', status: 'paid', due_at: '2026-07-10T00:00:00.000Z', paid_at: '2026-07-12T00:00:00.000Z' }]
    reconcilePaymentRecoveryCases(target, '2026-07-12T00:00:00.000Z')
    expect(target.paymentRecoveryCases.find((item) => item.sourcePaymentId === 'in_1')?.outcome).toMatchObject({ amount: 1200, source: 'provider_sync' })
    expect(ninaCase.promises[0].status).toBe('kept')
    expect(ninaCase.followUps[0].status).toBe('cancelled')
    expect(target.paymentRecoveryCases.find((item) => item.sourcePaymentId === 'in_2')?.status).not.toBe('recovered')
  })

  it('does not cross-attribute identical IDs from different processors', () => {
    const target = workspace([
      { id: 'shared_1', invoice_id: 'shared_1', payment_provider: 'stripe', customer: 'Stripe customer', amount: 1000, status: 'failed', due_at: '2026-07-10T00:00:00.000Z' },
      { id: 'shared_1', invoice_id: 'shared_1', payment_provider: 'whop', customer: 'Whop customer', amount: 2000, status: 'failed', due_at: '2026-07-10T00:00:00.000Z' },
    ])
    reconcilePaymentRecoveryCases(target)
    expect(target.paymentRecoveryCases).toHaveLength(2)
    expect(new Set(target.paymentRecoveryCases.map((item) => item.provider))).toEqual(new Set(['stripe', 'whop']))
  })

  it('only permits provider-hosted HTTPS recovery links', () => {
    expect(safeHostedPaymentUrl('https://invoice.stripe.com/i/example')).toContain('stripe.com')
    expect(safeHostedPaymentUrl('https://whop.com/manage/example')).toContain('whop.com')
    expect(safeHostedPaymentUrl('https://fanbasis.com/pay/example')).toContain('fanbasis.com')
    expect(safeHostedPaymentUrl('https://attacker.example/pay')).toBeUndefined()
    expect(safeHostedPaymentUrl('http://stripe.com/pay')).toBeUndefined()
  })

  it('normalises FanBasis bridge statuses into the shared payment model', () => {
    expect(normalizeFanBasisPayment({ transaction_id: 'fb_1', status: 'declined', amount: 1500, email: 'buyer@example.com' })).toMatchObject({ id: 'fb_1', payment_provider: 'fanbasis', status: 'failed', amount: 1500 })
    expect(normalizeFanBasisPayment({ transaction_id: 'fb_2', status: 'completed', amount: 1500 })).toMatchObject({ status: 'paid' })
  })

  it('accepts only correctly signed FanBasis recovery bridge events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-fanbasis-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const secret = 'fanbasis-test-secret-1234567890'
      await request(app).post('/api/integrations/fanbasis/connect').send({ webhookSecret: secret, accountLabel: 'FanBasis pilot' }).expect(200)
      const payload = { payments: [{ transaction_id: 'fb_live_1', status: 'declined', amount: 2200, currency: 'USD', customer_name: 'Pilot Buyer', email: 'buyer@example.com', due_at: '2026-07-10T00:00:00.000Z', payment_link: 'https://fanbasis.com/pay/example' }] }
      await request(app).post('/api/payment-sources/fanbasis/workspace-ascend-growth/events').set('x-leakline-signature', 'bad').send(payload).expect(403)
      const signature = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
      await request(app).post('/api/payment-sources/fanbasis/workspace-ascend-growth/events').set('x-leakline-signature', signature).send(payload).expect(202)
      const snapshot = await request(app).get('/api/payment-recovery').expect(200)
      expect(snapshot.body.cases).toContainEqual(expect.objectContaining({ provider: 'fanbasis', sourcePaymentId: 'fb_live_1', amountDue: 2200 }))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires explicit approval and records sample outreach without sending externally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-'))
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store)
      const seeded = await request(app).post('/api/payment-recovery/sample').expect(200)
      const recoveryCase = seeded.body.cases.find((item: { classification: string }) => item.classification === 'retryable_failure')
      await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/send`).send({ channel: 'sms', approved: false }).expect(400)
      const preview = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/preview`).send({ channel: 'sms' }).expect(200)
      expect(preview.body.body).toContain('securely here')
      const sent = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/send`).send({ channel: 'sms', approved: true }).expect(200)
      expect(sent.body).toMatchObject({ simulated: true })
      expect(sent.body.case.attempts[0]).toMatchObject({ channel: 'sms', simulated: true })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('persists the founding pilot baseline and operating evidence per workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-pilot-scorecard-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const updated = await request(app).patch('/api/payment-recovery/pilot-validation').send({
        monthlyFee: 499,
        startedAt: '2026-07-18',
        baselineWindowDays: 60,
        historicEligibleBalance: 18_000,
        historicRecoveredAmount: 4_500,
        onboardingMinutes: 95,
        supportMinutes: 120,
        renewalStatus: 'undecided',
        notes: 'Baseline confirmed with the operator.',
      }).expect(200)
      expect(updated.body.pilotValidation).toMatchObject({ monthlyFee: 499, baselineWindowDays: 60, historicEligibleBalance: 18_000, onboardingMinutes: 95, renewalStatus: 'undecided' })
      expect(updated.body.pilotValidation.updatedBy).toBeTruthy()
      const reloaded = await request(app).get('/api/payment-recovery').expect(200)
      expect(reloaded.body.pilotValidation.notes).toBe('Baseline confirmed with the operator.')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('routes customer replies into safe assisted actions', () => {
    expect(classifyRecoveryReply('Can you send me the payment link?')).toMatchObject({ intent: 'payment_link', pauseRoutine: false })
    expect(classifyRecoveryReply("I can't afford this right now")).toMatchObject({ intent: 'hardship', pauseRoutine: true })
    expect(classifyRecoveryReply('I want a refund and will dispute this')).toMatchObject({ intent: 'dispute_or_refund', pauseRoutine: true })
    expect(classifyRecoveryReply('Stop messaging me')).toMatchObject({ intent: 'opt_out', pauseRoutine: true })
  })

  it('creates an editable assisted reply from an inbound response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-reply-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const seeded = await request(app).post('/api/payment-recovery/sample').expect(200)
      const recoveryCase = seeded.body.cases.find((item: { customerName: string }) => item.customerName === 'Nina Patel')
      const received = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/inbound`).send({ channel: 'sms', body: 'Can you send me the link so I can pay?' }).expect(200)
      expect(received.body.case.attempts[0]).toMatchObject({ direction: 'inbound', intent: 'payment_link' })
      expect(received.body.case.suggestions[0]).toMatchObject({ intent: 'payment_link', status: 'draft', channel: 'sms' })
      expect(received.body.case.suggestions[0].body).toContain('invoice.stripe.com')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('prepares due no-response follow-ups and requires approval before sending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-follow-up-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const seeded = await request(app).post('/api/payment-recovery/sample').expect(200)
      const recoveryCase = seeded.body.cases.find((item: { customerName: string }) => item.customerName === 'Leo Carter')
      const followUp = recoveryCase.followUps.find((item: { kind: string; status: string }) => item.kind === 'no_response' && item.status === 'due')
      const prepared = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/follow-ups/${followUp.id}/prepare`).expect(200)
      expect(prepared.body.suggestion).toMatchObject({ followUpId: followUp.id, status: 'draft' })
      await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/suggestions/${prepared.body.suggestion.id}/send`).send({ body: prepared.body.suggestion.body, approved: false }).expect(400)
      const sent = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/suggestions/${prepared.body.suggestion.id}/send`).send({ body: prepared.body.suggestion.body, approved: true }).expect(200)
      expect(sent.body.simulated).toBe(true)
      expect(sent.body.case.followUps.find((item: { id: string }) => item.id === followUp.id)).toMatchObject({ status: 'completed' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('turns a customer promise reply into one tracked deadline and an exact confirmation draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-promise-reply-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const seeded = await request(app).post('/api/payment-recovery/sample').expect(200)
      const recoveryCase = seeded.body.cases.find((item: { customerName: string }) => item.customerName === 'Nina Patel')
      const received = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/inbound`).send({ channel: 'sms', body: 'I can pay the full amount next Friday.' }).expect(200)
      const suggestion = received.body.case.suggestions[0]
      expect(suggestion).toMatchObject({ intent: 'promise_to_pay', status: 'draft' })
      const firstDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
      const recorded = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/suggestions/${suggestion.id}/promise`).send({ amount: 2400, dueDate: firstDate, note: 'Customer confirmed the full amount.' }).expect(200)
      expect(recorded.body.case).toMatchObject({ status: 'promise_pending' })
      expect(recorded.body.case.promises.filter((item: { status: string }) => item.status === 'pending')).toHaveLength(1)
      expect(recorded.body.suggestion.body).toContain('$2,400.00')
      expect(recorded.body.suggestion.body).toContain('We’ve recorded your promise')

      const replacementDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
      const replaced = await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/suggestions/${suggestion.id}/promise`).send({ amount: 1800, dueDate: replacementDate, note: 'Customer changed the date and amount.' }).expect(200)
      expect(replaced.body.case.promises.filter((item: { status: string }) => item.status === 'pending')).toHaveLength(1)
      expect(replaced.body.case.promises.filter((item: { status: string }) => item.status === 'cancelled')).toHaveLength(1)
      expect(replaced.body.suggestion.body).toContain('$1,800.00')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects promise dates that already passed in the workspace timezone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-promise-date-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const seeded = await request(app).post('/api/payment-recovery/sample').expect(200)
      const recoveryCase = seeded.body.cases.find((item: { customerName: string }) => item.customerName === 'Nina Patel')
      await request(app).post(`/api/payment-recovery/cases/${recoveryCase.id}/promises`).send({ amount: 1000, dueDate: '2020-01-01' }).expect(400)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('accepts idempotent signed-development GoHighLevel inbound events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-ghl-inbound-'))
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store)
      await request(app).post('/api/payment-recovery/sample').expect(200)
      await store.update((state) => { state.workspaces[0].credentials.highlevel = { accessToken: 'pilot-token', locationId: 'location-pilot' } })
      const payload = { type: 'InboundMessage', locationId: 'location-pilot', contactId: 'L-SBX-1', conversationId: 'conversation-pilot', messageId: 'message-once', body: 'Can you send the payment link?', messageType: 'SMS', direction: 'inbound' }
      await request(app).post('/api/webhooks/highlevel/inbound').set('x-leakline-test-webhook', 'true').send(payload).expect(202)
      const replay = await request(app).post('/api/webhooks/highlevel/inbound').set('x-leakline-test-webhook', 'true').send(payload).expect(200)
      expect(replay.body.ignored).toBe('duplicate_message')
      const snapshot = await request(app).get('/api/payment-recovery').expect(200)
      const recoveryCase = snapshot.body.cases.find((item: { customerName: string }) => item.customerName === 'Maya Brown')
      expect(recoveryCase.attempts.filter((item: { providerMessageId?: string }) => item.providerMessageId === 'message-once')).toHaveLength(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('routes a GoHighLevel reply to the matching conversation when a contact has multiple active instalments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-ghl-conversation-'))
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store)
      await request(app).post('/api/payment-recovery/sample').expect(200)
      let expectedCaseId = ''
      let otherCaseId = ''
      await store.update((state) => {
        const workspace = state.workspaces[0]
        workspace.credentials.highlevel = { accessToken: 'pilot-token', locationId: 'location-pilot' }
        const original = workspace.paymentRecoveryCases.find((item) => item.contactId === 'L-SBX-1')!
        otherCaseId = original.id
        original.conversationId = 'conversation-old'
        original.attempts.unshift({ id: 'outbound-old', channel: 'sms', direction: 'outbound', summary: 'Older instalment outreach', createdAt: '2026-07-01T10:00:00.000Z', createdBy: 'Andrea' })
        const matching = structuredClone(original)
        matching.id = `${original.id}-second-instalment`
        matching.sourcePaymentId = `${original.sourcePaymentId}-second-instalment`
        matching.conversationId = 'conversation-new'
        matching.attempts = [{ id: 'outbound-new', channel: 'sms', direction: 'outbound', summary: 'Newer instalment outreach', createdAt: '2026-07-10T10:00:00.000Z', createdBy: 'Andrea' }]
        matching.suggestions = []
        matching.updatedAt = '2026-07-10T10:00:00.000Z'
        expectedCaseId = matching.id
        workspace.paymentRecoveryCases.push(matching)
      })

      const received = await request(app).post('/api/webhooks/highlevel/inbound').set('x-leakline-test-webhook', 'true').send({ type: 'InboundMessage', locationId: 'location-pilot', contactId: 'L-SBX-1', conversationId: 'conversation-new', messageId: 'conversation-specific-message', body: 'I can pay this instalment Friday', messageType: 'SMS' }).expect(202)
      expect(received.body.caseId).toBe(expectedCaseId)
      const saved = await store.read()
      const cases = saved.workspaces[0].paymentRecoveryCases
      expect(cases.find((item) => item.id === expectedCaseId)?.attempts.some((attempt) => attempt.providerMessageId === 'conversation-specific-message')).toBe(true)
      expect(cases.find((item) => item.id === otherCaseId)?.attempts.some((attempt) => attempt.providerMessageId === 'conversation-specific-message')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
