import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { RenewalOutreachService, renewalOutreachEligibility } from './renewalOutreach.js'
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
  it('opens only in the final 30 days and stops after a call is booked', () => {
    expect(renewalOutreachEligibility(renewalClient()).available).toBe(true)
    expect(renewalOutreachEligibility(renewalClient({ firstWebinarAt: dateDaysAgo(20) }))).toMatchObject({ available: false })
    expect(renewalOutreachEligibility(renewalClient({ renewalStatus: 'call_booked' }))).toMatchObject({ available: false })
    expect(renewalOutreachEligibility(renewalClient({ renewalStatus: 'renewed' }))).toMatchObject({ available: false })
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
})
