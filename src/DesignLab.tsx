import { AlertTriangle, ArrowUpRight, BarChart3, Gauge, ShieldCheck, Sparkles } from 'lucide-react'

const MiniChart = ({ modern = false }: { modern?: boolean }) => (
  <div className="mini-chart">
    {[38, 55, 47, 68, 76, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} className={modern ? 'modern-bar' : ''} />)}
  </div>
)

export default function DesignLab() {
  return (
    <section className="design-lab">
      <div className="lab-heading">
        <div><span className="eyebrow"><Sparkles size={14} /> Design comparison</span><h1>Choose the visual direction.</h1><p>Both concepts use the same product logic. The difference is how the product communicates trust, urgency and financial clarity.</p></div>
        <span className="prototype-pill">Version 0 · visual study</span>
      </div>
      <div className="comparison-grid">
        <article className="concept-card original-concept">
          <div className="concept-meta"><div><span>Direction A</span><h2>Warm operational</h2></div><em>Original</em></div>
          <p className="concept-description">Editorial, calm and approachable. Warm neutrals make the product feel considered and less like a conventional CRM.</p>
          <div className="concept-frame original-frame">
            <aside><div className="mini-brand"><Gauge size={13} /> leakline</div>{['Overview', 'Leak feed', 'Funnel', 'Recovery'].map((item, i) => <span className={i === 0 ? 'selected' : ''} key={item}>{item}</span>)}</aside>
            <main>
              <div className="mini-top"><small>Revenue overview</small><b>June 1–21</b></div>
              <h3>Good morning, Maya.</h3><div className="mini-kpis"><div><span>Cash collected</span><strong>$186k</strong><small>↑ 12.4%</small></div><div><span>Revenue at risk</span><strong>$38k</strong><small>20.5% exposed</small></div></div>
              <div className="mini-panels"><section><span>Retained revenue</span><MiniChart /></section><section><span>Priority leaks</span><p><i /><b>12 follow-ups</b><small>$11.7k at risk</small></p><p><i /><b>Campaign no-shows</b><small>$9.8k at risk</small></p></section></div>
            </main>
          </div>
          <div className="concept-traits"><span>Human</span><span>Distinctive</span><span>Calm</span></div>
        </article>

        <article className="concept-card modern-concept">
          <div className="concept-meta"><div><span>Direction B</span><h2>Precision finance</h2></div><em>New</em></div>
          <p className="concept-description">Higher contrast, more analytical and immediately trustworthy. Navy establishes authority while emerald and coral keep outcomes legible.</p>
          <div className="concept-frame modern-frame">
            <aside><div className="mini-brand"><ShieldCheck size={13} /> LEAKLINE</div>{['Command', 'Signals', 'Pipeline', 'Actions'].map((item, i) => <span className={i === 0 ? 'selected' : ''} key={item}>{item}</span>)}</aside>
            <main>
              <div className="modern-welcome"><div><small>REVENUE COMMAND</small><h3>Find the revenue leaks before you scale harder.</h3></div><span>LIVE DATA</span></div>
              <div className="modern-kpis"><div><span>NET RETAINED</span><strong>$156,456</strong><small><ArrowUpRight size={8} /> 8.2%</small></div><div><span>CONFIRMED LOST</span><strong>$5,250</strong><small className="loss">2.8%</small></div><div><span>AT RISK</span><strong>$38,250</strong><small>5 open signals</small></div></div>
              <div className="modern-panels"><section><header><span><BarChart3 size={9} /> Revenue integrity</span><b>$k</b></header><MiniChart modern /></section><section><header><span><AlertTriangle size={9} /> Live signals</span><b>05</b></header><p><i /><b>Follow-up gap</b><small>Critical · $11.7k</small></p><p><i /><b>Show-rate decay</b><small>Critical · $9.8k</small></p></section></div>
            </main>
          </div>
          <div className="concept-traits"><span>Authoritative</span><span>Financial</span><span>Precise</span></div>
        </article>
      </div>
      <div className="recommendation"><ShieldCheck size={18} /><div><strong>My recommendation: Direction B</strong><span>The higher contrast and explicit separation of retained, confirmed lost and at-risk revenue better supports a product asking users to trust financial decisions. Direction A remains friendlier; Direction B feels more commercially credible.</span></div></div>
    </section>
  )
}
