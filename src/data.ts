import { demoSnapshot, detectLeaks } from './leakEngine'
export type { Leak, LeakSeverity } from './leakEngine'

export type Rep = {
  name: string
  initials: string
  calls: number
  closeRate: number
  collected: number
  retained: number
  trend: number
  color: string
}

export type Period = '7 days' | 'This month' | 'Quarter'

export type Metric = {
  label: string
  value: string
  change?: number
  detail: string
  formula: string
  calculation: string
  explanation: string
  inverse?: boolean
}

export const kpis: Metric[] = [
  { label: 'Net retained', value: '$156,456', change: 8.2, detail: '84% of collected cash', formula: 'Cash collected − refunds − chargebacks − written-off defaults', calculation: '$186,420 − $29,964 = $156,456', explanation: 'Revenue that remains after confirmed reversals and losses.' },
  { label: 'Confirmed lost', value: '$5,250', change: -14.1, detail: '2.8% of collected cash', inverse: true, formula: 'Completed refunds + lost chargebacks + formal write-offs', calculation: '$3,000 + $1,500 + $750 = $5,250', explanation: 'Revenue confirmed as lost—not merely delayed or considered at risk.' },
  { label: 'Revenue at risk', value: '$38,250', change: -8.2, detail: '5 open signals', inverse: true, formula: 'Estimated impact of all unresolved leak alerts', calculation: '$11,750 + $9,800 + $7,200 + $5,500 + $4,000', explanation: 'Revenue that may be lost but could still be protected or recovered.' },
  { label: 'Show rate', value: '72.8%', change: 3.1, detail: '318 of 437 bookings', formula: 'Attended calls ÷ booked calls × 100', calculation: '318 ÷ 437 × 100 = 72.8%', explanation: 'How reliably booked prospects reach a live sales conversation.' },
]

export const funnel = [
  { label: 'Leads', value: 824, rate: 100, color: '#25241f' },
  { label: 'Booked', value: 437, rate: 53, color: '#57564e' },
  { label: 'Attended', value: 318, rate: 73, color: '#77756b' },
  { label: 'Qualified', value: 241, rate: 76, color: '#aa8f5b' },
  { label: 'Closed', value: 67, rate: 28, color: '#1e8c69' },
]

export const leaks = detectLeaks(demoSnapshot)

export const reps: Rep[] = [
  { name: 'Alex Morgan', initials: 'AM', calls: 74, closeRate: 34.2, collected: 61200, retained: 94, trend: 4.8, color: '#4e6f62' },
  { name: 'Sam Rivera', initials: 'SR', calls: 68, closeRate: 30.9, collected: 52400, retained: 91, trend: 1.9, color: '#756248' },
  { name: 'Jordan Lee', initials: 'JL', calls: 71, closeRate: 25.4, collected: 39820, retained: 88, trend: -3.2, color: '#6c625a' },
  { name: 'Priya Shah', initials: 'PS', calls: 57, closeRate: 29.8, collected: 33000, retained: 96, trend: 6.1, color: '#696d4e' },
  { name: 'Theo Grant', initials: 'TG', calls: 48, closeRate: 20.8, collected: 21000, retained: 86, trend: -7.4, color: '#765451' },
]

export const trendByPeriod: Record<Period, { day: string; retained: number; leaked: number; lost: number }[]> = {
  '7 days': [
    { day: 'Mon', retained: 5, leaked: 2.1, lost: .8 }, { day: 'Tue', retained: 7, leaked: 1.7, lost: 1.2 },
    { day: 'Wed', retained: 6, leaked: 2.4, lost: .5 }, { day: 'Thu', retained: 9, leaked: 1.9, lost: 1.4 },
    { day: 'Fri', retained: 8, leaked: 1.5, lost: .7 }, { day: 'Sat', retained: 11, leaked: 1.2, lost: .4 },
  ],
  'This month': [
    { day: '1 Jun', retained: 24, leaked: 9, lost: 4 }, { day: '5 Jun', retained: 31, leaked: 11, lost: 6 },
    { day: '9 Jun', retained: 28, leaked: 7, lost: 5 }, { day: '13 Jun', retained: 39, leaked: 10, lost: 7 },
    { day: '17 Jun', retained: 44, leaked: 8, lost: 6 }, { day: '21 Jun', retained: 51, leaked: 6, lost: 5 },
  ],
  Quarter: [
    { day: '1 Apr', retained: 128, leaked: 24, lost: 18 }, { day: '15 Apr', retained: 146, leaked: 21, lost: 14 },
    { day: '1 May', retained: 139, leaked: 28, lost: 19 }, { day: '15 May', retained: 167, leaked: 20, lost: 12 },
    { day: '1 Jun', retained: 182, leaked: 17, lost: 11 }, { day: '21 Jun', retained: 201, leaked: 14, lost: 9 },
  ],
}

export const periodMetrics: Record<Period, { retained: string; confirmedLost: string; leakage: string; leakageShare: string; showRate: string; showDetail: string; rangeLabel: string }> = {
  '7 days': { retained: '$41,600', confirmedLost: '$2,100', leakage: '$12,400', leakageShare: '25.4%', showRate: '74.1%', showDetail: '83 of 112 bookings', rangeLabel: 'Last 7 days' },
  'This month': { retained: '$156,456', confirmedLost: '$5,250', leakage: '$38,250', leakageShare: '20.5%', showRate: '72.8%', showDetail: '318 of 437 bookings', rangeLabel: '1–21 June' },
  Quarter: { retained: '$474,900', confirmedLost: '$18,400', leakage: '$74,600', leakageShare: '13.6%', showRate: '71.4%', showDetail: '921 of 1,290 bookings', rangeLabel: '1 April–21 June' },
}

export const paymentEvents = [
  { customer: 'Avery Cole', event: 'Refund completed', amount: 3000, date: '20 Jun', status: 'Confirmed lost' },
  { customer: 'Morgan Price', event: 'Chargeback lost', amount: 1500, date: '18 Jun', status: 'Confirmed lost' },
  { customer: 'Riley Ford', event: 'Instalment written off', amount: 750, date: '16 Jun', status: 'Confirmed lost' },
  { customer: 'Casey North', event: 'Payment retry scheduled', amount: 2400, date: '22 Jun', status: 'At risk' },
]

export const sourceHealth = [
  { source: 'Stripe', status: 'Healthy', detail: 'Synced 3 minutes ago', records: '1,284 payments' },
  { source: 'GoHighLevel', status: 'Healthy', detail: 'Synced 8 minutes ago', records: '824 leads' },
  { source: 'Google Calendar', status: 'Healthy', detail: 'Synced 5 minutes ago', records: '437 bookings' },
  { source: 'Call transcripts', status: 'Review', detail: '6 calls unmatched', records: '312 matched' },
]

export const recoveryQueue = [
  { prospect: 'Daniel Woods', value: 12000, reason: 'Partner approval', inactive: 4, owner: 'Alex Morgan', priority: 'High' },
  { prospect: 'Elena Brooks', value: 8500, reason: 'Timing', inactive: 6, owner: 'Sam Rivera', priority: 'High' },
  { prospect: 'Marcus Hall', value: 6000, reason: 'Payment options', inactive: 3, owner: 'Jordan Lee', priority: 'Medium' },
  { prospect: 'Naomi Clarke', value: 5000, reason: 'Reviewing agreement', inactive: 5, owner: 'Priya Shah', priority: 'Medium' },
]
