import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { buildRenewalMessage, buildRenewalReplySuggestion, RenewalOutreachService, renewalFollowUpReadiness, renewalOutreachEligibility, renewalOutreachPhase } from './renewalOutreach.js'
import { EncryptedStore } from './store.js'
import type { RenewalClientRecord, RenewalOutreachActivityRecord } from './types.js'

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
  it('limits the campaign to approved, recently active clients in their final 30 days', () => {
    expect(renewalOutreachEligibility(renewalClient()).available).toBe(true)
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: undefined }))).toMatchObject({ available: false, phase: 'awaiting_activation' })
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: dateDaysAgo(20), lastWebinarAt: dateDaysAgo(3) }))).toMatchObject({ available: false, phase: 'active' })
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: dateDaysAgo(70), lastWebinarAt: dateDaysAgo(14) }))).toMatchObject({ available: false, phase: 'renewal_window', reason: expect.stringMatching(/recent webinar activity/i) })
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: dateDaysAgo(100), lastWebinarAt: dateDaysAgo(5) }))).toMatchObject({ available: false, phase: 'completion_overdue', reason: expect.stringMatching(/excluded/i) })
    expect(renewalOutreachEligibility(renewalClient({ renewalStatus: 'call_booked' }))).toMatchObject({ available: false })
    expect(renewalOutreachEligibility(renewalClient({ renewalStatus: 'renewed' }))).toMatchObject({ available: false })
    expect(renewalOutreachEligibility(renewalClient({ outreachStatus: 'paused', outreachStatusReason: 'Not in the approved campaign list.' }))).toMatchObject({ available: false, reason: 'Not in the approved campaign list.' })
    expect(renewalOutreachEligibility(renewalClient({ outreachStatus: 'do_not_contact' }))).toMatchObject({ available: false, reason: expect.stringMatching(/do not contact/i) })
  })

  it('enforces a 48-hour first follow-up, a 72-hour final follow-up and a hard two-message cap', () => {
    const now = new Date('2026-08-11T12:00:00.000Z')
    const outbound = (id: string, createdAt: string, kind: RenewalOutreachActivityRecord['kind'] = 'post_completion_review') => ({
      id, direction: 'outbound' as const, channel: 'sms' as const, kind, templateKey: kind, body: 'Campaign message', deliveryStatus: 'sent' as const, createdAt, createdBy: 'Yonas',
    })
    expect(renewalFollowUpReadiness(renewalClient({ outreach: [outbound('opening', '2026-08-10T12:01:00.000Z')] }), now)).toMatchObject({ available: false, followUpCount: 0 })
    expect(renewalFollowUpReadiness(renewalClient({ outreach: [outbound('opening', '2026-08-09T11:59:00.000Z')] }), now)).toMatchObject({ available: true, followUpCount: 0 })
    expect(renewalFollowUpReadiness(renewalClient({ outreach: [outbound('opening', '2026-08-01T12:00:00.000Z'), outbound('follow-1', '2026-08-09T12:01:00.000Z', 'no_response_follow_up')] }), now)).toMatchObject({ available: false, followUpCount: 1 })
    expect(renewalFollowUpReadiness(renewalClient({ outreach: [outbound('opening', '2026-08-01T12:00:00.000Z'), outbound('follow-1', '2026-08-08T11:59:00.000Z', 'no_response_follow_up')] }), now)).toMatchObject({ available: true, followUpCount: 1 })
    expect(renewalFollowUpReadiness(renewalClient({ outreach: [outbound('opening', '2026-08-01T12:00:00.000Z'), outbound('follow-1', '2026-08-04T12:00:00.000Z', 'no_response_follow_up'), outbound('follow-2', '2026-08-08T12:00:00.000Z', 'no_response_follow_up')] }), now)).toMatchObject({ available: false, followUpCount: 2, reason: expect.stringMatching(/sequence is complete/i) })
  })

  it('builds genuinely different messages for each client phase', () => {
    const client = renewalClient({ firstWebinarAt: dateDaysAgo(100), lastWebinarAt: dateDaysAgo(20) })
    expect(renewalOutreachPhase(client)).toBe('completion_overdue')
    expect(buildRenewalMessage(client, 'programme_check_in', 60, 'LaunchWebinars').body).toBe('Hey Pilot, how’s everything going? You’ve got 5 webinars under your belt now. Is there anything you’re stuck on or need a hand with?')
    expect(buildRenewalMessage(client, 'webinar_accountability', 60, 'LaunchWebinars').body).toMatch(/anything getting in the way of getting the next one booked/i)
    expect(buildRenewalMessage(client, 'renewal_window_review', 20, 'LaunchWebinars').body).toBe('Hey Pilot, how’s everything going? You’ve got 5 webinars under your belt now. How are you feeling about the progress so far?')
    expect(buildRenewalMessage(client, 'post_completion_review', -10, 'LaunchWebinars').body).toMatch(/what results did you get from the webinars you ran/i)
  })

  it('uses a gentle bump once and then closes the loop without repeating itself', () => {
    const client = renewalClient({ firstWebinarAt: dateDaysAgo(100), outreach: [{
      id: 'follow-up-1', direction: 'outbound', channel: 'sms', kind: 'no_response_follow_up', templateKey: 'no_response_follow_up', body: 'First follow-up', deliveryStatus: 'sent', createdAt: new Date().toISOString(), createdBy: 'Yonas',
    }] })
    expect(buildRenewalMessage(renewalClient({ firstWebinarAt: dateDaysAgo(70) }), 'no_response_follow_up', 20, 'LaunchWebinars')).toMatchObject({ templateKey: 'no_response_follow_up', body: expect.stringMatching(/just bumping this/i) })
    expect(buildRenewalMessage(client, 'no_response_follow_up', 20, 'LaunchWebinars')).toMatchObject({ templateKey: 'no_response_close_loop', body: expect.stringMatching(/drop me a message/i) })
  })

  it('suggests the next response without forcing ambiguous replies into a renewal pitch', () => {
    const client = renewalClient()
    expect(buildRenewalReplySuggestion(client, 'Yes, I would be interested in continuing.', 'LaunchWebinars')).toMatchObject({
      intent: 'ready_to_continue',
      body: expect.stringMatching(/quick call.*Yonas/i),
    })
    expect(buildRenewalReplySuggestion(client, 'It was good and we got solid results.', 'LaunchWebinars')).toMatchObject({
      intent: 'positive_feedback',
      body: expect.stringMatching(/what result are you happiest with/i),
    })
    expect(buildRenewalReplySuggestion(client, 'We have struggled with the tech for our webinars.', 'LaunchWebinars')).toMatchObject({
      intent: 'webinar_blocked',
      body: expect.stringMatching(/main thing getting in the way/i),
    })
    expect(buildRenewalReplySuggestion(client, 'It is too expensive for us right now.', 'LaunchWebinars')).toMatchObject({
      intent: 'timing_or_budget',
      body: expect.stringMatching(/timing or budget/i),
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
      body: expect.stringMatching(/what’s gone best/i),
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

      const answered = await request(app).post(`/api/renewal-clients/${clientId}/outreach/preview`).send({ channel: 'email', kind: 'no_response_follow_up' }).expect(200)
      expect(answered.body).toMatchObject({ canSend: false, reason: expect.stringMatching(/unanswered renewal message/i) })
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
      const approvedReply = { body: 'Absolutely. What time works best?', approved: true, idempotencyKey: 'quo-conversation-reply', sourceMessageId: 'AC-in' }
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
        firstWebinarAt: dateDaysAgo(70),
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
      expect(activeSent.body.client.nextAction).toMatch(/next follow-up is available after/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks stale replies and opt-out contacts before Quo can receive a message', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_DISABLED = 'true'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-renewal-suppression-'))
    let inbound = { id: 'AC-new', text: 'I have a newer question.', createdAt: '2026-08-11T10:05:00.000Z' }
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://api.quo.com/v1/messages?') && !init?.method) return new Response(JSON.stringify({ data: [
        { id: 'AC-out', from: '+15551234567', to: ['+15550000000'], text: 'How has the program been?', status: 'sent', createdAt: '2026-08-11T10:00:00.000Z', conversationId: 'CN123' },
        { ...inbound, from: '+15550000000', to: ['+15551234567'], status: 'received', conversationId: 'CN123' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/v1/messages') && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'should-not-send' } }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store, fetcher)
      const created = await request(app).post('/api/renewal-clients').send({
        name: 'Pilot Client', email: '', phone: '+15550000000', owner: 'Yonas', firstWebinarAt: dateDaysAgo(70), lastWebinarAt: dateDaysAgo(5), webinarsHosted: 5,
        feedbackScore: null, feedbackNote: '', renewalCallAt: '', renewalStatus: 'not_started', expectedRenewalValue: 8_000, renewalCashCollected: 0, nextAction: '',
      }).expect(201)
      await store.update((state) => {
        state.workspaces[0].credentials.quo = { apiKey: 'quo-secret', from: '+15551234567', phoneNumberId: 'PN123' }
        state.workspaces[0].connections.quo = { connectedAt: new Date().toISOString(), accountLabel: 'Renewals', mode: 'live' }
      })
      const clientId = created.body.client.id as string

      await request(app).post(`/api/renewal-clients/${clientId}/conversation/send`).send({
        body: 'Reply based on the old message.', approved: true, idempotencyKey: 'stale-conversation-reply', sourceMessageId: 'AC-old',
      }).expect(409)
      expect(fetcher.mock.calls.filter(([input, init]) => String(input) === 'https://api.quo.com/v1/messages' && init?.method === 'POST')).toHaveLength(0)

      await request(app).patch(`/api/renewal-clients/${clientId}`).send({ outreachStatus: 'paused', outreachStatusReason: 'Awaiting campaign approval.' }).expect(200)
      await request(app).post(`/api/renewal-clients/${clientId}/conversation/send`).send({
        body: 'A paused client must remain blocked.', approved: true, idempotencyKey: 'blocked-paused-reply', sourceMessageId: 'AC-new',
      }).expect(409)
      await request(app).patch(`/api/renewal-clients/${clientId}`).send({ outreachStatus: 'eligible', outreachStatusReason: '' }).expect(200)

      inbound = { id: 'AC-stop', text: 'Please stop messaging me.', createdAt: '2026-08-11T10:10:00.000Z' }
      const conversation = await request(app).get(`/api/renewal-clients/${clientId}/conversation`).expect(200)
      expect(conversation.body.suppressionReason).toMatch(/asked not to receive/i)
      const preview = await request(app).post(`/api/renewal-clients/${clientId}/outreach/preview`).send({ channel: 'sms', kind: 'post_completion_review' }).expect(200)
      expect(preview.body).toMatchObject({ canSend: false, reason: expect.stringMatching(/asked not to receive/i) })
      await request(app).post(`/api/renewal-clients/${clientId}/conversation/send`).send({
        body: 'This must remain blocked.', approved: true, idempotencyKey: 'blocked-opt-out-reply', sourceMessageId: 'AC-stop',
      }).expect(409)
      expect(fetcher.mock.calls.filter(([input, init]) => String(input) === 'https://api.quo.com/v1/messages' && init?.method === 'POST')).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
