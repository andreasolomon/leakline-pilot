import { randomBytes } from 'node:crypto'
import type { EncryptedStore } from './store.js'
import type { CredentialMap, ProviderId, ProviderStatus, StoreState, WorkspaceRecord } from './types.js'
import { syncFathom, syncGoogleCalendar, syncHighLevel, syncStripe, validateFathom, validateHighLevel, validateStripe } from './providers.js'
import { safeErrorMessage } from './safety.js'
import { sandboxSync } from './sandbox.js'

const definitions: Array<Pick<ProviderStatus, 'id' | 'label' | 'category' | 'description'>> = [
  { id: 'highlevel', label: 'GoHighLevel', category: 'CRM', description: 'Contacts, opportunities and sales owners.' },
  { id: 'google-calendar', label: 'Google Calendar', category: 'Calendar', description: 'Bookings and attendee matching through read-only OAuth.' },
  { id: 'stripe', label: 'Stripe', category: 'Payments', description: 'Successful, failed, overdue and refunded payments.' },
  { id: 'fathom', label: 'Fathom', category: 'Calls', description: 'Recorded calls, participants, summaries and transcripts.' },
]

export class IntegrationService {
  constructor(private readonly store: EncryptedStore, private readonly fetcher: typeof fetch = fetch) {}

  private getWorkspace(state: StoreState, workspaceId: string): WorkspaceRecord {
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    if (!workspace) throw new Error('Workspace not found.')
    return workspace
  }

  async statuses(workspaceId: string): Promise<ProviderStatus[]> {
    const state = await this.store.read()
    const workspace = this.getWorkspace(state, workspaceId)
    return definitions.map((definition) => {
      const meta = workspace.connections[definition.id]
      const googleAvailable = Boolean(this.googleConfig(workspace))
      return { ...definition, connected: Boolean(workspace.credentials[definition.id]) || meta?.mode === 'sandbox', available: definition.id !== 'google-calendar' || googleAvailable || meta?.mode === 'sandbox', mode: meta?.mode, connectedAt: meta?.connectedAt, lastSyncAt: meta?.lastSyncAt, lastError: meta?.lastError, accountLabel: meta?.accountLabel, recordCounts: meta?.recordCounts ?? {} }
    })
  }

  private googleConfig(workspace: WorkspaceRecord) {
    const clientId = process.env.GOOGLE_CLIENT_ID || workspace.oauthConfig['google-calendar']?.clientId
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || workspace.oauthConfig['google-calendar']?.clientSecret
    return clientId && clientSecret ? { clientId, clientSecret } : null
  }

  async configureGoogleOAuth(workspaceId: string, clientId: string, clientSecret: string) {
    await this.store.update((state) => { this.getWorkspace(state, workspaceId).oauthConfig['google-calendar'] = { clientId, clientSecret } })
    return this.snapshot(workspaceId)
  }

  async connect<K extends Exclude<ProviderId, 'google-calendar'>>(workspaceId: string, provider: K, credential: CredentialMap[K]) {
    let validation: { accountLabel: string }
    if (provider === 'stripe') validation = await validateStripe(credential as CredentialMap['stripe'], this.fetcher)
    else if (provider === 'highlevel') validation = await validateHighLevel(credential as CredentialMap['highlevel'], this.fetcher)
    else validation = await validateFathom(credential as CredentialMap['fathom'], this.fetcher)
    await this.store.update((state) => {
      const workspace = this.getWorkspace(state, workspaceId)
      ;(workspace.credentials as Record<string, unknown>)[provider] = credential
      workspace.connections[provider] = { connectedAt: new Date().toISOString(), accountLabel: validation.accountLabel, recordCounts: {}, mode: 'live' }
    })
    return validation
  }

  async disconnect(workspaceId: string, provider: ProviderId) {
    await this.store.update((state) => {
      const workspace = this.getWorkspace(state, workspaceId)
      delete workspace.credentials[provider]
      delete workspace.connections[provider]
      if (provider === 'stripe') delete workspace.workspace.payments
      if (provider === 'highlevel') { delete workspace.workspace.leads; delete workspace.workspace.deals; delete workspace.workspace.closers }
      if (provider === 'google-calendar') delete workspace.workspace.appointments
      if (provider === 'fathom') workspace.calls = []
    })
  }

  async sync(workspaceId: string, provider: ProviderId) {
    const state = await this.store.read()
    const workspace = this.getWorkspace(state, workspaceId)
    const credential = workspace.credentials[provider]
    if (!credential) {
      const meta = workspace.connections[provider]
      if (meta?.mode === 'sandbox') return this.syncSandbox(workspaceId, provider)
      throw new Error(`${provider} is not connected.`)
    }
    try {
      if (provider === 'stripe') {
        const payments = await syncStripe(credential as CredentialMap['stripe'], this.fetcher)
        await this.store.update((next) => { const target = this.getWorkspace(next, workspaceId); target.workspace.payments = payments; this.markSynced(target, provider, { payments: payments.rows.length }) })
      } else if (provider === 'highlevel') {
        const result = await syncHighLevel(credential as CredentialMap['highlevel'], this.fetcher)
        await this.store.update((next) => { const target = this.getWorkspace(next, workspaceId); Object.assign(target.workspace, result); this.markSynced(target, provider, { leads: result.leads.rows.length, deals: result.deals.rows.length, closers: result.closers.rows.length }) })
      } else if (provider === 'google-calendar') {
        const config = this.googleConfig(workspace)
        if (!config) throw new Error('Google OAuth credentials are not configured. Open Google Calendar in Integrations and add the app client ID and client secret first.')
        const result = await syncGoogleCalendar(credential as CredentialMap['google-calendar'], config.clientId, config.clientSecret, this.fetcher)
        await this.store.update((next) => { const target = this.getWorkspace(next, workspaceId); target.credentials['google-calendar'] = result.credential; target.workspace.appointments = result.appointments; this.markSynced(target, provider, { appointments: result.appointments.rows.length }) })
      } else {
        const calls = await syncFathom(credential as CredentialMap['fathom'], this.fetcher)
        await this.store.update((next) => { const target = this.getWorkspace(next, workspaceId); target.calls = calls; this.markSynced(target, provider, { calls: calls.length }) })
      }
    } catch (error) {
      await this.store.update((next) => {
        const meta = this.getWorkspace(next, workspaceId).connections[provider]
        if (meta) meta.lastError = safeErrorMessage(error)
      })
      throw error
    }
    return this.snapshot(workspaceId)
  }

