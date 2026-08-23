import type { KpiSnapshot, KpiSnapshotInput } from './kpiTracking'

export async function kpiApi<T>(path = '/api/kpi-snapshots', init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`)
  return body
}

export const emptyKpiSnapshot = (): KpiSnapshotInput => {
  const today = new Date().toISOString().slice(0, 10)
  return {
    periodStart: today,
    periodEnd: today,
    bookedCalls: 0,
    callsTaken: 0,
    deals: 0,
    refunds: 0,
    totalRevenue: 0,
    cashCollected: 0,
    financialsPending: false,
    notes: '',
  }
}

export function inputFromKpiSnapshot(snapshot: KpiSnapshot): KpiSnapshotInput {
  return {
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    bookedCalls: snapshot.bookedCalls,
    callsTaken: snapshot.callsTaken,
    deals: snapshot.deals,
    refunds: snapshot.refunds,
    totalRevenue: snapshot.totalRevenue,
    cashCollected: snapshot.cashCollected,
    financialsPending: snapshot.financialsPending,
    notes: snapshot.notes,
  }
}
