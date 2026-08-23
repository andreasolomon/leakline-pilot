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

  it('calculates KPI totals from the row-based onboarding call tracker', () => {
    const preview = parseKpiSheetCsv('Onboarding Call Tracker - August.csv', [
      'August — Onboarding Call Tracker,,,',
      'Date,Name,Outcome of the Call,Notes',
      '01/08/2026,Mark Nesci,Showed Up & Did Not Convert,Followed up',
      '03/08/2026,Rosa Ferlaino,No-Show,No reply',
      '07/08/2026,Lisa Balcer,Rescheduled,Family emergency',
      '21/08/2026,Stephen Mcclain,Showed Up & Started,Started',
    ].join('\n'))

    expect(preview).toMatchObject({ format: 'onboarding_tracker', appointmentRows: 4, issues: [] })
    expect(preview.input).toMatchObject({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-21',
      bookedCalls: 4,
      callsTaken: 2,
      deals: 1,
      financialsPending: true,
    })
  })

  it('blocks unsupported onboarding outcomes instead of silently changing the totals', () => {
    const preview = parseKpiSheetCsv('tracker.csv', [
      'Date,Name,Outcome of the Call,Notes',
      '01/08/2026,Example Client,Maybe later,Unknown status',
    ].join('\n'))

    expect(preview.input).toBeUndefined()
    expect(preview.issues).toContain('Row 2 has an unsupported call outcome.')
  })
})
