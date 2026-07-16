import { type FormEvent, useEffect, useState } from 'react'
import { ArrowRight, CalendarDays, Check, CheckCircle2, Clock3, MessageSquarePlus, X } from 'lucide-react'
import type { Leak } from './data'
import { recoveryStatusLabels, type RecoveryCase, type RecoveryCaseStatus, type RecoveryCaseUpdate } from './recoveryCases'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const statuses: RecoveryCaseStatus[] = ['detected', 'assigned', 'in_progress', 'resolved']

type Props = {
  leak: Leak
  recoveryCase?: RecoveryCase
  canAct: boolean
  ownerOptions: string[]
  onClose: () => void
  onUpdate: (caseId: string, update: RecoveryCaseUpdate) => Promise<void>
  onOpenRecords: (leak: Leak) => void
}

export default function RecoveryCaseDrawer({ leak, recoveryCase, canAct, ownerOptions, onClose, onUpdate, onOpenRecords }: Props) {
  const [owner, setOwner] = useState(recoveryCase?.owner ?? leak.owner)
  const [deadline, setDeadline] = useState(recoveryCase?.deadline ?? '')
  const [note, setNote] = useState('')
  const [resolution, setResolution] = useState(recoveryCase?.resolution ?? '')
  const [recoveredAmount, setRecoveredAmount] = useState(String(recoveryCase?.recoveredAmount ?? 0))
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setOwner(recoveryCase?.owner ?? leak.owner)
    setDeadline(recoveryCase?.deadline ?? '')
    setResolution(recoveryCase?.resolution ?? '')
    setRecoveredAmount(String(recoveryCase?.recoveredAmount ?? 0))
  }, [leak.id, recoveryCase?.deadline, recoveryCase?.owner, recoveryCase?.recoveredAmount, recoveryCase?.resolution])

  const update = async (label: string, next: RecoveryCaseUpdate) => {
    if (!recoveryCase || !canAct) return
    setBusy(label)
    setError('')
    try { await onUpdate(recoveryCase.id, next) }
    catch (event) { setError(event instanceof Error ? event.message : 'Could not update this recovery case.') }
    finally { setBusy('') }
  }

  const saveAssignment = (event: FormEvent) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget as HTMLFormElement)
    const nextOwner = String(fields.get('owner') ?? owner).trim()
    const nextDeadline = String(fields.get('deadline') ?? deadline)
    void update('assignment', { owner: nextOwner, deadline: nextDeadline || null, status: nextOwner ? 'assigned' : 'detected' })
  }

  const addNote = (event: FormEvent) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget as HTMLFormElement)
    const nextNote = String(fields.get('note') ?? note).trim()
    if (!nextNote) return
    void update('note', { note: nextNote }).then(() => setNote(''))
  }

  const resolveCase = (event: FormEvent) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget as HTMLFormElement)
    const nextResolution = String(fields.get('resolution') ?? resolution).trim()
    const amount = Number(fields.get('recoveredAmount') ?? recoveredAmount)
    if (!nextResolution) return setError('Add a short resolution before closing the case.')
    if (!Number.isFinite(amount) || amount < 0) return setError('Recovered revenue must be zero or more.')
    void update('resolution', { resolution: nextResolution, recoveredAmount: amount, status: 'resolved' })
  }

  return <div className="drawer-backdrop" onClick={onClose}>
    <aside className="detail-drawer recovery-case-drawer" onClick={(event) => event.stopPropagation()}>
      <button className="drawer-close" aria-label="Close recovery case" onClick={onClose}><X size={20} /></button>
      <span className={`drawer-severity ${leak.severity}`}>{leak.severity}</span>
      <p className="eyebrow">{leak.type} recovery case</p>
      <h2>{leak.title}</h2>
      <p className="drawer-description">{leak.description}</p>

      <div className="case-status-track" aria-label="Recovery case status">
        {statuses.map((status) => <button key={status} className={recoveryCase?.status === status ? 'active' : ''} disabled={!canAct || !recoveryCase || busy !== '' || status === 'resolved'} onClick={() => void update(`status-${status}`, { status })}>{recoveryStatusLabels[status]}</button>)}
      </div>

      <div className="impact-box"><span>Estimated impact</span><strong>{money.format(leak.impact)}</strong><small>{leak.count} affected record{leak.count === 1 ? '' : 's'} · detected from {leak.periodLabel.toLowerCase()}</small></div>
      <div className="drawer-period"><CalendarDays size={14} /><span>Evidence period</span><strong>{leak.periodLabel}</strong></div>
      <div className="evidence"><h3>Why this was detected</h3><ul>{leak.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div>

      {leak.relatedRecords?.length && <div className="related-records" id="related-records-review">
        <div className="related-records-head"><div><h3>Affected-record queue</h3><p>Highest-priority records are shown first.</p></div><span>{leak.relatedRecords.length} shown</span></div>
        <div className="related-record-list">{leak.relatedRecords.map((record, index) => <article key={record.id ?? `${record.email}-${index}`}><div><strong>{record.name}</strong><small>{record.email || 'No email'}{record.source ? ` · ${record.source}` : ''}</small></div><span>{record.owner || 'Unassigned'}</span><em>{record.status || 'lead'}</em>{record.createdAt && <time>{new Date(record.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</time>}</article>)}</div>
      </div>}

      {leak.breakdown && <div className="drawer-breakdown"><h3>Where the leak is concentrated</h3>{leak.breakdown.map((row) => <div key={row.label}><strong>{row.label}</strong><span>{row.current}</span><small>Baseline {row.baseline}</small><em className={row.signal.startsWith('+') ? 'positive' : 'negative'}>{row.signal}</em></div>)}</div>}

      <section className="case-section">
        <div className="case-section-head"><div><span className="eyebrow">Recovery plan</span><h3>Measurable next actions</h3></div><span>{recoveryCase?.actions.filter((action) => action.completed).length ?? 0}/{recoveryCase?.actions.length ?? leak.suggestedActions.length}</span></div>
        <div className="case-action-list">{(recoveryCase?.actions ?? leak.suggestedActions.map((text, index) => ({ id: `pending-${index}`, text, completed: false }))).map((action) => <button key={action.id} disabled={!canAct || !recoveryCase || busy !== ''} className={action.completed ? 'completed' : ''} onClick={() => void update(`action-${action.id}`, { actionId: action.id, actionCompleted: !action.completed })}><i>{action.completed ? <Check size={13} /> : null}</i><span>{action.text}</span><small>{action.completed ? 'Completed' : 'Mark done'}</small></button>)}</div>
      </section>

      <form className="case-assignment" onSubmit={saveAssignment}>
        <div className="case-section-head"><div><span className="eyebrow">Accountability</span><h3>Owner and deadline</h3></div></div>
        <div className="case-control-grid">
          <label>Assigned owner<input name="owner" required disabled={!canAct || !recoveryCase} list="recovery-owner-options" value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <datalist id="recovery-owner-options">{ownerOptions.map((item) => <option value={item} key={item} />)}</datalist>
          <label>Deadline<input name="deadline" disabled={!canAct || !recoveryCase} type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
        </div>
        <button className="secondary-button" disabled={!canAct || !recoveryCase || busy !== ''}>{busy === 'assignment' ? 'Saving…' : 'Save assignment'}</button>
      </form>

      <form className="case-note-form" onSubmit={addNote}>
        <div className="case-section-head"><div><span className="eyebrow">Recovery context</span><h3>Case notes and blockers</h3></div></div>
        <textarea name="note" disabled={!canAct || !recoveryCase} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add context, an outcome or a blocker…" />
        <button className="secondary-button" disabled={!canAct || !recoveryCase || !note.trim() || busy !== ''}><MessageSquarePlus size={14} />{busy === 'note' ? 'Adding…' : 'Add note'}</button>
        {recoveryCase?.notes.length ? <div className="case-notes">{recoveryCase.notes.map((item) => <article key={item.id}><p>{item.text}</p><span>{item.createdBy} · {new Date(item.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></article>)}</div> : null}
      </form>

      <form className="case-resolution" onSubmit={resolveCase}>
        <div className="case-section-head"><div><span className="eyebrow">Close the loop</span><h3>Resolution and recovered revenue</h3></div>{recoveryCase?.status === 'resolved' && <span className="resolved-pill"><CheckCircle2 size={13} /> Resolved</span>}</div>
        <label>Recovered revenue ($)<input name="recoveredAmount" disabled={!canAct || !recoveryCase} type="number" min="0" step="1" value={recoveredAmount} onChange={(event) => setRecoveredAmount(event.target.value)} /></label>
        <label>Resolution<textarea name="resolution" disabled={!canAct || !recoveryCase} value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="What was done and what was the outcome?" /></label>
        <button className="primary-button" disabled={!canAct || !recoveryCase || busy !== '' || recoveryCase.status === 'resolved'}>{busy === 'resolution' ? 'Saving resolution…' : recoveryCase?.status === 'resolved' ? `Resolved · ${money.format(recoveryCase.recoveredAmount)}` : 'Resolve case and record recovery'}<ArrowRight size={16} /></button>
      </form>

      {error && <div className="case-error">{error}</div>}
      {!recoveryCase && <div className="case-loading"><Clock3 size={15} /> Preparing shared recovery case…</div>}

      {recoveryCase?.activity.length ? <section className="case-activity"><div className="case-section-head"><div><span className="eyebrow">Recovery audit trail</span><h3>Case activity and outcomes</h3></div></div>{recoveryCase.activity.map((item) => <article key={item.id}><i /><div><p>{item.text}</p><span>{item.createdBy} · {new Date(item.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div></article>)}</section> : null}

      <button className="secondary-button" onClick={() => onOpenRecords(leak)}>Open supporting leak evidence <ArrowRight size={15} /></button>
    </aside>
  </div>
}
