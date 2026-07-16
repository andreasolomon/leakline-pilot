import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, AudioLines, ChevronDown, ChevronUp, ExternalLink, RefreshCw, Search, Users } from 'lucide-react'

type Call = { id: string; title: string; startedAt: string | null; owner: string; participants: string[]; transcript: string; summary: string; url: string }

export default function CallsPage() {
  const [calls, setCalls] = useState<Call[]>([])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/calls?limit=200')
      const body = await response.json() as { calls?: Call[]; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Calls could not be loaded.')
      setCalls(body.calls ?? [])
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Calls could not be loaded.') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? calls.filter((call) => `${call.title} ${call.owner} ${call.participants.join(' ')} ${call.transcript}`.toLowerCase().includes(needle)) : calls
  }, [calls, query])

  return <section className="calls-page"><div className="page-heading section-heading"><div><p>Fathom · synced calls</p><h1>Call library</h1><span>Search recordings and transcripts for objections, follow-up gaps and repeated reasons qualified revenue is not converting.</span></div><button className="calls-refresh" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button></div>
    <article className="panel full-panel"><div className="calls-toolbar"><div><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search objections, calls or transcript text" /></div><span>{visible.length} calls</span></div>
      {error ? <div className="empty-alerts"><AlertTriangle size={24} /><h3>Calls unavailable</h3><p>{error}</p></div> : loading ? <div className="empty-alerts"><RefreshCw size={24} className="spin" /><h3>Loading calls</h3></div> : visible.length ? <div className="calls-list">{visible.map((call) => <section className="call-record" key={call.id}><button className="call-summary" onClick={() => setExpanded(expanded === call.id ? null : call.id)}><span className="call-icon"><AudioLines size={17} /></span><span><strong>{call.title}</strong><small>{call.startedAt ? new Date(call.startedAt).toLocaleString('en-GB') : 'No recording date'} · {call.owner || 'Unknown owner'}</small></span><em><Users size={13} /> {call.participants.length}</em>{expanded === call.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>{expanded === call.id && <div className="call-detail"><div><span className="eyebrow">Participants</span><p>{call.participants.join(', ') || 'No participants supplied'}</p></div><div><span className="eyebrow">Call summary</span><p>{call.summary || 'No summary supplied by Fathom.'}</p></div><div><span className="eyebrow">Transcript</span><pre>{call.transcript || 'No transcript supplied by Fathom.'}</pre></div>{call.url && <a href={call.url} target="_blank" rel="noreferrer">Open recording <ExternalLink size={13} /></a>}</div>}</section>)}</div> : <div className="empty-alerts"><AudioLines size={24} /><h3>No calls connected yet</h3><p>Connect Fathom from Data sources, then run a sync.</p></div>}
    </article>
  </section>
}
