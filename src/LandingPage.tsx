import { FormEvent, useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, CircleDollarSign, Play, ShieldCheck, Target } from 'lucide-react'
import logoMark from './assets/leakline-mark.svg'
import { contactHref } from './siteConfig'
import vslVideoUrl from '../leakline-vsl-overlay-clean-crisp-with-music.mp4'

type ApplicationForm = {
  name: string
  email: string
  phone: string
  company: string
  website: string
  role: string
  monthlyOverdueVolume: string
  monthlyFailedPayments: string
  paymentProvider: string
  crm: string
  currentRecoveryProcess: string
  notes: string
}

const initialForm: ApplicationForm = {
  name: '',
  email: '',
  phone: '',
  company: '',
  website: '',
  role: '',
  monthlyOverdueVolume: '',
  monthlyFailedPayments: '',
  paymentProvider: '',
  crm: '',
  currentRecoveryProcess: '',
  notes: '',
}

const fitSignals = [
  ['Who this is for', 'Offer owners, operators, COOs, finance and revenue operations leaders selling high-ticket products through instalment plans.'],
  ['Enough recovery volume', 'Approximately $10,000 or more becomes failed or overdue in a typical month.'],
  ['A process that needs tightening', 'Payment recovery is split across a processor, CRM, spreadsheets and manual team follow-up.'],
]

const leakExamples = [
  ['Failed instalments', 'A card declines, but nobody can immediately see the reason, next retry or safest action.'],
  ['Overdue payment plans', 'Contracted revenue remains outstanding while follow-up becomes inconsistent or stops entirely.'],
  ['Promises that go quiet', 'A customer says they will pay Friday, but the promised date passes without a tracked response.'],
  ['Unproven recovery work', 'Messages and manual calls happen, but the team cannot attribute which action brought cash back.'],
]

const process = [
  ['1', 'Get a free assessment', 'Review 30–90 days of failed and overdue payments to quantify the recoverable opportunity.'],
  ['2', 'Connect one payment source and CRM', 'Bring each obligation, customer, owner and previous recovery action into one place.'],
  ['3', 'Approve assisted recovery', 'LeakLine recommends and drafts the right message while your team keeps final approval.'],
  ['4', 'Prove what gets collected', 'Track replies, payment promises, follow-ups and provider-confirmed recovered cash.'],
]

type MarketingEvent = 'page_view' | 'apply_click' | 'vsl_click' | 'sample_report_click' | 'client_login_click' | 'application_details_submitted' | 'application_completed'

function trackMarketingEvent(event: MarketingEvent, leadId?: string) {
  void fetch('/api/marketing-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, path: window.location.pathname, leadId }),
    keepalive: true,
  }).catch(() => undefined)
}

async function submitApplication(form: ApplicationForm) {
  const response = await fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(form),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'Could not submit application.')
  return payload as { ok: true; leadId: string }
}

