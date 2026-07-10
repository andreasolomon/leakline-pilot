import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, AudioLines, CalendarDays, CheckCircle2, CreditCard, Database, FlaskConical, Link2, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react'
import { mergeIntegrationWorkspace, type ImportWorkspace } from './csvEngine'
import type { IntegrationSnapshot as Snapshot, ProviderId, ProviderStatus as Status } from './integrationTypes'

const providerIcons = { highlevel: Database, 'google-calendar': CalendarDays, stripe: CreditCard, fathom: AudioLines }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`)
  return body
}

export default function IntegrationPage({ initialWorkspace, onWorkspace }: { initialWorkspace: ImportWorkspace; onWorkspace: (workspace: ImportWorkspace) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ workspace: {}, calls: [], statuses: [] })
  const [selected, setSelected] = useState<Status | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>('loading')
  const [error, setError] = useState('')

  const connected = snapshot.statuses.filter((status) => status.connected).length
  const totalRecords = useMemo(() => snapshot.statuses.reduce((sum, status) => sum + Object.values(status.recordCounts).reduce((count, value) => count + value, 0), 0), [snapshot.statuses])

  const refresh = async () => {
    setBusy('loading'); setError('')
    try { setSnapshot(await api<Snapshot>('/api/integrations')) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Could not reach the integration service.') }
    finally { setBusy(null) }
  }

  useEffect(() => { void refresh() }, [])

  const applySnapshot = (next: Snapshot) => {
    setSnapshot(next)
    onWorkspace(mergeIntegrationWorkspace(initialWorkspace, next.workspace))
  }

  const connect = async () => {
    if (!selected) return
    setBusy(`connect-${selected.id}`); setError('')
    try {
      if (selected.id === 'google-calendar') {
        if (!selected.available) {
          await api<Snapshot>('/api/integrations/google-calendar/configure', { method: 'POST', body: JSON.stringify({ clientId: form.clientId, clientSecret: form.clientSecret }) })
        }
        const result = await api<{ url: string }>('/api/integrations/google-calendar/start')
        window.location.assign(result.url)
        return
      }
      const payload = selected.id === 'stripe' ? { secretKey: form.secretKey }
        : selected.id === 'highlevel' ? { accessToken: form.accessToken, locationId: form.locationId }
          : { apiKey: form.apiKey }
      applySnapshot(await api<Snapshot>(`/api/integrations/${selected.id}/connect`, { method: 'POST', body: JSON.stringify(payload) }))
      setSelected(null); setForm({})
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Connection failed.'); setForm({}) }
    finally { setBusy(null) }
  }

  const sync = async (provider: ProviderId) => {
    setBusy(`sync-${provider}`); setError('')
    try { applySnapshot(await api<Snapshot>(`/api/integrations/${provider}/sync`, { method: 'POST' })) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Sync failed.') }
    finally { setBusy(null) }
  }

  const sandboxSync = async (provider: ProviderId) => {
    setBusy(`sandbox-${provider}`); setError('')
    try { applySnapshot(await api<Snapshot>(`/api/integrations/${provider}/sandbox-sync`, { method: 'POST' })) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Sandbox sync failed.') }
    finally { setBusy(null) }
  }

  const syncAll = async () => {
    setBusy('sync-all'); setError('')
    try {
      const next = await api<Snapshot & { errors?: Array<{ provider: string; error: string }> }>('/api/integrations/sync-all', { method: 'POST' })
      applySnapshot(next)
      if (next.errors?.length) setError(next.errors.map((item) => `${item.provider}: ${item.error}`).join(' · '))
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Sync failed.') }
    finally { setBusy(null) }
  }

  const disconnect = async (provider: ProviderId) => {
    if (!window.confirm('Disconnect this provider and remove its synced records from Leakline?')) return
    setBusy(`disconnect-${provider}`); setError('')
    try { applySnapshot(await api<Snapshot>(`/api/integrations/${provider}/disconnect`, { method: 'POST' })) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Disconnect failed.') }
    finally { setBusy(null) }
  }

  return <section className="integrations-page">
    <div className="page-heading integrations-heading"><div><p>Version 2 · live data</p><h1>Connect your revenue stack.</h1><span>Credentials are sent only to the local Leakline backend and encrypted at rest.</span></div><div className="integration-heading-actions">{connected > 1 && <button disabled={Boolean(busy)} onClick={syncAll}><RefreshCw size={14} className={busy === 'sync-all' ? 'spin' : ''} /> Sync all</button>}<div className="integration-summary"><strong>{connected}/4</strong><span>connected</span><em>{totalRecords} synced records</em></div></div></div>
    {error && !selected && <div className="integration-error"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
    {busy === 'loading' && !snapshot.statuses.length ? <div className="integration-loading"><RefreshCw size={22} className="spin" /><span>Checking integration service…</span></div> : <div className="integration-grid">
      {snapshot.statuses.map((status) => {
        const Icon = providerIcons[status.id]
        const recordCount = Object.values(status.recordCounts).reduce((sum, value) => sum + value, 0)
        return <article className={`integration-card ${status.connected ? 'connected' : ''}`} key={status.id}>
          <div className="integration-card-top"><span className="provider-icon"><Icon size={20} /></span><span className={`connection-state ${status.mode === 'sandbox' ? 'sandbox' : status.connected ? 'healthy' : status.available ? 'idle' : 'blocked'}`}>{status.mode === 'sandbox' ? <><FlaskConical size={13} /> Sandbox</> : status.connected ? <><CheckCircle2 size={13} /> Connected</> : status.available ? 'Not connected' : 'Setup required'}</span></div>
          <span className="eyebrow">{status.category}</span><h2>{status.label}</h2><p>{status.description}</p>
          {status.connected ? <div className="connection-detail"><strong>{status.accountLabel ?? status.label}</strong><span>{recordCount} records · {status.lastSyncAt ? `synced ${new Date(status.lastSyncAt).toLocaleString('en-GB')}` : 'not synced yet'}</span>{status.mode === 'sandbox' && <small>Uses realistic sample payloads. Replace this with a live connection when credentials are available.</small>}{status.lastError && <em>{status.lastError}</em>}</div> : !status.available && <div className="connection-detail blocked"><strong>App credentials needed</strong><span>Add a Google OAuth client ID and secret once, then connect your Calendar account.</span></div>}
          <div className="integration-actions">{status.connected ? <><button className="sync-button" disabled={Boolean(busy)} onClick={() => sync(status.id)}><RefreshCw size={14} className={busy === `sync-${status.id}` || busy === `sandbox-${status.id}` ? 'spin' : ''} /> Sync now</button><button className="disconnect-button" disabled={Boolean(busy)} onClick={() => disconnect(status.id)}><Unplug size={14} /> Disconnect</button></> : <><button className="connect-button" disabled={Boolean(busy)} onClick={() => { setSelected(status); setForm({}); setError('') }}><Link2 size={14} /> {status.id === 'google-calendar' && !status.available ? 'Configure Google' : `Connect ${status.label}`}</button><button className="sandbox-button" disabled={Boolean(busy)} onClick={() => sandboxSync(status.id)}><FlaskConical size={14} /> Sandbox</button></>}</div>
        </article>
      })}
    </div>}
    <article className="integration-security"><ShieldCheck size={20} /><div><strong>Built with a secure boundary</strong><span>Provider secrets never enter browser storage. OAuth requests use state validation, synced data is encrypted on disk, and every connection requests read-only access where the provider supports it.</span></div></article>

    {selected && <div className="connection-modal-backdrop" onClick={() => setSelected(null)}><section className="connection-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setSelected(null)}><X size={18} /></button><span className="eyebrow">Connect {selected.category}</span><h2>{selected.label}</h2><p>{selected.id === 'google-calendar' ? selected.available ? 'You will be redirected to Google to grant read-only Calendar access.' : 'First add the OAuth client from Google Cloud. Use http://localhost:8787/api/integrations/google-calendar/callback as the redirect URI.' : 'Your credential is validated before it is encrypted and saved.'}</p>{error && <div className="modal-error"><AlertTriangle size={15} /><span>{error}</span></div>}
      {selected.id === 'stripe' && <label>Restricted or secret API key<input type="password" autoComplete="off" placeholder="rk_test_… or sk_test_…" value={form.secretKey ?? ''} onChange={(event) => setForm({ ...form, secretKey: event.target.value })} /><small>Recommended restricted permissions: Charges read and Invoices read.</small></label>}
      {selected.id === 'highlevel' && <><label>Private integration token<input type="password" autoComplete="off" placeholder="GoHighLevel token" value={form.accessToken ?? ''} onChange={(event) => setForm({ ...form, accessToken: event.target.value })} /></label><label>Location ID<input placeholder="Sub-account location ID" value={form.locationId ?? ''} onChange={(event) => setForm({ ...form, locationId: event.target.value })} /></label></>}
      {selected.id === 'google-calendar' && !selected.available && <><label>Google OAuth client ID<input autoComplete="off" placeholder="1234567890-abc.apps.googleusercontent.com" value={form.clientId ?? ''} onChange={(event) => setForm({ ...form, clientId: event.target.value })} /></label><label>Google OAuth client secret<input type="password" autoComplete="off" placeholder="GOCSPX-…" value={form.clientSecret ?? ''} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} /><small>Stored encrypted in the local Leakline backend, not in browser storage.</small></label></>}
      {selected.id === 'fathom' && <label>Fathom API key<input type="password" autoComplete="off" placeholder="Fathom API key" value={form.apiKey ?? ''} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /><small>Create this under Fathom User Settings → API Access.</small></label>}
      <button className="primary-button" disabled={Boolean(busy)} onClick={connect}>{busy === `connect-${selected.id}` ? <><RefreshCw size={15} className="spin" /> Validating…</> : <><Link2 size={15} /> {selected.id === 'google-calendar' && !selected.available ? 'Save and open Google' : 'Continue securely'}</>}</button>
    </section></div>}
  </section>
}
