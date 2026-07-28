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
  notes?: string
  source: 'manual' | 'clickup'
  createdAt: string
  updatedAt: string
}

export type KpiSnapshotInput = Omit<KpiSnapshot, 'id' | 'source' | 'createdAt' | 'updatedAt'>

const divide = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : 0

export function calculateKpis(snapshot: KpiSnapshot) {
  return {
    conversionRate: divide(snapshot.deals, snapshot.callsTaken) * 100,
    dealsRefundedRate: divide(snapshot.refunds, snapshot.deals) * 100,
    cashPerCallBooked: divide(snapshot.cashCollected, snapshot.bookedCalls),
    revenuePerCallBooked: divide(snapshot.totalRevenue, snapshot.bookedCalls),
    cashPerCallTaken: divide(snapshot.cashCollected, snapshot.callsTaken),
    cashPerDeal: divide(snapshot.cashCollected, snapshot.deals),
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
