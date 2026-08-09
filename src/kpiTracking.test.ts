import { describe, expect, it } from 'vitest'
import { calculateKpis, compareKpiValue, effectiveKpiSnapshot, kpiCallEntryImpact, sortKpiSnapshots, type KpiSnapshot } from './kpiTracking'

const snapshot = (overrides: Partial<KpiSnapshot> = {}): KpiSnapshot => ({
  id: 'kpi-1',
  periodStart: '2026-07-01',
  periodEnd: '2026-07-07',
  bookedCalls: 20,
  callsTaken: 15,
  deals: 5,
  refunds: 1,
  totalRevenue: 25_000,
  cashCollected: 15_000,
  source: 'manual',
  createdAt: '2026-07-08T00:00:00.000Z',
  updatedAt: '2026-07-08T00:00:00.000Z',
  ...overrides,
})

describe('KPI Tracking calculations', () => {
  it('calculates every gross-total ratio from the six saved inputs', () => {
    expect(calculateKpis(snapshot())).toEqual({
      conversionRate: 33.33333333333333,
      dealsRefundedRate: 20,
      cashPerCallBooked: 750,
      revenuePerCallBooked: 1250,
      cashPerCallTaken: 1000,
      cashPerDeal: 3000,
    })
  })

  it('returns zero instead of invalid values when a denominator is zero', () => {
    expect(calculateKpis(snapshot({ bookedCalls: 0, callsTaken: 0, deals: 0 }))).toEqual({
      conversionRate: 0,
      dealsRefundedRate: 0,
      cashPerCallBooked: 0,
      revenuePerCallBooked: 0,
      cashPerCallTaken: 0,
      cashPerDeal: 0,
    })
  })

  it('adds individual call results to the imported or manual baseline', () => {
    const withEntries = snapshot({ entries: [
      { id: 'entry-1', occurredOn: '2026-07-07', personName: 'Alex Carter', outcome: 'split_pay', revenueValue: 8_000, cashCollected: 2_000, createdAt: '2026-07-07T12:00:00.000Z', createdBy: 'Yonas' },
      { id: 'entry-2', occurredOn: '2026-07-07', personName: 'Jamie Lee', outcome: 'no_show', revenueValue: 0, cashCollected: 0, createdAt: '2026-07-07T13:00:00.000Z', createdBy: 'Yonas' },
    ] })

    expect(effectiveKpiSnapshot(withEntries)).toMatchObject({ bookedCalls: 22, callsTaken: 16, deals: 6, totalRevenue: 33_000, cashCollected: 17_000 })
    expect(calculateKpis(withEntries).cashPerDeal).toBeCloseTo(17_000 / 6)
  })

  it('uses explicit outcome rules when counting calls and deals', () => {
    expect(kpiCallEntryImpact({ outcome: 'full_pay', revenueValue: 5_000, cashCollected: 5_000 })).toEqual({ bookedCalls: 1, callsTaken: 1, deals: 1, totalRevenue: 5_000, cashCollected: 5_000 })
    expect(kpiCallEntryImpact({ outcome: 'offer_didnt_buy', revenueValue: 0, cashCollected: 0 })).toEqual({ bookedCalls: 1, callsTaken: 1, deals: 0, totalRevenue: 0, cashCollected: 0 })
    expect(kpiCallEntryImpact({ outcome: 'no_show', revenueValue: 0, cashCollected: 0 })).toEqual({ bookedCalls: 1, callsTaken: 0, deals: 0, totalRevenue: 0, cashCollected: 0 })
  })

  it('sorts the most recent reporting period first', () => {
    const older = snapshot({ id: 'older', periodEnd: '2026-07-07' })
    const newer = snapshot({ id: 'newer', periodStart: '2026-07-08', periodEnd: '2026-07-14' })
    expect(sortKpiSnapshots([older, newer]).map((item) => item.id)).toEqual(['newer', 'older'])
  })

  it('compares values without claiming an infinite increase from zero', () => {
    expect(compareKpiValue(120, 100)).toBe(20)
    expect(compareKpiValue(0, 0)).toBe(0)
    expect(compareKpiValue(10, 0)).toBeUndefined()
    expect(compareKpiValue(10, undefined)).toBeUndefined()
  })
})
