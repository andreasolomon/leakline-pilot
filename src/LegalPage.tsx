import { useEffect } from 'react'
import { ArrowLeft, Mail } from 'lucide-react'
import logoMark from './assets/leakline-mark.svg'
import { contactHref, publicContactEmail } from './siteConfig'

type LegalPageProps = { page: 'privacy' | 'terms' }

const privacySections = [
  ['Information we collect', 'When you apply for a Revenue Leak Audit, we collect the details you submit, such as your name, work email, phone number, company, role and information about your sales funnel. We also record basic, non-identifying website events such as page views and application steps so we can understand whether the site is working.'],
  ['How we use it', 'We use this information to assess your application, contact you about LeakLine, prepare or discuss a revenue leak review, operate the website securely and improve the application journey.'],
  ['Storage and sharing', 'Application and conversion data is stored in LeakLine’s secured backend. We do not sell submitted information. Data may be handled by service providers that are necessary to host and operate LeakLine.'],
  ['Retention and choices', 'We keep information only for as long as it is reasonably needed for the purposes described above. You may ask us to correct or delete information you submitted by contacting LeakLine.'],
]

const termsSections = [
  ['Using this website', 'You may use this website to learn about LeakLine, request a Revenue Leak Audit and access the private client software if you have been given an authorised account or invitation.'],
  ['Revenue estimates', 'Revenue-at-risk figures, sample reports and recovery opportunities are estimates based on the data available. They are decision-support information, not a guarantee that any amount will be recovered or that a particular commercial result will be achieved.'],
  ['Your responsibilities', 'Provide accurate information, keep client login credentials secure and do not submit passwords, payment-card details or confidential integration credentials through the public application form.'],
  ['Pilot availability', 'LeakLine is an early-stage product. Features may change as the pilot develops, and access may be limited or suspended to protect client data, maintain the service or address misuse.'],
]

export default function LegalPage({ page }: LegalPageProps) {
  const isPrivacy = page === 'privacy'
  const title = isPrivacy ? 'Privacy notice' : 'Website terms'
  const intro = isPrivacy
    ? 'This notice explains what LeakLine collects through this website and how that information is used.'
    : 'These terms explain the basic conditions for using the public LeakLine website and private pilot access.'
  const sections = isPrivacy ? privacySections : termsSections

  useEffect(() => {
    document.title = `${title} — LeakLine`
    document.querySelector('meta[name="description"]')?.setAttribute('content', intro)
  }, [intro, title])

  return (
    <main className="legal-page">
      <nav className="legal-nav">
        <a href="/" className="landing-logo" aria-label="LeakLine home"><img src={logoMark} alt="" /><span><strong>LeakLine</strong><small>Find the revenue leaks before you scale harder.</small></span></a>
        <a href="/" className="legal-back"><ArrowLeft size={15} /> Back to website</a>
      </nav>
      <article className="legal-document">
        <span className="section-kicker">LeakLine</span>
        <h1>{title}</h1>
        <p className="legal-intro">{intro}</p>
        <p className="legal-updated">Last updated: 13 July 2026</p>
        {sections.map(([heading, body]) => <section key={heading}><h2>{heading}</h2><p>{body}</p></section>)}
        <section id="contact"><h2>Contact</h2><p>{publicContactEmail ? <>For questions or requests, email <a href={contactHref}>{publicContactEmail}</a>.</> : <>For questions or requests, use the <a href="/#apply">LeakLine application form</a> and write “Privacy request” or “General enquiry” in the final notes field.</>}</p></section>
        <a className="legal-contact" href={contactHref}><Mail size={16} /> Contact LeakLine</a>
      </article>
      <footer className="legal-footer"><span>© 2026 LeakLine</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/app">Client login</a></footer>
    </main>
  )
}
