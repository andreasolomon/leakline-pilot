export type KpiCallOutcome = 'full_pay' | 'split_pay' | 'deposit' | 'no_deposit_follow_up' | 'offer_didnt_buy' | 'bad_fit_no_offer' | 'no_show'

export type KpiCallEntry = {
  id: string
  occurredOn: string
  personName: string
  outcome: KpiCallOutcome
  revenueValue: number
  cashCollected: number
  notes?: string
  createdAt: string
  createdBy: string
}

export type KpiSnapshot = {
  id: string
  periodStart: string
  periodEnd: string
  bookedCalls: number
  callsTaken: number
  deals: number
  refunds: number
  totalRevenue: number
  cashCollected: number
  financialsPending?: boolean
  notes?: string
  entries?: KpiCallEntry[]
  source: 'manual' | 'clickup' | 'csv'
  createdAt: string
  updatedAt: string
}

export type KpiSnapshotInput = Omit<KpiSnapshot, 'id' | 'entries' | 'source' | 'createdAt' | 'updatedAt'>

export type KpiCallEntryInput = Pick<KpiCallEntry, 'occurredOn' | 'personName' | 'outcome' | 'revenueValue' | 'cashCollected' | 'notes'>

export const kpiOutcomeLabels: Record<KpiCallOutcome, string> = {
  full_pay: 'Full pay',
  split_pay: 'Split pay',
  deposit: 'Deposit',
  no_deposit_follow_up: 'No deposit — follow up',
  offer_didnt_buy: 'Offered — did not buy',
  bad_fit_no_offer: 'Bad fit — no offer',
  no_show: 'No-show',
}

const dealOutcomes = new Set<KpiCallOutcome>(['full_pay', 'split_pay', 'deposit'])

export function kpiCallEntryImpact(entry: Pick<KpiCallEntry, 'outcome' | 'revenueValue' | 'cashCollected'>) {
  const callsTaken = entry.outcome === 'no_show' ? 0 : 1
  const deals = dealOutcomes.has(entry.outcome) ? 1 : 0
  return { bookedCalls: 1, callsTaken, deals, totalRevenue: entry.revenueValue, cashCollected: entry.cashCollected }
}

export function effectiveKpiSnapshot(snapshot: KpiSnapshot): KpiSnapshot {
  const totals = (snapshot.entries ?? []).reduce((current, entry) => {
    const impact = kpiCallEntryImpact(entry)
    return {
      bookedCalls: current.bookedCalls + impact.bookedCalls,
      callsTaken: current.callsTaken + impact.callsTaken,
      deals: current.deals + impact.deals,
      totalRevenue: current.totalRevenue + impact.totalRevenue,
      cashCollected: current.cashCollected + impact.cashCollected,
    }
  }, {
    bookedCalls: snapshot.bookedCalls,
    callsTaken: snapshot.callsTaken,
    deals: snapshot.deals,
    totalRevenue: snapshot.totalRevenue,
    cashCollected: snapshot.cashCollected,
  })
  return { ...snapshot, ...totals }
}

const divide = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : 0

export function calculateKpis(snapshot: KpiSnapshot) {
  const effective = effectiveKpiSnapshot(snapshot)
  return {
    conversionRate: divide(effective.deals, effective.callsTaken) * 100,
    dealsRefundedRate: divide(effective.refunds, effective.deals) * 100,
    cashPerCallBooked: divide(effective.cashCollected, effective.bookedCalls),
    revenuePerCallBooked: divide(effective.totalRevenue, effective.bookedCalls),
    cashPerCallTaken: divide(effective.cashCollected, effective.callsTaken),
    cashPerDeal: divide(effective.cashCollected, effective.deals),
  }
}

export function sortKpiSnapshots(snapshots: KpiSnapshot[]) {
  return [...snapshots].sort((left, right) => right.periodEnd.localeCompare(left.periodEnd) || right.updatedAt.localeCompare(left.updatedAt))
}

export function compareKpiValue(current: number, previous: number | undefined) {
  if (previous === undefined) return undefined
  if (previous === 0) return current === 0 ? 0 : undefined
  return (current - previous) / Math.abs(previous) * 100
}

export function projectKpiSnapshotToMonthEnd(snapshot: KpiSnapshot, today = new Date()) {
  const effective = effectiveKpiSnapshot(snapshot)
  const [year, month, startDay] = snapshot.periodStart.split('-').map(Number)
  const [endYear, endMonth, endDay] = snapshot.periodEnd.split('-').map(Number)
  if (startDay !== 1 || year !== endYear || month !== endMonth) return undefined
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const todayDate = today.toISOString().slice(0, 10)
  if (snapshot.periodEnd >= `${year}-${String(month).padStart(2, '0')}-${String(totalDays).padStart(2, '0')}` || snapshot.periodEnd > todayDate || endDay < 1) return undefined
  const factor = totalDays / endDay
  const projectCount = (value: number) => Math.round(value * factor)
  const projectMoney = (value: number) => Math.round(value * factor)
  return {
    elapsedDays: endDay,
    totalDays,
    bookedCalls: projectCount(effective.bookedCalls),
    callsTaken: projectCount(effective.callsTaken),
    deals: projectCount(effective.deals),
    refunds: snapshot.financialsPending ? undefined : projectCount(effective.refunds),
    totalRevenue: snapshot.financialsPending ? undefined : projectMoney(effective.totalRevenue),
    cashCollected: snapshot.financialsPending ? undefined : projectMoney(effective.cashCollected),
  }
}
