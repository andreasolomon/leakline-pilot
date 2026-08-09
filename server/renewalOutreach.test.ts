import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { buildRenewalMessage, buildRenewalReplySuggestion, RenewalOutreachService, renewalOutreachEligibility, renewalOutreachPhase } from './renewalOutreach.js'
import { EncryptedStore } from './store.js'
import type { RenewalClientRecord } from './types.js'

const originalAuthDisabled = process.env.LEAKLINE_AUTH_DISABLED
const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalAuthDisabled === undefined) delete process.env.LEAKLINE_AUTH_DISABLED
  else process.env.LEAKLINE_AUTH_DISABLED = originalAuthDisabled
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

function dateDaysAgo(days: number) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function renewalClient(overrides: Partial<RenewalClientRecord> = {}): RenewalClientRecord {
  const now = new Date().toISOString()
  return {
    id: 'renewal-test',
    name: 'Pilot Client',
    email: 'pilot@example.com',
    owner: 'Yonas',
    firstWebinarAt: dateDaysAgo(70),
    lastWebinarAt: dateDaysAgo(5),
    webinarsHosted: 5,
    renewalStatus: 'not_started',
    expectedRenewalValue: 8_000,
    renewalCashCollected: 0,
    outreach: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe.sequential('assisted renewal outreach', () => {
  it('opens after activation, recognises inactivity and stops after a call is booked', () => {
    expect(renewalOutreachEligibility(renewalClient()).available).toBe(true)
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: undefined }))).toMatchObject({ available: false, phase: 'awaiting_activation' })
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: dateDaysAgo(20), lastWebinarAt: dateDaysAgo(3) }))).toMatchObject({ available: true, phase: 'active' })
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: dateDaysAgo(20), lastWebinarAt: dateDaysAgo(14) }))).toMatchObject({ available: true, phase: 'inactive' })
    expect(renewalOutreachEligibility(renewalClient({ renewalStatus: 'call_booked' }))).toMatchObject({ available: false })
    expect(renewalOutreachEligibility(renewalClient({ renewalStatus: 'renewed' }))).toMatchObject({ available: false })
  })

  it('builds genuinely different messages for each client phase', () => {
    const client = renewalClient({ firstWebinarAt: dateDaysAgo(100), lastWebinarAt: dateDaysAgo(20) })
    expect(renewalOutreachPhase(client)).toBe('completion_overdue')
    expect(buildRenewalMessage(client, 'programme_check_in', 60, 'LaunchWebinars').body).toBe('Hey Pilot, Yonas here from Launch Webinars. Quick check-in: how are things going with the program so far? Is anything getting in the way of your next webinar or the results you’re aiming for?')
    expect(buildRenewalMessage(client, 'webinar_accountability', 60, 'LaunchWebinars').body).toMatch(/anything blocking you from getting the next one booked/i)
    expect(buildRenewalMessage(client, 'renewal_window_review', 20, 'LaunchWebinars').body).toMatch(/what would you still like help with before it ends/i)
    expect(buildRenewalMessage(client, 'post_completion_review', -10, 'LaunchWebinars').body).toMatch(/what results did you get from the webinars you ran/i)
  })

  it('uses a gentle bump once and then closes the loop without repeating itself', () => {
    const client = renewalClient({ firstWebinarAt: dateDaysAgo(100), outreach: [{
      id: 'follow-up-1', direction: 'outbound', channel: 'sms', kind: 'no_response_follow_up', templateKey: 'no_response_follow_up', body: 'First follow-up', deliveryStatus: 'sent', createdAt: new Date().toISOString(), createdBy: 'Yonas',
    }] })
    expect(buildRenewalMessage(renewalClient({ firstWebinarAt: dateDaysAgo(100) }), 'no_response_follow_up', -10, 'LaunchWebinars')).toMatchObject({ templateKey: 'no_response_follow_up', body: expect.stringMatching(/in case my last message got buried/i) })
    expect(buildRenewalMessage(client, 'no_response_follow_up', -10, 'LaunchWebinars')).toMatchObject({ templateKey: 'no_response_close_loop', body: expect.stringMatching(/last check-in from me/i) })
  })

  it('suggests the next response without forcing ambiguous replies into a renewal pitch', () => {
    const client = renewalClient()
    expect(buildRenewalReplySuggestion(client, 'Yes, I would be interested in continuing.', 'LaunchWebinars')).toMatchObject({
      intent: 'ready_to_continue',
      body: expect.stringMatching(/what day and time works best/i),
    })
    expect(buildRenewalReplySuggestion(client, 'It was good and we got solid results.', 'LaunchWebinars')).toMatchObject({
      intent: 'positive_feedback',
      body: expect.stringMatching(/what result are you happiest with/i),
    })
    expect(buildRenewalReplySuggestion(client, 'We have struggled with the tech for our webinars.', 'LaunchWebinars')).toMatchObject({
      intent: 'webinar_blocked',
      body: expect.stringMatching(/main blocker/i),
    })
    expect(buildRenewalReplySuggestion(client, 'It is too expensive for us right now.', 'LaunchWebinars')).toMatchObject({
      intent: 'timing_or_budget',
      body: expect.stringMatching(/budget, timing/i),
    })
    expect(buildRenewalReplySuggestion(client, 'I am disappointed and the program did not work as expected.', 'LaunchWebinars')).toMatchObject({
      intent: 'needs_support',
      recommendedNextAction: expect.stringMatching(/before moving.*renewal/i),
    })
    expect(buildRenewalReplySuggestion(client, 'No thanks, I am not interested in continuing.', 'LaunchWebinars')).toMatchObject({
      intent: 'not_interested',
      recommendedNextAction: expect.stringMatching(/mark the renewal as declined/i),
    })
    expect(buildRenewalReplySuggestion(client, 'Stop messaging me.', 'LaunchWebinars')).toMatchObject({
      intent: 'opt_out',
      recommendedNextAction: expect.stringMatching(/do not send further/i),
    })
    expect(buildRenewalReplySuggestion(client, 'Maybe, I am not really sure.', 'LaunchWebinars')).toMatchObject({
      intent: 'unclear',
      body: expect.stringMatching(/what has gone best/i),
    })
  })

  it('requires approval, records one idempotent send and captures replies for later analysis', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_DISABLED = 'true'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-renewal-outreach-'))
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store)
      const created = await request(app).post('/api/renewal-clients').send({
        name: 'Pilot Client',
        email: 'pilot@example.com',
        owner: 'Yonas',
        firstWebinarAt: dateDaysAgo(70),
        lastWebinarAt: dateDaysAgo(5),
        webinarsHosted: 5,
        feedbackScore: null,
        feedbackNote: '',
        renewalCallAt: '',
        renewalStatus: 'not_started',
        expectedRenewalValue: 8_000,
        renewalCashCollected: 0,
        nextAction: '',
      }).expect(201)
      const clientId = created.body.client.id as string
      const workspaceId = (await store.read()).workspaces[0].id
      await store.update((state) => {
        const workspace = state.workspaces[0]
        workspace.connections.highlevel = { mode: 'sandbox', connectedAt: new Date().toISOString(), recordCounts: { leads: 1 } }
        workspace.workspace.leads = {
          kind: 'leads',
          fileName: 'GoHighLevel sandbox',
          rows: [{ id: 'contact-pilot', name: 'Pilot Client', email: 'pilot@example.com', phone: '+15550000000' }],
          sourceRows: 1,
          issues: [],
          mappedFields: ['id', 'name', 'email', 'phone'],
          headers: ['id', 'name', 'email', 'phone'],
          mapping: { id: 'id', name: 'name', email: 'email', phone: 'phone' },
        }
      })

      const preview = await request(app).post(`/api/renewal-clients/${clientId}/outreach/preview`).send({ channel: 'email', kind: 'feedback_request' }).expect(200)
      expect(preview.body).toMatchObject({ canSend: true, to: 'pilot@example.com', templateKey: 'feedback_request' })
      await request(app).post(`/api/renewal-clients/${clientId}/outreach/send`).send({ channel: 'email', kind: 'feedback_request', subject: preview.body.subject, body: preview.body.body, approved: false, idempotencyKey: 'attempt-not-approved' }).expect(400)

      const payload = { channel: 'email', kind: 'feedback_request', subject: preview.body.subject, body: preview.body.body, approved: true, idempotencyKey: 'renewal-send-once' }
      const sent = await request(app).post(`/api/renewal-clients/${clientId}/outreach/send`).send(payload).expect(200)
      expect(sent.body).toMatchObject({ simulated: true, replayed: false, client: { renewalStatus: 'conversation_needed', crmContactId: 'contact-pilot' } })
      expect(sent.body.client.outreach).toHaveLength(1)

      const replayed = await request(app).post(`/api/renewal-clients/${clientId}/outreach/send`).send(payload).expect(200)
      expect(replayed.body).toMatchObject({ replayed: true })
      expect(replayed.body.client.outreach).toHaveLength(1)

      const service = new RenewalOutreachService(store)
      await service.recordInbound(workspaceId, clientId, { channel: 'email', body: 'Yes, I would like to discuss continuing.', providerMessageId: 'reply-once' }, 'Pilot Client')
      const snapshot = await request(app).get('/api/renewal-clients').expect(200)
      const updated = snapshot.body.clients.find((client: { id: string }) => client.id === clientId)
      expect(updated.outreach).toHaveLength(2)
      expect(updated.outreach[1]).toMatchObject({ direction: 'inbound', deliveryStatus: 'received' })
      expect(updated.nextAction).toMatch(/review the client reply/i)

      await request(app).post(`/api/renewal-clients/${clientId}/outreach/preview`).send({ channel: 'email', kind: 'no_response_follow_up' }).expect(409)
      await request(app).patch(`/api/renewal-clients/${clientId}`).send({ renewalStatus: 'call_booked' }).expect(200)
      const stopped = await request(app).post(`/api/renewal-clients/${clientId}/outreach/preview`).send({ channel: 'email', kind: 'renewal_invitation' }).expect(200)
      expect(stopped.body).toMatchObject({ canSend: false })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sends an approved renewal SMS through Quo without requiring a GoHighLevel contact', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_DISABLED = 'true'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-renewal-quo-'))
    let includeAnsweredReply = false
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/messages') && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'AC123', conversationId: 'CN123' } }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('https://api.quo.com/v1/messages?') && !init?.method) return new Response(JSON.stringify({ data: [
        { id: 'AC-out', from: '+15551234567', to: ['+15550000000'], text: 'How has the program been going?', status: 'sent', createdAt: '2026-08-01T10:00:00.000Z', conversationId: 'CN123' },
        { id: 'AC-in', from: '+15550000000', to: ['+15551234567'], text: 'It has been great. Can we discuss continuing?', status: 'received', createdAt: '2026-08-01T10:05:00.000Z', conversationId: 'CN123' },
        ...(includeAnsweredReply ? [{ id: 'AC-reply', from: '+15551234567', to: ['+15550000000'], text: 'Absolutely. What time works best?', status: 'sent', createdAt: '2026-08-01T10:06:00.000Z', conversationId: 'CN123' }] : []),
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store, fetcher)
      const created = await request(app).post('/api/renewal-clients').send({
        name: 'Pilot Client',
        email: '',
        phone: '+15550000000',
        owner: 'Yonas',
        firstWebinarAt: dateDaysAgo(70),
        lastWebinarAt: dateDaysAgo(5),
        webinarsHosted: 5,
        feedbackScore: null,
        feedbackNote: '',
        renewalCallAt: '',
        renewalStatus: 'not_started',
        expectedRenewalValue: 8_000,
        renewalCashCollected: 0,
        nextAction: '',
      }).expect(201)
      await store.update((state) => {
        state.workspaces[0].credentials.quo = { apiKey: 'quo-secret', from: '+15551234567', phoneNumberId: 'PN123' }
        state.workspaces[0].connections.quo = { connectedAt: new Date().toISOString(), accountLabel: 'Renewals · +15551234567', mode: 'live' }
      })

      const clientId = created.body.client.id as string
      const preview = await request(app).post(`/api/renewal-clients/${clientId}/outreach/preview`).send({ channel: 'sms', kind: 'renewal_invitation' }).expect(200)
      expect(preview.body).toMatchObject({ canSend: true, to: '+15550000000', quoConnected: true, contactMatched: false })
      const sent = await request(app).post(`/api/renewal-clients/${clientId}/outreach/send`).send({ channel: 'sms', kind: 'renewal_invitation', body: preview.body.body, approved: true, idempotencyKey: 'quo-renewal-send' }).expect(200)
      expect(sent.body.activity).toMatchObject({ providerMessageId: 'AC123', conversationId: 'CN123', deliveryStatus: 'sent' })
      const conversation = await request(app).get(`/api/renewal-clients/${clientId}/conversation`).expect(200)
      expect(conversation.body.messages).toEqual([
        expect.objectContaining({ id: 'AC-out', direction: 'outbound' }),
        expect.objectContaining({ id: 'AC-in', direction: 'inbound', body: 'It has been great. Can we discuss continuing?' }),
      ])
      expect(conversation.body.suggestion).toMatchObject({ sourceMessageId: 'AC-in', intent: 'ready_to_continue', body: expect.stringMatching(/what day and time works best/i) })
      await request(app).post(`/api/renewal-clients/${clientId}/conversation/send`).send({ body: 'Absolutely. What time works best?', idempotencyKey: 'quo-reply-unapproved' }).expect(400)
      const approvedReply = { body: 'Absolutely. What time works best?', approved: true, idempotencyKey: 'quo-conversation-reply' }
      const reply = await request(app).post(`/api/renewal-clients/${clientId}/conversation/send`).send(approvedReply).expect(200)
      expect(reply.body.activity).toMatchObject({ templateKey: 'conversation_reply', providerMessageId: 'AC123', deliveryStatus: 'sent' })
      expect(fetcher).toHaveBeenCalledWith('https://api.quo.com/v1/messages', expect.objectContaining({ method: 'POST' }))
      const sentMessageCalls = fetcher.mock.calls.filter(([input, init]) => String(input) === 'https://api.quo.com/v1/messages' && init?.method === 'POST').length
      const replayedReply = await request(app).post(`/api/renewal-clients/${clientId}/conversation/send`).send(approvedReply).expect(200)
      expect(replayedReply.body).toMatchObject({ replayed: true })
      expect(fetcher.mock.calls.filter(([input, init]) => String(input) === 'https://api.quo.com/v1/messages' && init?.method === 'POST')).toHaveLength(sentMessageCalls)

      includeAnsweredReply = true
      const answeredConversation = await request(app).get(`/api/renewal-clients/${clientId}/conversation`).expect(200)
      expect(answeredConversation.body.messages.at(-1)).toMatchObject({ id: 'AC-reply', direction: 'outbound' })
      expect(answeredConversation.body.suggestion).toBeUndefined()

      const active = await request(app).post('/api/renewal-clients').send({
        name: 'Active Client',
        email: '',
        phone: '+15550000001',
        owner: 'Yonas',
        firstWebinarAt: dateDaysAgo(20),
        lastWebinarAt: dateDaysAgo(3),
        webinarsHosted: 2,
        feedbackScore: null,
        feedbackNote: '',
        renewalCallAt: '',
        renewalStatus: 'not_started',
        expectedRenewalValue: 8_000,
        renewalCashCollected: 0,
        nextAction: '',
      }).expect(201)
      const activePreview = await request(app).post(`/api/renewal-clients/${active.body.client.id}/outreach/preview`).send({ channel: 'sms', kind: 'programme_check_in' }).expect(200)
      const activeSent = await request(app).post(`/api/renewal-clients/${active.body.client.id}/outreach/send`).send({ channel: 'sms', kind: 'programme_check_in', body: activePreview.body.body, approved: true, idempotencyKey: 'quo-programme-check-in' }).expect(200)
      expect(activeSent.body.client).toMatchObject({ renewalStatus: 'not_started' })
      expect(activeSent.body.client.nextAction).toMatch(/resolve any delivery issue/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