async function submitQualification(leadId: string, form: ApplicationForm) {
  const response = await fetch(`/api/leads/${leadId}/qualify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      website: form.website,
      monthlyOverdueVolume: form.monthlyOverdueVolume,
      monthlyFailedPayments: form.monthlyFailedPayments,
      paymentProvider: form.paymentProvider,
      crm: form.crm,
      currentRecoveryProcess: form.currentRecoveryProcess,
      notes: form.notes,
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'Could not submit qualification answers.')
  return payload as { ok: true }
}

export default function LandingPage() {
  const [form, setForm] = useState<ApplicationForm>(initialForm)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'captured' | 'qualifying' | 'success'>('idle')
  const [leadId, setLeadId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add('is-visible'))
      return
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })

    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const key = `leakline-page-view:${window.location.pathname}`
    if (window.sessionStorage.getItem(key)) return
    window.sessionStorage.setItem(key, '1')
    trackMarketingEvent('page_view')
  }, [])

  const update = (field: keyof ApplicationForm, value: string) => setForm((current) => ({ ...current, [field]: value }))

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setStatus('submitting')
    try {
      const result = await submitApplication(form)
      setLeadId(result.leadId)
      setStatus('captured')
      trackMarketingEvent('application_details_submitted', result.leadId)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit application.')
      setStatus('idle')
    }
  }

  const onQualify = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setStatus('qualifying')
    try {
      await submitQualification(leadId, form)
      setStatus('success')
      setForm(initialForm)
      trackMarketingEvent('application_completed', leadId)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit qualification answers.')
      setStatus('captured')
    }
  }

  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <a href="/" className="landing-logo" aria-label="LeakLine home">
          <img src={logoMark} alt="" />
          <span><strong>LeakLine</strong><small>Turn overdue revenue into collected cash.</small></span>
        </a>
        <div>
          <a href="#how">How it works</a>
          <a href="#offer">Founding pilot</a>
          <a href="#proof">Sample outcome</a>
          <a href="#apply">Free assessment</a>
          <a href="/app" className="landing-login" onClick={() => trackMarketingEvent('client_login_click')}>Client login</a>
        </div>
      </nav>

      <section className="landing-hero">
        <div className="hero-copy">
          <span className="landing-pill"><Target size={15} /> Assisted payment recovery for high-ticket operators</span>
          <h1>Turn failed and overdue instalments into collected cash.</h1>
          <p>LeakLine helps high-ticket operators identify recoverable payment-plan cases, guide the follow-up process and track exactly what gets collected.</p>
          <p className="positioning-line"><strong>Agreed revenue is not collected cash.</strong> LeakLine turns each failed or overdue obligation into an owned, measurable recovery case.</p>
          <div className="hero-actions">
            <a href="#apply" className="primary-cta" onClick={() => trackMarketingEvent('apply_click')}>Get a free recovery assessment <ArrowRight size={17} /></a>
            <a href="#vsl" className="secondary-cta" onClick={() => trackMarketingEvent('vsl_click')}><Play size={16} /> Watch the short VSL</a>
          </div>
          <div className="trust-row">
            <span><CheckCircle2 size={15} /> Your team approves every customer message</span>
            <span><CheckCircle2 size={15} /> Free assessment before any commitment</span>
          </div>
        </div>
        <aside className="hero-dashboard" aria-label="Assisted payment recovery case preview">
          <div className="browser-dots"><i /><i /><i /></div>
          <div className="dashboard-kpi">
            <span>Eligible for recovery</span>
            <strong>$18,700</strong>
            <small>Across 7 failed and overdue instalments</small>
          </div>
          <div className="leak-card critical">
            <span>Payment recovery case · 11 days overdue</span>
            <strong>Expired card requires an update</strong>
            <p>Secure provider link and approved SMS are ready for the account owner.</p>
          </div>
          <div className="mini-grid">
            <div><span>Outstanding</span><strong>$3,200</strong></div>
            <div><span>Status</span><strong>Awaiting approval</strong></div>
          </div>
        </aside>
      </section>

      <section className="problem-section" data-reveal>
        <span className="section-kicker">The collection gap</span>
        <h2>A signed payment plan does not guarantee the cash arrives.</h2>
        <p>Payment processors can retry cards, but high-ticket recovery also depends on customer context, approved outreach, promises, human escalation and consistent follow-up. When those steps live across different tools, contracted revenue quietly becomes a write-off.</p>
        <div className="leak-example-grid">
          {leakExamples.map(([title, body]) => <article key={title}><CircleDollarSign size={19} /><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section id="vsl" className="vsl-section" data-reveal>
        <div>
          <span className="section-kicker">Short VSL</span>
          <h2>See how LeakLine turns overdue payments into recovery work.</h2>
          <p>This video will show how LeakLine detects the right cases, recommends the next action, keeps the operator in control and proves what cash comes back.</p>
        </div>
        <div className="vsl-player">
          <video controls playsInline preload="metadata" aria-label="LeakLine payment recovery overview">
            <source src={vslVideoUrl} type="video/mp4" />
            <track kind="captions" src="/leakline-vsl-en.vtt" srcLang="en" label="English" default />
            Your browser does not support embedded video playback.
          </video>
        </div>
      </section>

      <section id="how" className="how-section" data-reveal>
        <span className="section-kicker">What we do</span>
        <h2>From failed payment to approved action and verified outcome.</h2>
        <div className="process-grid">
          {process.map(([number, title, body]) => <article key={title}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section id="offer" className="founding-offer-section" data-reveal>
        <div className="founding-offer-head">
          <span className="section-kicker">One founding offer</span>
          <h2>Diagnose the opportunity for free. Pay when recovery work begins.</h2>
          <p>No expensive implementation before the numbers make sense. We first establish the eligible balance, current baseline and highest-priority cases.</p>
        </div>
        <div className="founding-offer-grid">
          <article>
            <span>Free</span>
            <h3>Revenue Recovery Assessment</h3>
            <p>A focused review of the previous 30–90 days.</p>
            <ul>
              <li><CheckCircle2 size={15} /> Failed and overdue balance</li>
              <li><CheckCircle2 size={15} /> Existing recovery baseline</li>
              <li><CheckCircle2 size={15} /> Eligible cases and missed promises</li>
              <li><CheckCircle2 size={15} /> Clear recommendation on pilot fit</li>
            </ul>
            <a href="#apply" className="secondary-cta" onClick={() => trackMarketingEvent('apply_click')}>Request the assessment <ArrowRight size={16} /></a>
          </article>
          <article className="featured">
            <span>Founding pilot</span>
            <div className="founding-price"><strong>$499</strong><small>/month</small></div>
            <h3>Assisted Payment Recovery</h3>
            <p>60-day assisted pilot. Setup is currently waived for selected founding partners.</p>
            <ul>
              <li><CheckCircle2 size={15} /> One payment provider and one CRM</li>
              <li><CheckCircle2 size={15} /> Approved SMS and email assistance</li>
              <li><CheckCircle2 size={15} /> Promise and follow-up tracking</li>
              <li><CheckCircle2 size={15} /> Provider-confirmed cash attribution</li>
              <li><CheckCircle2 size={15} /> One short weekly review</li>
            </ul>
            <p className="founding-availability">Limited availability while every founding pilot includes assisted onboarding and weekly review.</p>
            <small className="offer-boundary">Your team approves outreach. LeakLine does not collect card details, represent disputes or operate as a legal debt collector.</small>
          </article>
        </div>
      </section>

      <section id="proof" className="proof-section transformation-section" data-reveal>
        <div className="transformation-head">
          <span className="section-kicker">Sample recovery outcome</span>
          <h2>From scattered payment follow-up to attributable recovered cash.</h2>
          <p>This illustrative example shows the recovery workflow and outcome LeakLine is built to create. The figures below are sample data, not claimed customer results.</p>
        </div>
        <div className="transformation-grid" aria-label="Before and after LeakLine transformation">
          <article className="transformation-card before">
            <span className="transformation-label">Before LeakLine</span>
            <h3>Outstanding cash. No recovery ownership.</h3>
            <div className="transformation-picture before-picture" aria-hidden="true">
              <span className="source-chip crm">CRM</span>
              <span className="source-chip calendar">Promises</span>
              <span className="source-chip payments">Payments</span>
              <span className="source-chip calls">Follow-ups</span>
              <strong>?</strong>
              <i className="leak-dot one" />
              <i className="leak-dot two" />
              <i className="leak-dot three" />
              <em>No clear owner</em>
            </div>
            <p>Failed payments, customer replies and promised dates remain spread across tools while follow-up becomes inconsistent.</p>
          </article>
          <article className="transformation-card after">
            <span className="transformation-label">After LeakLine</span>
            <h3>One assisted recovery inbox.</h3>
            <div className="transformation-picture after-picture" aria-hidden="true">
              <span className="flow-source">Payment provider · CRM · Messages</span>
              <strong>LeakLine</strong>
              <div><span>Eligible now</span><b>$18,700</b></div>
              <div><span>Cash recovered</span><b>$6,450</b></div>
              <div><span>Next action</span><b>3 approvals due</b></div>
            </div>
            <p>Every obligation has a reason, owner, approved next action and verified outcome.</p>
          </article>
        </div>
        <a className="sample-report-link" href="https://drive.google.com/file/d/1cop2kFbIf-rRVoyBXid71nRA4j-CvuTL/view?usp=drivesdk" target="_blank" rel="noreferrer" onClick={() => trackMarketingEvent('sample_report_click')}>View the sample recovery report <ArrowRight size={14} /></a>
      </section>

      <section className="fit-section" data-reveal>
        <span className="section-kicker">Who this is for</span>
        <h2>Built for high-ticket operators with meaningful overdue volume.</h2>
        <div className="fit-grid">
          {fitSignals.map(([title, body], index) => <div key={title} className={index === 0 ? 'who-card' : ''}><ShieldCheck size={18} /><span><strong>{title}</strong>{body}</span></div>)}
        </div>
      </section>

      <section id="apply" className="apply-section" data-reveal>
        <div className="apply-copy">
          <span className="section-kicker">Apply</span>
          <h2>Request a free Revenue Recovery Assessment.</h2>
          <p>We’ll review 30–90 days of failed and overdue payment data, establish what your current process already recovers and show whether there is enough incremental opportunity for a founding pilot.</p>
        </div>
        <form className="application-form" onSubmit={status === 'captured' ? onQualify : onSubmit}>
          {status !== 'captured' && status !== 'qualifying' && status !== 'success' ? <>
            <div className="form-step"><span>Step 1</span><strong>Your details</strong></div>
            <div className="form-grid">
              <label>Name<input required value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="Your name" /></label>
              <label>Email<input required type="email" value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="you@company.com" /></label>
              <label>Phone<input value={form.phone} onChange={(event) => update('phone', event.target.value)} placeholder="+1 555 000 0000" /></label>
              <label>Company<input required value={form.company} onChange={(event) => update('company', event.target.value)} placeholder="Company name" /></label>
              <label>Your role<input value={form.role} onChange={(event) => update('role', event.target.value)} placeholder="Founder, COO, operator, rev ops..." /></label>
            </div>
          </> : status === 'success' ? null : <>
            <div className="form-step success"><span>Step 2</span><strong>Now qualify the recovery opportunity</strong><small>Your details are captured. Answer a few questions so we can judge fit.</small></div>
            <div className="form-grid">
              <label>Website<input value={form.website} onChange={(event) => update('website', event.target.value)} placeholder="https://..." /></label>
              <label>Failed or overdue each month<select required value={form.monthlyOverdueVolume} onChange={(event) => update('monthlyOverdueVolume', event.target.value)}>
                <option value="">Select range</option>
                <option>Under $5k</option>
                <option>$5k–$10k</option>
                <option>$10k–$25k</option>
                <option>$25k–$50k</option>
                <option>$50k+</option>
              </select></label>
              <label>Failed payment cases each month<select required value={form.monthlyFailedPayments} onChange={(event) => update('monthlyFailedPayments', event.target.value)}>
                <option value="">Select range</option>
                <option>Under 5</option>
                <option>5–15</option>
                <option>16–30</option>
                <option>31–75</option>
                <option>75+</option>
              </select></label>
              <label>Payment provider<select required value={form.paymentProvider} onChange={(event) => update('paymentProvider', event.target.value)}><option value="">Select provider</option><option>Stripe</option><option>Whop</option><option>FanBasis</option><option>Multiple providers</option><option>Another provider</option></select></label>
              <label>CRM<input value={form.crm} onChange={(event) => update('crm', event.target.value)} placeholder="GoHighLevel, HubSpot, another CRM..." /></label>
            </div>
            <label>How is payment recovery handled today?<select required value={form.currentRecoveryProcess} onChange={(event) => update('currentRecoveryProcess', event.target.value)}>
              <option value="">Select one</option>
              <option>Payment processor retries only</option>
              <option>Manual CRM tasks and team follow-up</option>
              <option>Spreadsheet or end-of-day tracking</option>
              <option>Dedicated finance or recovery process</option>
              <option>No consistent process</option>
            </select></label>
            <label>Anything else we should know?<textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Briefly describe your instalment plans, recovery process, team or the payment problem you want to solve." /></label>
          </>}
          {error && <div className="landing-error">{error}</div>}
          {status === 'success' && <div className="landing-success"><CheckCircle2 size={17} /> Assessment request received. We will review the fit and follow up.</div>}
          {status !== 'success' && <p className="form-consent">By continuing, you agree to our <a href="/privacy" target="_blank" rel="noreferrer">Privacy Notice</a> and <a href="/terms" target="_blank" rel="noreferrer">Website Terms</a>. We’ll use your details to assess the application and contact you about LeakLine.</p>}
          {status !== 'success' && <button className="primary-cta form-submit" disabled={status === 'submitting' || status === 'qualifying'}>{status === 'submitting' ? 'Saving details…' : status === 'qualifying' ? 'Submitting…' : status === 'captured' ? 'Submit qualification' : 'Continue'} <ArrowRight size={17} /></button>}
        </form>
      </section>

      <footer className="landing-footer" data-reveal>
        <a href="/" className="footer-logo" aria-label="LeakLine home">
          <img src={logoMark} alt="" />
          <span><strong>LeakLine</strong><small>Turn overdue revenue into collected cash.</small></span>
        </a>
        <nav className="landing-footer-links" aria-label="Footer links">
          <a href={contactHref}>Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/app" onClick={() => trackMarketingEvent('client_login_click')}>Client login</a>
        </nav>
      </footer>
    </main>
  )
}
