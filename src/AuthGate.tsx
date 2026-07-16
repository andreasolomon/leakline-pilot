import { FormEvent, ReactNode, useEffect, useState } from 'react'
import { LockKeyhole, ShieldCheck } from 'lucide-react'

export type AuthRole = 'owner' | 'admin' | 'manager' | 'viewer'
export type AuthWorkspace = { id: string; name: string; clientName: string; role: AuthRole; recordCount: number }
export type AuthUser = { id: string; name: string; email: string; role: AuthRole; status: 'active' | 'disabled'; workspaceId: string; workspaces: AuthWorkspace[] }

type AuthMeta = {
  enabled: boolean
  authenticated: boolean
  signupAvailable: boolean
  inviteRequired: boolean
  user: AuthUser | null
}

type InvitePreview = { email: string; role: Exclude<AuthRole, 'owner'>; workspaces: Array<{ id: string; name: string; clientName: string }>; expiresAt: string }

async function authRequest(path: string, body?: Record<string, string>) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'Authentication failed.')
  return payload
}

export default function AuthGate({ children }: { children: (props: { user: AuthUser; onLogout: () => void }) => ReactNode }) {
  const [meta, setMeta] = useState<AuthMeta | null>(null)
  const [mode, setMode] = useState<'signup' | 'login' | 'request-access'>('signup')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', email: '', password: '', inviteCode: '' })
  const [invite, setInvite] = useState<InvitePreview | null>(null)
  const [inviteLoading, setInviteLoading] = useState(false)

  const inviteToken = window.location.pathname.startsWith('/invite/') ? decodeURIComponent(window.location.pathname.replace('/invite/', '').split('/')[0] ?? '') : ''

  const refresh = async () => {
    const next = await authRequest('/api/auth/me') as AuthMeta
    setMeta(next)
    if (!next.signupAvailable) setMode('login')
  }

  useEffect(() => {
    if (!inviteToken) void refresh().catch((event) => setError(event instanceof Error ? event.message : 'Could not load login status.'))
  }, [inviteToken])

  useEffect(() => {
    if (!inviteToken) return
    setInviteLoading(true)
    authRequest(`/api/invites/${inviteToken}`)
      .then((payload) => setInvite((payload as { invite: InvitePreview }).invite))
      .catch((event) => setError(event instanceof Error ? event.message : 'Invite could not be loaded.'))
      .finally(() => setInviteLoading(false))
  }, [inviteToken])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await authRequest(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', mode === 'signup' ? form : { email: form.email, password: form.password })
      await refresh()
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Authentication failed.')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    await authRequest('/api/auth/logout', {})
    setMeta((current) => current ? { ...current, authenticated: false, user: null } : current)
    setMode('login')
  }

  const acceptInvite = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const payload = await authRequest(`/api/invites/${inviteToken}/accept`, { name: form.name, password: form.password }) as { user: AuthUser }
      window.history.replaceState({}, '', '/app')
      setMeta({ enabled: true, authenticated: true, signupAvailable: false, inviteRequired: true, user: payload.user })
    } catch (event) {
      setError(event instanceof Error ? event.message : 'Invite could not be accepted.')
    } finally {
      setBusy(false)
    }
  }

  if (inviteToken) return (
    <div className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><span>LL</span><div><strong>Leakline</strong><small>Private invite</small></div></div>
        {inviteLoading ? <div className="auth-card compact"><LockKeyhole size={22} /><strong>Checking invite…</strong></div> : invite ? <>
          <div className="auth-copy">
            <p><ShieldCheck size={15} /> Workspace invite</p>
            <h1>Create your LeakLine password.</h1>
            <span>You have been invited as <strong>{invite.role}</strong> for {invite.workspaces.map((workspace) => workspace.clientName).join(', ')}. This invite expires {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(invite.expiresAt))}.</span>
          </div>
          <form onSubmit={acceptInvite} className="auth-form">
            <label>Email<input readOnly value={invite.email} /></label>
            <label>Name<input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" /></label>
            <label>Password<input required type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="At least 10 characters" /></label>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" disabled={busy}>{busy ? 'Creating account…' : 'Accept invite'}</button>
          </form>
        </> : <div className="auth-form">
          <div className="auth-error">{error || 'Invite is invalid or no longer available.'}</div>
          <button className="auth-submit" type="button" onClick={() => { window.history.replaceState({}, '', '/app'); setError(''); void refresh() }}>Back to log in</button>
        </div>}
      </section>
    </div>
  )
  if (!meta && !error) return <div className="auth-screen"><div className="auth-card compact"><LockKeyhole size={22} /><strong>Opening Leakline…</strong></div></div>
  if (meta?.authenticated && meta.user) return <>{children({ user: meta.user, onLogout: logout })}</>

  const signupClosed = !meta?.signupAvailable
  const activeMode = signupClosed && mode === 'signup' ? 'request-access' : mode

  return (
    <div className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><span>LL</span><div><strong>Leakline</strong><small>Private pilot access</small></div></div>
        <div className="auth-copy">
          <p><ShieldCheck size={15} /> Client data is protected behind invite-only access.</p>
          <h1>{activeMode === 'signup' ? 'Create your pilot login.' : activeMode === 'request-access' ? 'Account creation is managed privately.' : 'Log in to Leakline.'}</h1>
          <span>{activeMode === 'signup' ? 'Use the invite code from Leakline to create the first pilot account.' : activeMode === 'request-access' ? 'For pilot security, new client accounts are created by an admin and assigned to the right workspace.' : 'Enter your email and password to work your private revenue recovery cases.'}</span>
        </div>
        <div className="auth-tabs">
          <button className={activeMode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Log in</button>
          <button className={activeMode === 'signup' || activeMode === 'request-access' ? 'active' : ''} onClick={() => setMode(signupClosed ? 'request-access' : 'signup')}>Create account</button>
        </div>
        {activeMode === 'request-access'
          ? <div className="auth-form">
              <div className="auth-note">
                <strong>Create accounts from the Admin page.</strong>
                <span>Log in as Andrea Admin, open Admin → User access, create the client user, then send them the public URL and temporary password privately.</span>
              </div>
              <button className="auth-submit" type="button" onClick={() => setMode('login')}>Back to log in</button>
            </div>
          : <form onSubmit={submit} className="auth-form">
              {activeMode === 'signup' && <label>Name<input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" /></label>}
              <label>Email<input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@company.com" /></label>
              <label>Password<input required type="password" autoComplete={activeMode === 'signup' ? 'new-password' : 'current-password'} minLength={activeMode === 'signup' ? 10 : undefined} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={activeMode === 'signup' ? 'At least 10 characters' : 'Your password'} /></label>
              {activeMode === 'signup' && meta?.inviteRequired && <label>Invite code<input required autoComplete="off" value={form.inviteCode} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} placeholder="Private pilot invite code" /></label>}
              {error && <div className="auth-error">{error}</div>}
              <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : activeMode === 'signup' ? 'Create account' : 'Log in'}</button>
            </form>}
      </section>
    </div>
  )
}
