import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { EncryptedStore } from './store.js'
import { validateProductionConfiguration } from './productionConfig.js'

const originalEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  authDisabled: process.env.LEAKLINE_AUTH_DISABLED,
  authEnabled: process.env.LEAKLINE_AUTH_ENABLED,
  inviteCode: process.env.LEAKLINE_INVITE_CODE,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
}

function restore(name: keyof NodeJS.ProcessEnv, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore('NODE_ENV', originalEnvironment.nodeEnv)
  restore('LEAKLINE_AUTH_DISABLED', originalEnvironment.authDisabled)
  restore('LEAKLINE_AUTH_ENABLED', originalEnvironment.authEnabled)
  restore('LEAKLINE_INVITE_CODE', originalEnvironment.inviteCode)
  restore('GOOGLE_CLIENT_ID', originalEnvironment.googleClientId)
  restore('GOOGLE_CLIENT_SECRET', originalEnvironment.googleClientSecret)
  restore('GOOGLE_REDIRECT_URI', originalEnvironment.googleRedirectUri)
})

describe.sequential('server hardening', () => {
  it('adds baseline security headers and throttles repeated authentication attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-rate-limit-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const health = await request(app).get('/api/health').expect(200)
      expect(health.headers['x-content-type-options']).toBe('nosniff')
      expect(health.headers['x-frame-options']).toBe('DENY')
      expect(health.headers['referrer-policy']).toBe('no-referrer')
      expect(health.headers['content-security-policy']).toContain("default-src 'self'")
      expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'")
      for (let attempt = 0; attempt < 20; attempt += 1) await request(app).post('/api/auth/login').send({ email: 'unknown@example.com', password: 'wrong' }).expect(401)
      await request(app).post('/api/auth/login').send({ email: 'unknown@example.com', password: 'wrong' }).expect(429)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('blocks cross-site browser writes while allowing the local app origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-cross-site-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      await request(app)
        .post('/api/marketing-events')
        .set('Origin', 'https://attacker.example')
        .send({ event: 'page_view', path: '/' })
        .expect(403)
      await request(app)
        .post('/api/marketing-events')
        .set('Origin', 'http://localhost:8798')
        .send({ event: 'page_view', path: '/' })
        .expect(202)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects unsafe production configuration before the server starts', () => {
    expect(() => validateProductionConfiguration({
      NODE_ENV: 'production',
      APP_BASE_URL: 'http://public.example',
      LEAKLINE_ENCRYPTION_KEY: 'short',
      LEAKLINE_INVITE_CODE: 'short',
      LEAKLINE_AUTH_DISABLED: 'true',
    })).toThrow(/Unsafe production configuration/)
    expect(() => validateProductionConfiguration({
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://leakline.example',
      LEAKLINE_ENCRYPTION_KEY: 'a'.repeat(64),
      LEAKLINE_INVITE_CODE: 'a-secure-private-code-123',
      LEAKLINE_AUTH_DISABLED: 'false',
    })).not.toThrow()
  })

  it('rejects oversized passwords before password hashing', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-password-limit-'))
    try {
      await request(createApp(new EncryptedStore(directory)))
        .post('/api/auth/signup')
        .send({ name: 'Andrea', email: 'owner@example.com', password: 'x'.repeat(129), inviteCode: 'pilot-secret' })
        .expect(400)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('never disables authentication in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.LEAKLINE_AUTH_DISABLED = 'true'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-production-auth-'))
    try { await request(createApp(new EncryptedStore(directory))).get('/api/payment-recovery').expect(401) }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('defaults new users to the active workspace and scopes OAuth callbacks', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    process.env.GOOGLE_CLIENT_ID = 'google-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret'
    process.env.GOOGLE_REDIRECT_URI = 'http://127.0.0.1/callback'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-scope-'))
    const fetcher = vi.fn() as unknown as typeof fetch
    try {
      const app = createApp(new EncryptedStore(directory), fetcher)
      const owner = request.agent(app)
      const signedUp = await owner.post('/api/auth/signup').send({ name: 'Andrea', email: 'owner@example.com', password: 'secure-pass-123', inviteCode: 'pilot-secret' }).expect(201)
      const firstWorkspaceId = signedUp.body.user.workspaceId as string
      const second = await owner.post('/api/workspaces').send({ name: 'Second client', clientName: 'Second Client LLC' }).expect(201)
      await owner.post('/api/workspaces/active').send({ workspaceId: second.body.workspaceId }).expect(200)
      const started = await owner.get('/api/integrations/google-calendar/start').expect(200)
      const state = new URL(started.body.url).searchParams.get('state')

      const created = await owner.post('/api/admin/users').send({ name: 'Second Client Manager', email: 'manager@example.com', password: 'manager-pass-123', role: 'manager' }).expect(201)
      expect(created.body.user.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([second.body.workspaceId])

      await owner.post('/api/admin/users').send({ name: 'First Client Admin', email: 'admin@example.com', password: 'admin-pass-123', role: 'admin', workspaceIds: [firstWorkspaceId] }).expect(201)
      const admin = request.agent(app)
      await admin.post('/api/auth/login').send({ email: 'admin@example.com', password: 'admin-pass-123' }).expect(200)
      await admin.get('/api/integrations/google-calendar/callback').query({ code: 'oauth-code', state }).expect(403)
      expect(fetcher).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('stores CSV imports in the active workspace and keeps viewers read-only', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-import-storage-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const owner = request.agent(app)
      const signedUp = await owner.post('/api/auth/signup').send({ name: 'Andrea', email: 'owner@example.com', password: 'secure-pass-123', inviteCode: 'pilot-secret' }).expect(201)
      const firstWorkspaceId = signedUp.body.user.workspaceId as string
      const leads = {
        kind: 'leads', fileName: 'leads.csv', rows: [{ id: 'lead-1', email: 'first@example.com', status: 'opt-in' }], sourceRows: 1,
        issues: [], mappedFields: ['id', 'email', 'status'], headers: ['id', 'email', 'status'], mapping: { id: 'id', email: 'email', status: 'status' },
      }
      await owner.put('/api/imports').send({ workspace: { leads } }).expect(200)
      expect((await owner.get('/api/imports').expect(200)).body.workspace.leads.rows).toEqual(leads.rows)

      const second = await owner.post('/api/workspaces').send({ name: 'Second client', clientName: 'Second Client LLC' }).expect(201)
      await owner.post('/api/workspaces/active').send({ workspaceId: second.body.workspaceId }).expect(200)
      expect((await owner.get('/api/imports').expect(200)).body.workspace).toEqual({})
      const payments = { ...leads, kind: 'payments', fileName: 'payments.csv', rows: [{ id: 'payment-1', amount: 750, status: 'overdue' }] }
      await owner.put('/api/imports').send({ workspace: { payments } }).expect(200)

      await owner.post('/api/admin/users').send({ name: 'Pilot Viewer', email: 'viewer@example.com', password: 'viewer-pass-123', role: 'viewer', workspaceIds: [second.body.workspaceId] }).expect(201)
      const viewer = request.agent(app)
      await viewer.post('/api/auth/login').send({ email: 'viewer@example.com', password: 'viewer-pass-123' }).expect(200)
      expect((await viewer.get('/api/imports').expect(200)).body.workspace.payments.rows[0].amount).toBe(750)
      await viewer.put('/api/imports').send({ workspace: {} }).expect(403)
      await viewer.delete('/api/imports').expect(403)

      await owner.post('/api/workspaces/active').send({ workspaceId: firstWorkspaceId }).expect(200)
      const firstAgain = await owner.get('/api/imports').expect(200)
      expect(firstAgain.body.workspace.leads.rows[0].email).toBe('first@example.com')
      expect(firstAgain.body.workspace.payments).toBeUndefined()
      await owner.put('/api/imports').send({ workspace: { leads: { ...leads, sourceText: 'raw CSV must not be accepted' } } }).expect(400)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('serialises concurrent encrypted-store updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-store-queue-'))
    try {
      const store = new EncryptedStore(directory)
      await Promise.all(Array.from({ length: 20 }, (_, index) => store.update(async (state) => {
        const sequence = state.marketingEvents.length
        await new Promise((resolve) => setTimeout(resolve, index % 3))
        state.marketingEvents.push({ id: `event-${sequence}`, event: 'page_view', path: '/', createdAt: new Date().toISOString() })
      })))
      const persisted = await new EncryptedStore(directory).read()
      expect(persisted.marketingEvents.map((event) => event.id)).toEqual(Array.from({ length: 20 }, (_, index) => `event-${index}`))
      expect((await readdir(directory)).filter((file) => file.endsWith('.tmp'))).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects invalid timezones and unsafe outbound placeholders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-message-safety-'))
    try {
      const store = new EncryptedStore(directory)
      const app = createApp(store)
      await request(app).post('/api/payment-recovery/sample').expect(200)
      const snapshot = await request(app).get('/api/payment-recovery').expect(200)
      await request(app).patch('/api/payment-recovery/policy').send({ policy: { ...snapshot.body.policy, timezone: 'Not/A_Timezone' }, approve: false }).expect(400)

      const candidate = snapshot.body.cases.find((item: { classification: string }) => item.classification !== 'human_review')
      await store.update((state) => {
        const recoveryCase = state.workspaces[0].paymentRecoveryCases.find((item) => item.id === candidate.id)!
        recoveryCase.hostedPaymentUrl = undefined
      })
      const before = (await store.read()).workspaces[0].paymentRecoveryCases.find((item) => item.id === candidate.id)!.attempts.filter((attempt) => attempt.direction === 'outbound').length
      const blocked = await request(app).post(`/api/payment-recovery/cases/${candidate.id}/send`).send({ channel: 'sms', approved: true }).expect(409)
      expect(blocked.body.error).toMatch(/unresolved placeholder/i)
      const saved = await store.read()
      expect(saved.workspaces[0].paymentRecoveryCases.find((item) => item.id === candidate.id)?.attempts.filter((attempt) => attempt.direction === 'outbound')).toHaveLength(before)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not allow the test webhook bypass outside the test environment', async () => {
    process.env.NODE_ENV = 'development'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-recovery-webhook-bypass-'))
    try {
      await request(createApp(new EncryptedStore(directory))).post('/api/webhooks/highlevel/inbound').set('x-leakline-test-webhook', 'true').send({ type: 'InboundMessage', locationId: 'location-1', contactId: 'contact-1', body: 'I can pay Friday' }).expect(401)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
