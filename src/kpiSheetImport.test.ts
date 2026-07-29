import { describe, expect, it } from 'vitest'
import { parseKpiSheetCsv } from './kpiSheetImport'

describe('KPI sheet CSV import', () => {
  it('prioritises the Gross Totals section in the Launch Webinars matrix export', () => {
    const preview = parseKpiSheetCsv('dashboard.csv', [
      'Cold Traffic,,Call Outcomes,,Gross Totals,',
      'Scheduled:,20,Full-Pay:,3,Booked Calls:,18',
      'Calls Taken:,12,Split-Pay:,2,Calls Taken:,14',
      'No-Shows:,8,Deposits:,1,Deals:,6',
      'Cancellations:,2,No Deposit & FU:,1,Refunds:,1',
      'Reschedules:,3,Offer & Did Not Buy:,2,Total Revenue:,"$48,000"',
      ',,Bad Fit & No Offer:,1,Cash Collected:,"$31,500"',
    ].join('\n'), new Date('2026-07-29T12:00:00.000Z'))

    expect(preview.issues).toEqual([])
    expect(preview.input).toMatchObject({
      periodStart: '2026-07-29',
      periodEnd: '2026-07-29',
      bookedCalls: 18,
      callsTaken: 14,
      deals: 6,
      refunds: 1,
      totalRevenue: 48_000,
      cashCollected: 31_500,
    })
  })

  it('reports missing source totals instead of silently importing zeros', () => {
    const preview = parseKpiSheetCsv('incomplete.csv', 'Gross Totals,\nBooked Calls:,10\nCalls Taken:,8')
    expect(preview.input).toBeUndefined()
    expect(preview.issues).toContain('Deals was missing or was not a valid non-negative number.')
  })
})
