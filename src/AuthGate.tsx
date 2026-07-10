import { FormEvent, ReactNode, useEffect, useState } from 'react'
import { LockKeyhole, ShieldCheck } from 'lucide-react'

export type AuthUser = { id: string; name: string; email: string }

type AuthMeta = {
  enabled: boolean
  authenticated: boolean
  signupAvailable: boolean
  inviteRequired: boolean
  user: AuthUser | null
}

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
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', email: '', password: '', inviteCode: '' })

  const refresh = async () => {
    const next = await authRequest('/api/auth/me') as AuthMeta
    setMeta(next)
    if (!next.signupAvailable) setMode('login')
  }

  useEffect(() => { void refresh().catch((event) => setError(event instanceof Error ? event.message : 'Could not load login status.')) }, [])

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

  if (!meta && !error) return <div className="auth-screen"><div className="auth-card compact"><LockKeyhole size={22} /><strong>Opening Leakline…</strong></div></div>
  if (meta?.authenticated && meta.user) return <>{children({ user: meta.user, onLogout: logout })}</>

  const signupDisabled = !meta?.signupAvailable
  const activeMode = signupDisabled ? 'login' : mode

  return (
    <div className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><span>LL</span><div><strong>Leakline</strong><small>Private pilot access</small></div></div>
        <div className="auth-copy">
          <p><ShieldCheck size={15} /> Client data is protected behind invite-only access.</p>
          <h1>{activeMode === 'signup' ? 'Create your pilot login.' : 'Log in to Leakline.'}</h1>
          <span>{activeMode === 'signup' ? 'Use the invite code from Leakline to create the first pilot account.' : 'Enter your email and password to view the private revenue dashboard.'}</span>
        </div>
        <div className="auth-tabs">
          <button className={activeMode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Log in</button>
          <button className={activeMode === 'signup' ? 'active' : ''} disabled={signupDisabled} onClick={() => setMode('signup')}>Create account</button>
        </div>
        <form onSubmit={submit} className="auth-form">
          {activeMode === 'signup' && <label>Name<input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" /></label>}
          <label>Email<input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@company.com" /></label>
          <label>Password<input required type="password" autoComplete={activeMode === 'signup' ? 'new-password' : 'current-password'} minLength={activeMode === 'signup' ? 10 : undefined} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={activeMode === 'signup' ? 'At least 10 characters' : 'Your password'} /></label>
          {activeMode === 'signup' && meta?.inviteRequired && <label>Invite code<input required autoComplete="off" value={form.inviteCode} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} placeholder="Private pilot invite code" /></label>}
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : activeMode === 'signup' ? 'Create account' : 'Log in'}</button>
        </form>
      </section>
    </div>
  )
}
