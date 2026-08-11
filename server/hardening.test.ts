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

  it('isolates renewal clients by workspace and keeps viewers read-only', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-renewal-workspaces-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const owner = request.agent(app)
      const signedUp = await owner.post('/api/auth/signup').send({ name: 'Andrea', email: 'owner@example.com', password: 'secure-pass-123', inviteCode: 'pilot-secret' }).expect(201)
      const firstWorkspaceId = signedUp.body.user.workspaceId as string
      const launch = await owner.post('/api/workspaces').send({ name: 'Launch Webinars', clientName: 'Launch Webinars' }).expect(201)
      await owner.post('/api/workspaces/active').send({ workspaceId: launch.body.workspaceId }).expect(200)

      const payload = {
        name: 'Pilot Client',
        email: 'client@example.com',
        owner: 'Yonas',
        enrolledAt: '2026-07-01',
        firstWebinarAt: '2026-07-10',
        lastWebinarAt: '2026-07-24',
        webinarsHosted: 2,
        feedbackScore: 4,
        feedbackNote: 'Positive about the webinar format.',
        renewalStatus: 'not_started',
        expectedRenewalValue: 8000,
        renewalCashCollected: 0,
      }
      await owner.post('/api/renewal-clients').send({ ...payload, firstWebinarAt: undefined }).expect(400)
      const created = await owner.post('/api/renewal-clients').send(payload).expect(201)
      expect((await owner.get('/api/renewal-clients').expect(200)).body.clients).toHaveLength(1)
      await owner.patch(`/api/renewal-clients/${created.body.client.id}`).send({ lastWebinarAt: '2026-07-01' }).expect(400)
      await owner.patch(`/api/renewal-clients/${created.body.client.id}`).send({ outreachStatus: 'paused', outreachStatusReason: 'Awaiting the approved campaign list.' }).expect(200)
      const feedbackCleared = await owner.patch(`/api/renewal-clients/${created.body.client.id}`).send({ feedbackScore: null }).expect(200)
      expect(feedbackCleared.body.client.feedbackScore).toBeUndefined()
      expect(feedbackCleared.body.client).toMatchObject({ outreachStatus: 'paused', outreachStatusReason: 'Awaiting the approved campaign list.' })

      await owner.post('/api/admin/users').send({ name: 'Launch Viewer', email: 'viewer@example.com', password: 'viewer-pass-123', role: 'viewer', workspaceIds: [launch.body.workspaceId] }).expect(201)
      const viewer = request.agent(app)
      await viewer.post('/api/auth/login').send({ email: 'viewer@example.com', password: 'viewer-pass-123' }).expect(200)
      expect((await viewer.get('/api/renewal-clients').expect(200)).body.clients[0].name).toBe('Pilot Client')
      await viewer.patch(`/api/renewal-clients/${created.body.client.id}`).send({ feedbackScore: 5 }).expect(403)
      await viewer.delete(`/api/renewal-clients/${created.body.client.id}`).expect(403)
      await viewer.post(`/api/renewal-clients/${created.body.client.id}/outreach/preview`).send({ channel: 'sms', kind: 'programme_check_in' }).expect(403)
      await viewer.post(`/api/renewal-clients/${created.body.client.id}/conversation/send`).send({ body: 'Viewer must not send this.', approved: true, idempotencyKey: 'viewer-send-blocked' }).expect(403)

      await owner.post('/api/workspaces/active').send({ workspaceId: firstWorkspaceId }).expect(200)
      expect((await owner.get('/api/renewal-clients').expect(200)).body.clients).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('lets managers safely upsert ClickUp renewal exports without overwriting manual renewal work', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-clickup-renewal-import-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const owner = request.agent(app)
      const signedUp = await owner.post('/api/auth/signup').send({ name: 'Andrea', email: 'owner@example.com', password: 'secure-pass-123', inviteCode: 'pilot-secret' }).expect(201)
      const firstWorkspaceId = signedUp.body.user.workspaceId as string
      const launch = await owner.post('/api/workspaces').send({ name: 'Launch Webinars', clientName: 'Launch Webinars' }).expect(201)
      await owner.post('/api/workspaces/active').send({ workspaceId: launch.body.workspaceId }).expect(200)
      await owner.post('/api/renewal-clients').send({
        name: 'Existing Client',
        email: 'existing@example.com',
        owner: 'Yonas',
        firstWebinarAt: '2026-07-01',
        lastWebinarAt: '2026-07-01',
        webinarsHosted: 1,
        feedbackScore: 5,
        feedbackNote: 'Strong results.',
        renewalStatus: 'conversation_needed',
        expectedRenewalValue: 5000,
        renewalCashCollected: 0,
        outreachStatus: 'paused',
        outreachStatusReason: 'Excluded from this campaign.',
        nextAction: 'Book the renewal call.',
      }).expect(201)
      await owner.post('/api/admin/users').send({ name: 'Yonas', email: 'yonas@example.com', password: 'manager-pass-123', role: 'manager', workspaceIds: [launch.body.workspaceId] }).expect(201)
      await owner.post('/api/admin/users').send({ name: 'Launch Viewer', email: 'viewer@example.com', password: 'viewer-pass-123', role: 'viewer', workspaceIds: [launch.body.workspaceId] }).expect(201)

      const manager = request.agent(app)
      await manager.post('/api/auth/login').send({ email: 'yonas@example.com', password: 'manager-pass-123' }).expect(200)
      const payload = {
        fileName: 'Client Manager.csv',
        sourceRows: 2,
        issues: [],
        completedWebinarDates: 3,
        futureWebinarDates: 1,
        rows: [
          { clickUpTaskId: 'task-existing', name: 'Existing Client Updated', email: 'existing@example.com', firstWebinarAt: '2026-07-01', lastWebinarAt: '2026-07-20', nextWebinarAt: '2026-08-05', webinarsHosted: 2, clickUpStatus: 'Active' },
          { clickUpTaskId: 'task-new', name: 'New Client', email: 'new@example.com', firstWebinarAt: '2026-07-10', lastWebinarAt: '2026-07-10', webinarsHosted: 1 },
        ],
      }
      const imported = await manager.post('/api/renewal-clients/import-clickup').send(payload).expect(200)
      expect(imported.body.result).toEqual({ created: 1, updated: 1, unchanged: 0 })
      const existing = imported.body.clients.find((client: { clickUpTaskId: string }) => client.clickUpTaskId === 'task-existing')
      const newClient = imported.body.clients.find((client: { clickUpTaskId: string }) => client.clickUpTaskId === 'task-new')
      expect(existing).toMatchObject({
        name: 'Existing Client Updated',
        owner: 'Yonas',
        webinarsHosted: 2,
        nextWebinarAt: '2026-08-05',
        feedbackScore: 5,
        feedbackNote: 'Strong results.',
        renewalStatus: 'conversation_needed',
        expectedRenewalValue: 5000,
        outreachStatus: 'paused',
        outreachStatusReason: 'Excluded from this campaign.',
        nextAction: 'Book the renewal call.',
      })
      expect(newClient).toMatchObject({ owner: 'Yonas', expectedRenewalValue: 8000, outreachStatus: 'eligible' })
      expect(imported.body.clickUpImport).toMatchObject({ importedBy: 'Yonas', acceptedRows: 2 })

      const replayed = await manager.post('/api/renewal-clients/import-clickup').send(payload).expect(200)
      expect(replayed.body.result).toEqual({ created: 0, updated: 0, unchanged: 2 })
      expect(replayed.body.clients).toHaveLength(2)

      const viewer = request.agent(app)
      await viewer.post('/api/auth/login').send({ email: 'viewer@example.com', password: 'viewer-pass-123' }).expect(200)
      await viewer.post('/api/renewal-clients/import-clickup').send(payload).expect(403)

      await owner.post('/api/workspaces/active').send({ workspaceId: firstWorkspaceId }).expect(200)
      expect((await owner.get('/api/renewal-clients').expect(200)).body.clients).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('isolates KPI snapshots by workspace, validates periods and keeps viewers read-only', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LEAKLINE_AUTH_ENABLED = 'true'
    process.env.LEAKLINE_INVITE_CODE = 'pilot-secret'
    const directory = await mkdtemp(join(tmpdir(), 'leakline-kpi-workspaces-'))
    try {
      const app = createApp(new EncryptedStore(directory))
      const owner = request.agent(app)
      const signedUp = await owner.post('/api/auth/signup').send({ name: 'Andrea', email: 'owner@example.com', password: 'secure-pass-123', inviteCode: 'pilot-secret' }).expect(201)
      const firstWorkspaceId = signedUp.body.user.workspaceId as string
      const launch = await owner.post('/api/workspaces').send({ name: 'Launch Webinars', clientName: 'Launch Webinars' }).expect(201)
      await owner.post('/api/workspaces/active').send({ workspaceId: launch.body.workspaceId }).expect(200)

      const payload = {
        periodStart: '2026-07-01',
        periodEnd: '2026-07-07',
        bookedCalls: 20,
        callsTaken: 15,
        deals: 5,
        refunds: 1,
        totalRevenue: 25_000,
        cashCollected: 15_000,
        notes: 'Weekly sales totals.',
      }
      await owner.post('/api/kpi-snapshots').send({ ...payload, periodStart: '2026-07-08' }).expect(400)
      const created = await owner.post('/api/kpi-snapshots').send(payload).expect(201)
      expect(created.body.snapshot.source).toBe('manual')
      expect((await owner.get('/api/kpi-snapshots').expect(200)).body.snapshots).toHaveLength(1)
      await owner.post('/api/admin/users').send({ name: 'Yonas', email: 'yonas@example.com', password: 'manager-pass-123', role: 'manager', workspaceIds: [launch.body.workspaceId] }).expect(201)
      const manager = request.agent(app)
      await manager.post('/api/auth/login').send({ email: 'yonas@example.com', password: 'manager-pass-123' }).expect(200)
      const imported = await manager.post('/api/kpi-snapshots/import').send({ ...payload, cashCollected: 16_000, notes: 'Imported Gross Totals.' }).expect(200)
      expect(imported.body).toMatchObject({ action: 'updated', snapshot: { id: created.body.snapshot.id, source: 'csv', cashCollected: 16_000 } })
      expect((await owner.get('/api/kpi-snapshots').expect(200)).body.snapshots).toHaveLength(1)

      const recorded = await manager.post(`/api/kpi-snapshots/${created.body.snapshot.id}/entries`).send({
        occurredOn: '2026-07-07',
        personName: 'Alex Carter',
        outcome: 'split_pay',
        revenueValue: 8_000,
        cashCollected: 2_000,
        notes: 'Two-part plan agreed.',
      }).expect(201)
      expect(recorded.body).toMatchObject({ entry: { personName: 'Alex Carter', createdBy: 'Yonas' }, snapshot: { entries: [{ outcome: 'split_pay' }] } })
      await manager.post(`/api/kpi-snapshots/${created.body.snapshot.id}/entries`).send({ occurredOn: '2026-07-08', personName: 'Outside Period', outcome: 'no_show', revenueValue: 0, cashCollected: 0 }).expect(400)
      await manager.post(`/api/kpi-snapshots/${created.body.snapshot.id}/entries`).send({ occurredOn: '2026-07-07', personName: 'Invalid Cash', outcome: 'no_show', revenueValue: 0, cashCollected: 500 }).expect(400)

      await owner.post('/api/admin/users').send({ name: 'Launch Viewer', email: 'viewer@example.com', password: 'viewer-pass-123', role: 'viewer', workspaceIds: [launch.body.workspaceId] }).expect(201)
      const viewer = request.agent(app)
      await viewer.post('/api/auth/login').send({ email: 'viewer@example.com', password: 'viewer-pass-123' }).expect(200)
      expect((await viewer.get('/api/kpi-snapshots').expect(200)).body.snapshots[0].cashCollected).toBe(16_000)
      await viewer.post('/api/kpi-snapshots/import').send(payload).expect(403)
      await viewer.post(`/api/kpi-snapshots/${created.body.snapshot.id}/entries`).send({ occurredOn: '2026-07-07', personName: 'Viewer Entry', outcome: 'no_show', revenueValue: 0, cashCollected: 0 }).expect(403)
      await viewer.delete(`/api/kpi-snapshots/${created.body.snapshot.id}/entries/${recorded.body.entry.id}`).expect(403)
      await viewer.patch(`/api/kpi-snapshots/${created.body.snapshot.id}`).send({ cashCollected: 16_000 }).expect(403)
      await viewer.delete(`/api/kpi-snapshots/${created.body.snapshot.id}`).expect(403)

      await owner.post('/api/workspaces/active').send({ workspaceId: firstWorkspaceId }).expect(200)
      expect((await owner.get('/api/kpi-snapshots').expect(200)).body.snapshots).toEqual([])
      await owner.post('/api/workspaces/active').send({ workspaceId: launch.body.workspaceId }).expect(200)
      await owner.delete(`/api/kpi-snapshots/${created.body.snapshot.id}/entries/${recorded.body.entry.id}`).expect(200)
      expect((await owner.get('/api/kpi-snapshots').expect(200)).body.snapshots[0].entries).toEqual([])
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
