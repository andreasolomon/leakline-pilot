import { FormEvent, useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, CircleDollarSign, Play, ShieldCheck, Target } from 'lucide-react'
import logoMark from './assets/leakline-mark.svg'
import { contactHref } from './siteConfig'

type ApplicationForm = {
  name: string
  email: string
  phone: string
  company: string
  website: string
  role: string
  monthlyBookedCalls: string
  offerPrice: string
  crm: string
  suspectedLeak: string
  notes: string
}

const initialForm: ApplicationForm = {
  name: '',
  email: '',
  phone: '',
  company: '',
  website: '',
  role: '',
  monthlyBookedCalls: '',
  offerPrice: '',
  crm: '',
  suspectedLeak: '',
  notes: '',
}

const fitSignals = [
  ['Who this is for', 'Offer owners, operators, COOs, revenue operations and growth leaders running high-ticket funnels across coaching, consulting, info products, agencies, SaaS, services or education.'],
  ['Active funnel', 'Calls, applications or demos are already being booked every week.'],
  ['Revenue is slipping', 'You suspect money is being lost through booking, follow-up, payments, refunds, disputes or cross-team handoffs.'],
]

const leakExamples = [
  ['Opt-ins not booking', 'High-intent leads apply or opt in, then never reach the calendar.'],
  ['Booked calls not showing', 'Calendar volume looks fine, but attendance quietly drags revenue down.'],
  ['Qualified deals going stale', 'Prospects receive proposals or next steps, then sit unworked across departments.'],
  ['Payments, refunds and disputes', 'Declines, overdue plans, chargebacks and refunds hide outside the main operating view.'],
]

