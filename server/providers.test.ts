import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { syncFathom, syncGoogleCalendar, syncHighLevel, syncStripe } from './providers.js'
import { EncryptedStore } from './store.js'
import { safeErrorMessage } from './safety.js'

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  delete process.env.LEAKLINE_AUTH_ENABLED
  delete process.env.LEAKLINE_INVITE_CODE
  delete process.env.ALLOW_ADDITIONAL_USERS
})

describe('Version 2 provider adapters', () => {
  it('normalizes Stripe payments, failures, refunds and overdue invoices', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/charges')) return reply({ has_more: false, data: [
        { id: 'ch_paid', amount: 300000, amount_refunded: 75000, currency: 'gbp', created: 1_718_409_600, paid: true, status: 'succeeded', payment_intent: 'pi_1', billing_details: { name: 'Alice' }, metadata: {} },
        { id: 'ch_failed', amount: 180000, amount_refunded: 0, currency: 'gbp', created: 1_718_582_400, paid: false, status: 'failed', billing_details: { name: 'George' }, metadata: {} },
      ] })
      if (url.includes('/invoices')) return reply({ has_more: false, data: [{ id: 'in_overdue', status: 'open', amount_remaining: 250000, currency: 'gbp', due_date: 1_718_496_000, customer_name: 'Chloe', metadata: {} }] })
      return reply({})
    }) as unknown as typeof fetch
    const result = await syncStripe({ secretKey: 'sk_test_example' }, fetcher)
    expect(result.rows.map((row) => row.status)).toEqual(['paid', 'refunded', 'failed', 'overdue'])
    expect(result.rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(8050)
  })

  it('normalizes GoHighLevel contacts, opportunities and owners', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/contacts/')) return reply({ contacts: [{ id: 'L1', contactName: 'Alice', email: 'alice@example.com', source: 'Meta', assignedTo: 'U1', dateAdded: '2026-06-01', dateUpdated: '2026-06-02' }] })
      if (url.includes('/opportunities/search')) return reply({ opportunities: [{ id: 'D1', contactId: 'L1', name: 'Alice Deal', status: 'won', monetaryValue: 12000, assignedTo: 'U1', updatedAt: '2026-06-03' }] })
      if (url.includes('/opportunities/pipelines')) return reply({ pipelines: [] })
      if (url.includes('/users/')) return reply({ users: [{ id: 'U1', name: 'Alex Morgan', email: 'alex@example.com' }] })
      return reply({})
    }) as unknown as typeof fetch
    const result = await syncHighLevel({ accessToken: 'token', locationId: 'loc' }, fetcher)
    expect(result.leads.rows[0]).toMatchObject({ name: 'Alice', owner: 'Alex Morgan' })
    expect(result.deals.rows[0]).toMatchObject({ stage: 'closed won', value: 12000 })
    expect(result.closers.rows[0]).toMatchObject({ name: 'Alex Morgan', close_rate: 100 })
  })

  it('normalizes Google Calendar events as appointments', async () => {
    const fetcher = vi.fn(async () => reply({ items: [{ id: 'A1', status: 'confirmed', start: { dateTime: '2026-06-20T10:00:00Z' }, attendees: [{ email: 'lead@example.com' }], organizer: { displayName: 'Alex Morgan' }, extendedProperties: { private: { lead_id: 'L1', attendance_status: 'attended' } } }] })) as unknown as typeof fetch
    const result = await syncGoogleCalendar({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 }, 'client', 'secret', fetcher)
    expect(result.appointments.rows[0]).toMatchObject({ id: 'A1', lead_id: 'L1', email: 'lead@example.com', status: 'attended', closer: 'Alex Morgan' })
  })

  it('normalizes Fathom transcripts and participants', async () => {
    const fetcher = vi.fn(async () => reply({ items: [{ recording_id: 'R1', title: 'Sales call', recording_start_time: '2026-06-20T10:00:00Z', recorded_by: { name: 'Alex' }, calendar_invitees: [{ email: 'lead@example.com' }], transcript: [{ speaker: { display_name: 'Lead' }, text: 'I need to think about it.' }], default_summary: { markdown_formatted: 'Objection raised.' }, share_url: 'https://fathom.video/share/R1' }] })) as unknown as typeof fetch
    const calls = await syncFathom({ apiKey: 'key' }, fetcher)
    expect(calls[0]).toMatchObject({ id: 'R1', participants: ['lead@example.com'], transcript: 'Lead: I need to think about it.' })
  })

  it('surfaces Fathom rate limits with a useful retry instruction', async () => {
    const fetcher = vi.fn(async () => reply({ message: 'Too many requests' }, 429)) as unknown as typeof fetch
    await expect(syncFathom({ apiKey: 'key' }, fetcher)).rejects.toThrow('Wait about 60 seconds')
  })
})

