import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { coachingAttendanceReport } from './coachingAttendance.js'
import { createApp } from './app.js'
import { EncryptedStore, defaultPilotValidation, defaultRecoveryPolicy } from './store.js'
import type { WorkspaceRecord } from './types.js'

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function workspaceFixture(): WorkspaceRecord {
  return {
    id: 'workspace-coaching', name: 'Launch Webinars', clientName: 'Launch Webinars', createdAt: '2026-08-01T00:00:00.000Z',
    credentials: {}, connections: {}, oauthConfig: {}, workspace: {}, imports: {}, calls: [], oauthStates: {}, recoveryCases: [], paymentRecoveryCases: [],
    recoveryPolicy: defaultRecoveryPolicy('Launch Webinars'), pilotValidation: defaultPilotValidation(), clickUpRenewalImport: undefined, kpiSnapshots: [],
    highLevelKpi: { settings: { stageMappings: {} }, stages: [], opportunities: [], stageEvents: [] },
    renewalClients: [{ id: 'client-one', name: 'Alex Realtor', email: 'alex@example.com', owner: 'Yonas', enrolledAt: '2026-08-01', webinarsHosted: 1, renewalStatus: 'not_started', expectedRenewalValue: 0, renewalCashCollected: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }, { id: 'client-not-started', name: 'Waiting Client', email: 'waiting@example.com', owner: 'Yonas', webinarsHosted: 0, renewalStatus: 'not_started', expectedRenewalValue: 0, renewalCashCollected: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }],
    coachingAttendance: {
      settings: { meetingId: '1234567890', minimumMinutes: 15, teamEmails: ['fred@launchwebinars.io'] },
      sessions: [
        { id: 'session-two', meetingId: '1234567890', topic: 'Coaching', startedAt: '2026-08-12T16:00:00.000Z', syncedAt: '2026-08-12T18:00:00.000Z', participants: [{ id: 'p2', name: 'Alex Realtor', durationMinutes: 18, matchType: 'unmatched' }] },
        { id: 'session-one', meetingId: '1234567890', topic: 'Coaching', startedAt: '2026-08-05T16:00:00.000Z', syncedAt: '2026-08-05T18:00:00.000Z', participants: [{ id: 'p1a', name: 'Alex', email: 'alex@example.com', durationMinutes: 8, matchType: 'unmatched' }, { id: 'p1b', name: 'Alex', email: 'alex@example.com', durationMinutes: 9, matchType: 'unmatched' }, { id: 'team', name: 'Fred', email: 'fred@launchwebinars.io', durationMinutes: 60, matchType: 'unmatched' }, { id: 'unknown', name: 'iPhone', durationMinutes: 30, matchType: 'unmatched' }] },
      ],
    },
  }
}

describe('coaching attendance analysis', () => {
  it('matches conservatively, combines reconnect duration and excludes clients who have not started', () => {
    const report = coachingAttendanceReport(workspaceFixture())
    expect(report.clients.find((client) => client.clientId === 'client-one')).toMatchObject({ attended: 2, missed: 0, attendanceRate: 100 })
    expect(report.clients.find((client) => client.clientId === 'client-not-started')).toMatchObject({ sessionsAvailable: 0, attended: 0, missed: 0 })
    expect(report.unmatched).toHaveLength(1)
    expect(report.unmatched[0]).toMatchObject({ name: 'iPhone' })
    expect(report.sessions.flatMap((session) => session.participants).find((participant) => participant.id === 'team')?.matchType).toBe('team')
  })
})

describe('Zoom coaching integration', () => {
  it('stores no secret in responses and keeps repeated syncs idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leakline-zoom-'))
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('zoom.us/oauth/token')) return reply({ access_token: 'zoom-access-token' })
      if (url.endsWith('/users/me')) return reply({ display_name: 'Launch Webinars Zoom', email: 'zoom@launchwebinars.io' })
      if (url.includes('/instances')) return reply({ meetings: [{ uuid: 'meeting-instance-one', start_time: '2026-08-15T16:00:00.000Z' }] })
      if (url.includes('/participants')) return reply({ participants: [{ id: 'participant-one', name: 'Alex Realtor', user_email: 'alex@example.com', duration: 1800 }] })
      return reply({})
    }) as unknown as typeof fetch
    try {
      const app = createApp(new EncryptedStore(directory), fetcher)
      await request(app).post('/api/renewal-clients').send({ name: 'Alex Realtor', email: 'alex@example.com', phone: '', owner: 'Yonas', enrolledAt: '2026-08-01', firstWebinarAt: '2026-08-01', lastWebinarAt: '2026-08-01', nextWebinarAt: '', webinarsHosted: 1, feedbackNote: '', renewalCallAt: '', renewalStatus: 'not_started', expectedRenewalValue: 0, renewalCashCollected: 0, outreachStatus: 'eligible', outreachStatusReason: '', nextAction: '' }).expect(201)
      const connected = await request(app).post('/api/integrations/zoom/connect').send({ accountId: 'zoom-account-id', clientId: 'zoom-client-id', clientSecret: 'zoom-client-secret-value', meetingId: '123 456 7890' }).expect(200)
      expect(JSON.stringify(connected.body)).not.toContain('zoom-client-secret-value')
      await request(app).post('/api/integrations/zoom/sync').expect(200)
      await request(app).post('/api/integrations/zoom/sync').expect(200)
      const report = await request(app).get('/api/coaching-attendance').expect(200)
      expect(report.body.sessions).toHaveLength(1)
      expect(report.body.clients[0]).toMatchObject({ attended: 1, attendanceRate: 100 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