const process = [
  ['1', 'Connect or export data', 'Start from CRM, calendar, payments, calls or simple CSV exports.'],
  ['2', 'Detect the leaks', 'LeakLine identifies the affected records, estimates impact and explains why each leak was detected.'],
  ['3', 'Open a recovery case', 'Assign a named owner, deadline and measurable action plan to the highest-value fixes.'],
  ['4', 'Track what gets recovered', 'Follow every case through to resolution and record the revenue brought back into the business.'],
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
      monthlyBookedCalls: form.monthlyBookedCalls,
      offerPrice: form.offerPrice,
      crm: form.crm,
      suspectedLeak: form.suspectedLeak,
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
          <span><strong>LeakLine</strong><small>Find the revenue leaks before you scale harder.</small></span>
        </a>
        <div>
          <a href="#how">How it works</a>
          <a href="#proof">Proof</a>
          <a href="#apply">Apply</a>
          <a href="/app" className="landing-login" onClick={() => trackMarketingEvent('client_login_click')}>Client login</a>
        </div>
      </nav>

      <section className="landing-hero">
        <div className="hero-copy">
          <span className="landing-pill"><Target size={15} /> Revenue leak audits for high-ticket offer operators</span>
          <h1>Find the revenue leaks before you scale harder.</h1>
          <p>LeakLine is a revenue leak detection and recovery system for high-ticket operators. It identifies the records putting revenue at risk, tells the team what to fix, assigns the recovery work and tracks what gets recovered.</p>
          <p className="positioning-line"><strong>Your dashboards report what happened.</strong> LeakLine identifies what is leaking and creates the recovery action.</p>
          <div className="hero-actions">
            <a href="#apply" className="primary-cta" onClick={() => trackMarketingEvent('apply_click')}>Apply for a leak audit <ArrowRight size={17} /></a>
            <a href="#vsl" className="secondary-cta" onClick={() => trackMarketingEvent('vsl_click')}><Play size={16} /> Watch the short VSL</a>
          </div>
          <div className="trust-row">
            <span><CheckCircle2 size={15} /> Starts from exports or direct connections</span>
            <span><CheckCircle2 size={15} /> Built for offer owners and revenue operators</span>
          </div>
        </div>
        <aside className="hero-dashboard" aria-label="Revenue leak detection and recovery case preview">
          <div className="browser-dots"><i /><i /><i /></div>
          <div className="dashboard-kpi">
            <span>Revenue at risk</span>
            <strong>$38,250</strong>
            <small>Estimated across open leak signals</small>
          </div>
          <div className="leak-card critical">
            <span>Recovery case · 11 records</span>
            <strong>Opted-in leads have not booked</strong>
            <p>Three-touch booking recovery sequence assigned for the next 48 hours.</p>
          </div>
          <div className="mini-grid">
            <div><span>Owner</span><strong>Setter team</strong></div>
            <div><span>Status</span><strong>In progress</strong></div>
          </div>
        </aside>
      </section>

      <section className="problem-section" data-reveal>
        <span className="section-kicker">The scaling trap</span>
        <h2>Most teams try to fix revenue by adding more volume.</h2>
        <p>More leads. More calls. More setters. More closers. More ad spend. But if revenue is already leaking between opt-in, booking, show, close, payment, refund, dispute and follow-up, scaling harder can just scale the leak.</p>
        <div className="leak-example-grid">
          {leakExamples.map(([title, body]) => <article key={title}><CircleDollarSign size={19} /><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section id="vsl" className="vsl-section" data-reveal>
        <div>
          <span className="section-kicker">Short VSL</span>
          <h2>See how LeakLine thinks about revenue recovery.</h2>
          <p>This video will explain why LeakLine exists, what data it reviews, and how the audit turns messy funnel data into a recovery priority list.</p>
        </div>
        <div className="vsl-player">
          <Play size={34} />
          <strong>VSL placeholder</strong>
          <span>Add Loom, YouTube or hosted video embed here.</span>
        </div>
      </section>

      <section id="how" className="how-section" data-reveal>
        <span className="section-kicker">What we do</span>
        <h2>LeakLine turns revenue operations data into owned recovery cases.</h2>
        <div className="process-grid">
          {process.map(([number, title, body]) => <article key={title}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section id="proof" className="proof-section transformation-section" data-reveal>
        <div className="transformation-head">
          <span className="section-kicker">Who we have helped</span>
          <h2>From scattered funnel data to clear recovery priorities.</h2>
          <p>This sample transformation shows the result LeakLine is built to create. Real client stories and testimonials will replace it as pilot results are approved.</p>
        </div>
        <div className="transformation-grid" aria-label="Before and after LeakLine transformation">
          <article className="transformation-card before">
            <span className="transformation-label">Before LeakLine</span>
            <h3>More volume. Less visibility.</h3>
            <div className="transformation-picture before-picture" aria-hidden="true">
              <span className="source-chip crm">CRM</span>
              <span className="source-chip calendar">Calendar</span>
              <span className="source-chip payments">Payments</span>
              <span className="source-chip calls">Calls</span>
              <strong>?</strong>
              <i className="leak-dot one" />
              <i className="leak-dot two" />
              <i className="leak-dot three" />
              <em>No clear owner</em>
            </div>
            <p>Leaks remain spread across tools and teams while the business keeps adding leads, calls and ad spend.</p>
          </article>
          <article className="transformation-card after">
            <span className="transformation-label">After LeakLine</span>
            <h3>One prioritised recovery view.</h3>
            <div className="transformation-picture after-picture" aria-hidden="true">
              <span className="flow-source">CRM · Calendar · Payments · Calls</span>
              <strong>LeakLine</strong>
              <div><span>Revenue at risk</span><b>$38,250</b></div>
              <div><span>Priority</span><b>Payment recovery</b></div>
              <div><span>Owner</span><b>Revenue operations</b></div>
            </div>
            <p>The largest leaks are ranked with evidence, estimated impact, an owner and the next recovery action.</p>
          </article>
        </div>
        <a className="sample-report-link" href="https://drive.google.com/file/d/1cop2kFbIf-rRVoyBXid71nRA4j-CvuTL/view?usp=drivesdk" target="_blank" rel="noreferrer" onClick={() => trackMarketingEvent('sample_report_click')}>View the sample recovery report <ArrowRight size={14} /></a>
      </section>

      <section className="fit-section" data-reveal>
        <span className="section-kicker">Who this is for</span>
        <h2>Built for offer owners and operators with real funnel activity.</h2>
        <div className="fit-grid">
          {fitSignals.map(([title, body], index) => <div key={title} className={index === 0 ? 'who-card' : ''}><ShieldCheck size={18} /><span><strong>{title}</strong>{body}</span></div>)}
        </div>
      </section>

      <section id="apply" className="apply-section" data-reveal>
        <div className="apply-copy">
          <span className="section-kicker">Apply</span>
          <h2>Apply for a Revenue Leak Audit.</h2>
          <p>Tell us about your funnel. If there is a fit, we’ll review a sample of your data, identify the biggest revenue leaks affecting the business right now, and show you what to recover first.</p>
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
            <div className="form-step success"><span>Step 2</span><strong>Now qualify the funnel</strong><small>Your details are captured. Answer a few questions so we can judge fit.</small></div>
            <div className="form-grid">
              <label>Website<input value={form.website} onChange={(event) => update('website', event.target.value)} placeholder="https://..." /></label>
              <label>Monthly booked calls<select required value={form.monthlyBookedCalls} onChange={(event) => update('monthlyBookedCalls', event.target.value)}>
                <option value="">Select range</option>
                <option>Under 25</option>
                <option>25–75</option>
                <option>75–150</option>
                <option>150+</option>
              </select></label>
              <label>Average offer price<select required value={form.offerPrice} onChange={(event) => update('offerPrice', event.target.value)}>
                <option value="">Select range</option>
                <option>Under $2k</option>
                <option>$2k–$5k</option>
                <option>$5k–$15k</option>
                <option>$15k+</option>
              </select></label>
              <label>CRM/payment stack<input value={form.crm} onChange={(event) => update('crm', event.target.value)} placeholder="GoHighLevel, HubSpot, Stripe..." /></label>
            </div>
            <label>Biggest suspected leak<select required value={form.suspectedLeak} onChange={(event) => update('suspectedLeak', event.target.value)}>
              <option value="">Select one</option>
              <option>Leads opt in but do not book</option>
              <option>Booked calls do not show</option>
              <option>Qualified prospects do not close</option>
              <option>Failed payments or overdue plans</option>
              <option>Refunds or retained revenue issues</option>
              <option>Not sure yet</option>
            </select></label>
            <label>Anything else we should know?<textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Briefly describe your funnel, team, offer, or where you think money is leaking." /></label>
          </>}
          {error && <div className="landing-error">{error}</div>}
          {status === 'success' && <div className="landing-success"><CheckCircle2 size={17} /> Application received. We will review the fit and follow up.</div>}
          {status !== 'success' && <p className="form-consent">By continuing, you agree to our <a href="/privacy" target="_blank" rel="noreferrer">Privacy Notice</a> and <a href="/terms" target="_blank" rel="noreferrer">Website Terms</a>. We’ll use your details to assess the application and contact you about LeakLine.</p>}
          {status !== 'success' && <button className="primary-cta form-submit" disabled={status === 'submitting' || status === 'qualifying'}>{status === 'submitting' ? 'Saving details…' : status === 'qualifying' ? 'Submitting…' : status === 'captured' ? 'Submit qualification' : 'Continue'} <ArrowRight size={17} /></button>}
        </form>
      </section>

      <footer className="landing-footer" data-reveal>
        <a href="/" className="footer-logo" aria-label="LeakLine home">
          <img src={logoMark} alt="" />
          <span><strong>LeakLine</strong><small>Find the revenue leaks before you scale harder.</small></span>
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