describe('Version 2 service boundary', () => {
  it('protects pilot data behind invite-only login when auth is enabled', async () => {
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-auth-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      expect((await request(app).get('/api/health')).status).toBe(200)
      expect((await request(app).get('/api/integrations')).status).toBe(401)

      const agent = request.agent(app)
      const rejected = await agent.post('/api/auth/signup').send({ name: 'Client', email: 'client@example.com', password: 'secure-pass-123', inviteCode: 'wrong' })
      expect(rejected.status).toBe(400)

      const created = await agent.post('/api/auth/signup').send({ name: 'Client', email: 'client@example.com', password: 'secure-pass-123', inviteCode: 'pilot-secret' })
      expect(created.status).toBe(201)
      expect(created.body.user).toMatchObject({ email: 'client@example.com', name: 'Client' })

      const integrations = await agent.get('/api/integrations')
      expect(integrations.status).toBe(200)
      expect(integrations.body.statuses).toHaveLength(4)

      await agent.post('/api/auth/logout').send({})
      expect((await agent.get('/api/integrations')).status).toBe(401)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('encrypts integration state at rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-store-'))
    try {
      const store = new EncryptedStore(directory)
      await store.update((state) => { state.credentials.stripe = { secretKey: 'sk_test_super_secret' } })
      expect(await readFile(join(directory, 'integrations.enc'), 'utf8')).not.toContain('sk_test_super_secret')
      expect((await new EncryptedStore(directory).read()).credentials.stripe?.secretKey).toBe('sk_test_super_secret')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('serves health and disconnected provider status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-app-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      expect((await request(app).get('/api/health')).body).toEqual({ ok: true, version: 2 })
      const integrations = await request(app).get('/api/integrations')
      expect(integrations.status).toBe(200)
      expect(integrations.body.statuses).toHaveLength(4)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('connects and syncs Stripe through the real HTTP boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-stripe-'))
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v1/charges?') && new URL(url).searchParams.get('limit') === '1') return reply({ data: [] })
      if (url.includes('/charges')) return reply({ has_more: false, data: [{ id: 'ch_1', amount: 300000, amount_refunded: 0, currency: 'gbp', created: 1_718_409_600, paid: true, status: 'succeeded', billing_details: { name: 'Alice' }, metadata: {} }] })
      if (url.includes('/invoices')) return reply({ has_more: false, data: [] })
      return reply({}, 404)
    }) as unknown as typeof fetch
    try {
      const app = createApp(new EncryptedStore(directory), fetcher)
      const connected = await request(app).post('/api/integrations/stripe/connect').send({ secretKey: 'sk_test_12345678901234567890' })
      expect(connected.status).toBe(200)
      expect(connected.body.statuses.find((status: { id: string }) => status.id === 'stripe')).toMatchObject({ connected: true, accountLabel: 'Stripe account' })
      const synced = await request(app).post('/api/integrations/stripe/sync')
      expect(synced.status).toBe(200)
      expect(synced.body.workspace.payments.rows[0]).toMatchObject({ customer: 'Alice', amount: 3000, status: 'paid' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('runs sandbox syncs without storing fake credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-sandbox-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const highlevel = await request(app).post('/api/integrations/highlevel/sandbox-sync')
      expect(highlevel.status).toBe(200)
      expect(highlevel.body.workspace.leads.rows).toHaveLength(3)
      expect(highlevel.body.workspace.deals.rows).toHaveLength(3)
      expect(highlevel.body.statuses.find((status: { id: string }) => status.id === 'highlevel')).toMatchObject({ connected: true, mode: 'sandbox', accountLabel: 'GoHighLevel sandbox data' })

      const fathom = await request(app).post('/api/integrations/fathom/sandbox-sync')
      expect(fathom.status).toBe(200)
      expect(fathom.body.statuses.find((status: { id: string }) => status.id === 'fathom')).toMatchObject({ connected: true, mode: 'sandbox', recordCounts: { calls: 2 } })

      const saved = await new EncryptedStore(directory).read()
      expect(saved.credentials.highlevel).toBeUndefined()
      expect(saved.credentials.fathom).toBeUndefined()
      expect(saved.calls[0].transcript).toContain('The price feels high')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('completes Google OAuth with state validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-google-'))
    const previous = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT_URI }
    process.env.GOOGLE_CLIENT_ID = 'google-client'
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret'
    process.env.GOOGLE_REDIRECT_URI = 'http://127.0.0.1/callback'
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes('oauth2.googleapis.com/token') ? reply({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) : reply({})) as unknown as typeof fetch
    try {
      const app = createApp(new EncryptedStore(directory), fetcher)
      const started = await request(app).get('/api/integrations/google-calendar/start')
      const state = new URL(started.body.url).searchParams.get('state')
      expect(state).toBeTruthy()
      const callback = await request(app).get('/api/integrations/google-calendar/callback').query({ code: 'code', state })
      expect(callback.status).toBe(302)
      const snapshot = await request(app).get('/api/integrations')
      expect(snapshot.body.statuses.find((status: { id: string }) => status.id === 'google-calendar').connected).toBe(true)
    } finally {
      if (previous.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = previous.id
      if (previous.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = previous.secret
      if (previous.redirect === undefined) delete process.env.GOOGLE_REDIRECT_URI; else process.env.GOOGLE_REDIRECT_URI = previous.redirect
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('can configure Google OAuth through the local encrypted backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-google-config-'))
    const previous = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT_URI }
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/integrations/google-calendar/callback'
    try {
      const app = createApp(new EncryptedStore(directory))
      const initial = await request(app).get('/api/integrations')
      expect(initial.body.statuses.find((status: { id: string }) => status.id === 'google-calendar').available).toBe(false)

      const configured = await request(app).post('/api/integrations/google-calendar/configure').send({ clientId: 'google-client-id.apps.googleusercontent.com', clientSecret: 'google-client-secret' })
      expect(configured.status).toBe(200)
      expect(configured.body.statuses.find((status: { id: string }) => status.id === 'google-calendar').available).toBe(true)

      const started = await request(app).get('/api/integrations/google-calendar/start')
      expect(started.body.url).toContain('google-client-id.apps.googleusercontent.com')
      expect(await readFile(join(directory, 'integrations.enc'), 'utf8')).not.toContain('google-client-secret')
    } finally {
      if (previous.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = previous.id
      if (previous.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = previous.secret
      if (previous.redirect === undefined) delete process.env.GOOGLE_REDIRECT_URI; else process.env.GOOGLE_REDIRECT_URI = previous.redirect
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts provider secrets from surfaced errors', () => {
    expect(safeErrorMessage(new Error('Invalid sk_test_abcdefghijklmnopqrstuvwxyz'))).toBe('Invalid [redacted Stripe key]')
  })
})
