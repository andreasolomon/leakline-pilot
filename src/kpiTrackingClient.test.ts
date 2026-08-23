import { describe, expect, it } from 'vitest'
import { inputFromKpiSnapshot } from './kpiTrackingClient'
import type { KpiSnapshot } from './kpiTracking'

describe('KPI Tracking form payloads', () => {
  it('does not send saved call entries back through the period editor', () => {
    const snapshot: KpiSnapshot = {
      id: 'august',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-21',
      bookedCalls: 53,
      callsTaken: 27,
      deals: 16,
      refunds: 0,
      totalRevenue: 0,
      cashCollected: 0,
      financialsPending: true,
      entries: [{ id: 'call-1', occurredOn: '2026-08-10', personName: 'Example', outcome: 'no_show', revenueValue: 0, cashCollected: 0, createdAt: '2026-08-10T12:00:00.000Z', createdBy: 'Andrea' }],
      source: 'csv',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    }

    expect(inputFromKpiSnapshot(snapshot)).not.toHaveProperty('entries')
    expect(inputFromKpiSnapshot(snapshot)).toMatchObject({ financialsPending: true, bookedCalls: 53 })
  })
})
