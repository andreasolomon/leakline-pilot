import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarCheck, CheckCircle2, Clock3, Link2, RefreshCw, Users } from 'lucide-react'
import { formatZoomMeetingSeries, parseZoomMeetingSeries, type ZoomMeetingSeries } from './zoomMeetingSeries'

type CoachingSettings = { meetingSeries: ZoomMeetingSeries[]; minimumMinutes: number; requiredSessionsPerWeek: number; teamEmails: string[] }
type CoachingParticipant = { id: string; name: string; email?: string; durationMinutes: number; matchType: 'email' | 'name' | 'unmatched' | 'team'; matchedClientId?: string }
type CoachingSession = { id: string; topic: string; startedAt: string; participants: CoachingParticipant[] }
type CoachingClient = { clientId: string; name: string; email?: string; owner: string; sessionsAvailable: number; weeksAvailable: number; attended: number; missed: number; attendanceRate: number; lastAttendedAt?: string; consecutiveMisses: number }
type CoachingReport = { connected: boolean; settings: CoachingSettings; attendanceRule: string; sessions: CoachingSession[]; clients: CoachingClient[]; unmatched: Array<CoachingParticipant & { sessionId: string; sessionStartedAt: string }> }

async function coachingApi<T>(path = '/api/coaching-attendance', init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`)
  return body
}

const formatDate = (value?: string) => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not attended'

export default function CoachingAttendancePage({ canAct, onOpenDataSources }: { canAct: boolean; onOpenDataSources: () => void }) {
  const [report, setReport] = useState<CoachingReport | null>(null)
  const [meetingSeries, setMeetingSeries] = useState('')
  const [minimumMinutes, setMinimumMinutes] = useState(15)
  const [teamEmails, setTeamEmails] = useState('')
  const [busy, setBusy] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setError('')
    try {
      const next = await coachingApi<CoachingReport>()
      setReport(next)
      setMeetingSeries(formatZoomMeetingSeries(next.settings.meetingSeries))
      setMinimumMinutes(next.settings.minimumMinutes)
      setTeamEmails(next.settings.teamEmails.join(', '))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Coaching attendance could not be loaded.')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void load() }, [])

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('settings'); setError(''); setNotice('')
    try {
      const next = await coachingApi<CoachingReport>('/api/coaching-attendance/settings', {
        method: 'PATCH',
        body: JSON.stringify({ meetingSeries: parseZoomMeetingSeries(meetingSeries), minimumMinutes, requiredSessionsPerWeek: 1, teamEmails: teamEmails.split(',').map((email) => email.trim()).filter(Boolean) }),
      })
      setReport(next)
      setNotice('Coaching attendance rules saved.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The coaching settings could not be saved.')
    } finally { setBusy('') }
  }

  const syncZoom = async () => {
    setBusy('sync'); setError(''); setNotice('')
    try {
      await coachingApi('/api/integrations/zoom/sync', { method: 'POST' })
      await load()
      setNotice('Zoom coaching attendance synced.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Zoom attendance could not be synced.')
      setBusy('')
    }
  }

  const trackedClients = useMemo(() => report?.clients.filter((client) => client.sessionsAvailable > 0) ?? [], [report])
  const attendedTotal = trackedClients.reduce((sum, client) => sum + client.attended, 0)
  const possibleTotal = trackedClients.reduce((sum, client) => sum + client.sessionsAvailable, 0)
  const overallRate = possibleTotal ? Math.round((attendedTotal / possibleTotal) * 100) : 0

  return <section className="coaching-attendance-page">
    <div className="page-heading coaching-heading"><div><p>Client engagement</p><h1>Coaching attendance</h1><span>Track who attends each recurring coaching call without adding another manual sheet.</span></div><div className="coaching-heading-actions">{report?.connected ? <button className="primary-button" disabled={!canAct || Boolean(busy)} onClick={syncZoom}><RefreshCw size={15} className={busy === 'sync' ? 'spin' : ''} /> Sync Zoom</button> : <button className="primary-button" disabled={!canAct} onClick={onOpenDataSources}><Link2 size={15} /> Connect Zoom</button>}</div></div>

    {error && <div className="integration-error"><AlertTriangle size={16} /><span>{error}</span></div>}
    {notice && <div className="renewal-notice"><CheckCircle2 size={16} /><span>{notice}</span></div>}

    <div className="coaching-metrics">
      <article><span>Sessions synced</span><strong>{report?.sessions.length ?? 0}</strong><small>Completed Zoom occurrences</small></article>
      <article><span>Clients tracked</span><strong>{trackedClients.length}</strong><small>Clients with eligible sessions</small></article>
      <article><span>Weekly attendance</span><strong>{overallRate}%</strong><small>{report?.attendanceRule ?? 'One qualifying call per week'}</small></article>
      <article><span>Needs matching</span><strong>{report?.unmatched.length ?? 0}</strong><small>Zoom attendees requiring review</small></article>
    </div>

    <div className="coaching-layout">
      <section className="panel coaching-client-panel">
        <div className="coaching-panel-heading"><div><span>Client-level view</span><h2>Attendance by client</h2></div><Users size={20} /></div>
        {!report || busy === 'loading' ? <div className="integration-loading"><RefreshCw size={20} className="spin" /> Loading coaching attendance...</div> : !trackedClients.length ? <div className="coaching-empty"><CalendarCheck size={28} /><strong>No attendance has been matched yet</strong><span>Connect Zoom, save the recurring meeting links and sync completed calls.</span></div> : <div className="coaching-table"><div className="coaching-table-head"><span>Client</span><span>Weeks attended</span><span>Weeks missed</span><span>Rate</span><span>Last attended</span></div>{trackedClients.map((client) => <div className={client.consecutiveMisses >= 2 ? 'attention' : ''} key={client.clientId}><span><strong>{client.name}</strong><small>{client.owner}</small></span><span>{client.attended}/{client.weeksAvailable}</span><span>{client.missed}{client.consecutiveMisses >= 2 && <small>{client.consecutiveMisses} consecutive</small>}</span><span><em>{client.attendanceRate}%</em></span><span>{formatDate(client.lastAttendedAt)}</span></div>)}</div>}
      </section>

      <aside className="panel coaching-settings-panel">
        <div className="coaching-panel-heading"><div><span>Tracking rules</span><h2>Zoom coaching series</h2></div><Clock3 size={20} /></div>
        <form onSubmit={saveSettings}>
          <label>Recurring coaching meetings<textarea rows={5} value={meetingSeries} onChange={(event) => setMeetingSeries(event.target.value)} placeholder={'Fred coaching calls | 82769043003\nYonas Friday coaching | 86912599864'} /><small>Add one labelled Zoom meeting link or ID per line. Attendance at any listed call can satisfy the weekly requirement.</small></label>
          <label>Minimum attendance<input type="number" min="1" max="180" value={minimumMinutes} onChange={(event) => setMinimumMinutes(Number(event.target.value))} /><small>A client counts as attending after this many total minutes.</small></label>
          <label>Team emails<textarea rows={3} value={teamEmails} onChange={(event) => setTeamEmails(event.target.value)} placeholder="fred@launchwebinars.io, yonas@launchwebinars.io" /><small>Comma-separated staff emails are excluded from client attendance.</small></label>
          <button className="secondary-button" disabled={!canAct || busy === 'settings'}>{busy === 'settings' ? <RefreshCw size={14} className="spin" /> : <CheckCircle2 size={14} />} Save tracking rules</button>
        </form>
      </aside>
    </div>

    <div className="coaching-secondary-grid">
      <section className="panel coaching-session-panel"><div className="coaching-panel-heading"><div><span>Recent calls</span><h2>Synced sessions</h2></div></div>{report?.sessions.slice(0, 8).map((session) => <div className="coaching-session-row" key={session.id}><span><strong>{formatDate(session.startedAt)}</strong><small>{session.topic}</small></span><span>{session.participants.filter((participant) => participant.matchType === 'email' || participant.matchType === 'name').length} clients matched</span></div>)}{!report?.sessions.length && <p className="coaching-panel-empty">Completed Zoom sessions will appear here after the first sync.</p>}</section>
      <section className="panel coaching-unmatched-panel"><div className="coaching-panel-heading"><div><span>Review queue</span><h2>Unmatched attendees</h2></div></div>{report?.unmatched.slice(0, 12).map((participant) => <div className="coaching-session-row" key={`${participant.sessionId}-${participant.id}`}><span><strong>{participant.name}</strong><small>{participant.email || 'No email supplied by Zoom'}</small></span><span>{formatDate(participant.sessionStartedAt)}</span></div>)}{!report?.unmatched.length && <p className="coaching-panel-empty">No unmatched Zoom attendees.</p>}</section>
    </div>
  </section>
}