  async syncSandbox(workspaceId: string, provider: ProviderId) {
    const result = await sandboxSync(provider)
    await this.store.update((state) => {
      const workspace = this.getWorkspace(state, workspaceId)
      if (provider === 'stripe') workspace.workspace.payments = result.workspace.payments
      if (provider === 'highlevel') { workspace.workspace.leads = result.workspace.leads; workspace.workspace.deals = result.workspace.deals; workspace.workspace.closers = result.workspace.closers }
      if (provider === 'google-calendar') workspace.workspace.appointments = result.workspace.appointments
      if (provider === 'fathom') workspace.calls = result.calls ?? []
      workspace.connections[provider] = { connectedAt: workspace.connections[provider]?.connectedAt ?? new Date().toISOString(), lastSyncAt: new Date().toISOString(), accountLabel: result.accountLabel, recordCounts: result.recordCounts, mode: 'sandbox' }
      delete workspace.credentials[provider]
    })
    return this.snapshot(workspaceId)
  }

  private markSynced(workspace: WorkspaceRecord, provider: ProviderId, recordCounts: ProviderStatus['recordCounts']) {
    const meta = workspace.connections[provider]
    if (!meta) return
    meta.lastSyncAt = new Date().toISOString()
    meta.lastError = undefined
    meta.recordCounts = recordCounts
  }

  async snapshot(workspaceId: string) {
    const state = await this.store.read()
    const workspace = this.getWorkspace(state, workspaceId)
    return { workspace: workspace.workspace, calls: workspace.calls.map(({ id, title, startedAt, owner, participants, url }) => ({ id, title, startedAt, owner, participants, url })), statuses: await this.statuses(workspaceId), activeWorkspace: { id: workspace.id, name: workspace.name, clientName: workspace.clientName } }
  }

  async calls(workspaceId: string, limit = 50) {
    const state = await this.store.read()
    return this.getWorkspace(state, workspaceId).calls.slice(0, Math.max(1, Math.min(limit, 200)))
  }

  async syncAll(workspaceId: string) {
    const statuses = await this.statuses(workspaceId)
    const errors: Array<{ provider: ProviderId; error: string }> = []
    for (const status of statuses.filter((item) => item.connected)) {
      try { await this.sync(workspaceId, status.id) }
      catch (error) { errors.push({ provider: status.id, error: safeErrorMessage(error) }) }
    }
    return { ...(await this.snapshot(workspaceId)), errors }
  }

  async googleAuthorizationUrl(workspaceId: string) {
    const state = await this.store.read()
    const workspace = this.getWorkspace(state, workspaceId)
    const config = this.googleConfig(workspace)
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${process.env.APP_BASE_URL ?? 'http://127.0.0.1:8787'}/api/integrations/google-calendar/callback`
    if (!config) throw new Error('Add a Google OAuth client ID and client secret before connecting Google Calendar.')
    const stateValue = randomBytes(24).toString('hex')
    const scopedStateValue = `${workspaceId}.${stateValue}`
    await this.store.update((next) => { this.getWorkspace(next, workspaceId).oauthStates['google-calendar'] = { value: scopedStateValue, expiresAt: Date.now() + 10 * 60_000 } })
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.readonly')
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('include_granted_scopes', 'true')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', scopedStateValue)
    return url.toString()
  }

  async finishGoogleAuthorization(code: string, returnedState: string) {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${process.env.APP_BASE_URL ?? 'http://127.0.0.1:8787'}/api/integrations/google-calendar/callback`
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.oauthStates['google-calendar']?.value === returnedState)
    if (!workspace) throw new Error('Google OAuth state is invalid or expired.')
    const config = this.googleConfig(workspace)
    if (!config) throw new Error('Google OAuth credentials are not configured.')
    const expected = workspace.oauthStates['google-calendar']
    if (!expected || expected.value !== returnedState || expected.expiresAt < Date.now()) throw new Error('Google OAuth state is invalid or expired.')
    const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
    if (!response.ok || !token.access_token) throw new Error(token.error_description ?? 'Google token exchange failed.')
    await this.store.update((next) => {
      const target = this.getWorkspace(next, workspace.id)
      target.credentials['google-calendar'] = { accessToken: token.access_token!, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 }
      target.connections['google-calendar'] = { connectedAt: new Date().toISOString(), accountLabel: 'Google Calendar', recordCounts: {}, mode: 'live' }
      delete target.oauthStates['google-calendar']
    })
  }
}
