import { randomBytes } from 'node:crypto'
import type { EncryptedStore } from './store.js'
import type { CredentialMap, ProviderId, ProviderStatus, StoreState } from './types.js'
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

  async statuses(): Promise<ProviderStatus[]> {
    const state = await this.store.read()
    return definitions.map((definition) => {
      const meta = state.connections[definition.id]
      const googleAvailable = Boolean(this.googleConfig(state))
      return { ...definition, connected: Boolean(state.credentials[definition.id]) || meta?.mode === 'sandbox', available: definition.id !== 'google-calendar' || googleAvailable || meta?.mode === 'sandbox', mode: meta?.mode, connectedAt: meta?.connectedAt, lastSyncAt: meta?.lastSyncAt, lastError: meta?.lastError, accountLabel: meta?.accountLabel, recordCounts: meta?.recordCounts ?? {} }
    })
  }

  private googleConfig(state: StoreState) {
    const clientId = process.env.GOOGLE_CLIENT_ID || state.oauthConfig['google-calendar']?.clientId
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || state.oauthConfig['google-calendar']?.clientSecret
    return clientId && clientSecret ? { clientId, clientSecret } : null
  }

  async configureGoogleOAuth(clientId: string, clientSecret: string) {
    await this.store.update((state) => { state.oauthConfig['google-calendar'] = { clientId, clientSecret } })
    return this.snapshot()
  }

  async connect<K extends Exclude<ProviderId, 'google-calendar'>>(provider: K, credential: CredentialMap[K]) {
    let validation: { accountLabel: string }
    if (provider === 'stripe') validation = await validateStripe(credential as CredentialMap['stripe'], this.fetcher)
    else if (provider === 'highlevel') validation = await validateHighLevel(credential as CredentialMap['highlevel'], this.fetcher)
    else validation = await validateFathom(credential as CredentialMap['fathom'], this.fetcher)
    await this.store.update((state) => {
      ;(state.credentials as Record<string, unknown>)[provider] = credential
      state.connections[provider] = { connectedAt: new Date().toISOString(), accountLabel: validation.accountLabel, recordCounts: {}, mode: 'live' }
    })
    return validation
  }

  async disconnect(provider: ProviderId) {
    await this.store.update((state) => {
      delete state.credentials[provider]
      delete state.connections[provider]
      if (provider === 'stripe') delete state.workspace.payments
      if (provider === 'highlevel') { delete state.workspace.leads; delete state.workspace.deals; delete state.workspace.closers }
      if (provider === 'google-calendar') delete state.workspace.appointments
      if (provider === 'fathom') state.calls = []
    })
  }

  async sync(provider: ProviderId) {
    const state = await this.store.read()
    const credential = state.credentials[provider]
    if (!credential) {
      const meta = state.connections[provider]
      if (meta?.mode === 'sandbox') return this.syncSandbox(provider)
      throw new Error(`${provider} is not connected.`)
    }
    try {
      if (provider === 'stripe') {
        const payments = await syncStripe(credential as CredentialMap['stripe'], this.fetcher)
        await this.store.update((next) => { next.workspace.payments = payments; this.markSynced(next, provider, { payments: payments.rows.length }) })
      } else if (provider === 'highlevel') {
        const result = await syncHighLevel(credential as CredentialMap['highlevel'], this.fetcher)
        await this.store.update((next) => { Object.assign(next.workspace, result); this.markSynced(next, provider, { leads: result.leads.rows.length, deals: result.deals.rows.length, closers: result.closers.rows.length }) })
      } else if (provider === 'google-calendar') {
        const config = this.googleConfig(state)
        if (!config) throw new Error('Google OAuth credentials are not configured. Open Google Calendar in Integrations and add the app client ID and client secret first.')
        const result = await syncGoogleCalendar(credential as CredentialMap['google-calendar'], config.clientId, config.clientSecret, this.fetcher)
        await this.store.update((next) => { next.credentials['google-calendar'] = result.credential; next.workspace.appointments = result.appointments; this.markSynced(next, provider, { appointments: result.appointments.rows.length }) })
      } else {
        const calls = await syncFathom(credential as CredentialMap['fathom'], this.fetcher)
        await this.store.update((next) => { next.calls = calls; this.markSynced(next, provider, { calls: calls.length }) })
      }
    } catch (error) {
      await this.store.update((next) => {
        const meta = next.connections[provider]
        if (meta) meta.lastError = safeErrorMessage(error)
      })
      throw error
    }
    return this.snapshot()
  }

  async syncSandbox(provider: ProviderId) {
    const result = await sandboxSync(provider)
    await this.store.update((state) => {
      if (provider === 'stripe') state.workspace.payments = result.workspace.payments
      if (provider === 'highlevel') { state.workspace.leads = result.workspace.leads; state.workspace.deals = result.workspace.deals; state.workspace.closers = result.workspace.closers }
      if (provider === 'google-calendar') state.workspace.appointments = result.workspace.appointments
      if (provider === 'fathom') state.calls = result.calls ?? []
      state.connections[provider] = { connectedAt: state.connections[provider]?.connectedAt ?? new Date().toISOString(), lastSyncAt: new Date().toISOString(), accountLabel: result.accountLabel, recordCounts: result.recordCounts, mode: 'sandbox' }
      delete state.credentials[provider]
    })
    return this.snapshot()
  }

  private markSynced(state: Awaited<ReturnType<EncryptedStore['read']>>, provider: ProviderId, recordCounts: ProviderStatus['recordCounts']) {
    const meta = state.connections[provider]
    if (!meta) return
    meta.lastSyncAt = new Date().toISOString()
    meta.lastError = undefined
    meta.recordCounts = recordCounts
  }

  async snapshot() {
    const state = await this.store.read()
    return { workspace: state.workspace, calls: state.calls.map(({ id, title, startedAt, owner, participants, url }) => ({ id, title, startedAt, owner, participants, url })), statuses: await this.statuses() }
  }

  async calls(limit = 50) {
    const state = await this.store.read()
    return state.calls.slice(0, Math.max(1, Math.min(limit, 200)))
  }

  async syncAll() {
    const statuses = await this.statuses()
    const errors: Array<{ provider: ProviderId; error: string }> = []
    for (const status of statuses.filter((item) => item.connected)) {
      try { await this.sync(status.id) }
      catch (error) { errors.push({ provider: status.id, error: safeErrorMessage(error) }) }
    }
    return { ...(await this.snapshot()), errors }
  }

  async googleAuthorizationUrl() {
    const state = await this.store.read()
    const config = this.googleConfig(state)
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${process.env.APP_BASE_URL ?? 'http://127.0.0.1:8787'}/api/integrations/google-calendar/callback`
    if (!config) throw new Error('Add a Google OAuth client ID and client secret before connecting Google Calendar.')
    const stateValue = randomBytes(24).toString('hex')
    await this.store.update((next) => { next.oauthStates['google-calendar'] = { value: stateValue, expiresAt: Date.now() + 10 * 60_000 } })
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.readonly')
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('include_granted_scopes', 'true')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', stateValue)
    return url.toString()
  }

  async finishGoogleAuthorization(code: string, returnedState: string) {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${process.env.APP_BASE_URL ?? 'http://127.0.0.1:8787'}/api/integrations/google-calendar/callback`
    const state = await this.store.read()
    const config = this.googleConfig(state)
    if (!config) throw new Error('Google OAuth credentials are not configured.')
    const expected = state.oauthStates['google-calendar']
    if (!expected || expected.value !== returnedState || expected.expiresAt < Date.now()) throw new Error('Google OAuth state is invalid or expired.')
    const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
    if (!response.ok || !token.access_token) throw new Error(token.error_description ?? 'Google token exchange failed.')
    await this.store.update((next) => {
      next.credentials['google-calendar'] = { accessToken: token.access_token!, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 }
      next.connections['google-calendar'] = { connectedAt: new Date().toISOString(), accountLabel: 'Google Calendar', recordCounts: {}, mode: 'live' }
      delete next.oauthStates['google-calendar']
    })
  }
}
