import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  filterImportedWorkspace,
  filterImportedWorkspaceByDateRange,
  funnelActionCue,
  importedCloserHealth,
  importedDataHealth,
  importedFinancialSummary,
  importedFunnel,
  importedRecoveryQueue,
  importedRevenueTrend,
  importedSearchItems,
  sectionForLeakAction,
} from './App'
import { generateImportLeaks, mergeIntegrationWorkspace, normaliseCsv, type DatasetKind, type ImportWorkspace } from './csvEngine'

const kinds: DatasetKind[] = ['leads', 'appointments', 'deals', 'payments', 'closers']

function sampleWorkspace(): ImportWorkspace {
  return Object.fromEntries(kinds.map((kind) => {
    const path = new URL(`../sample-data/${kind}.csv`, import.meta.url)
    return [kind, normaliseCsv(kind, `${kind}.csv`, readFileSync(path, 'utf8'))]
  })) as ImportWorkspace
}

describe('imported analytics', () => {
  const workspace = sampleWorkspace()

  it('calculates the audited financial KPIs', () => {
    expect(importedFinancialSummary(workspace)).toMatchObject({
      cashCollected: 33500,
      confirmedLost: 5950,
      netRetained: 27550,
      appointments: 18,
      attended: 8,
      showRate: 44,
    })
  })

  it('builds the imported funnel', () => {
    expect(importedFunnel(workspace).map((stage) => stage.value)).toEqual([30, 18, 8, 5, 3])
  })

  it('calculates all imported leak impact', () => {
    const alerts = generateImportLeaks(workspace)
    expect(alerts).toHaveLength(6)
    expect(alerts.reduce((sum, alert) => sum + alert.impact, 0)).toBe(60325)
  })

  it('builds cumulative payment movement', () => {
    const trend = importedRevenueTrend(workspace, 'This month')
    expect(trend.at(-1)).toMatchObject({ retained: 27.55, leaked: 22.5, lost: 5.95 })
  })

  it('joins collected payments to closers', () => {
    const closers = importedCloserHealth(workspace)
    expect(closers.find((closer) => closer.name === 'Alex Morgan')?.collected).toBe(6000)
    expect(closers.find((closer) => closer.name === 'Jordan Lee')?.collected).toBe(6000)
  })

  it('avoids double-counting recovery deals and payments', () => {
    const queue = importedRecoveryQueue(workspace)
    expect(queue).toHaveLength(7)
    expect(queue.reduce((sum, item) => sum + item.value, 0)).toBe(41000)
  })

  it('reports real import health', () => {
    expect(importedDataHealth(workspace)).toHaveLength(5)
    expect(importedDataHealth(workspace).every((source) => source.status === 'Healthy')).toBe(true)
  })

  it('filters dated rows to the selected window', () => {
    const leads = normaliseCsv('leads', 'leads.csv', [
      'lead_id,full_name,created_date',
      'L1,Old Lead,2026-01-01',
      'L2,Recent Lead,2026-01-09',
      'L3,Latest Lead,2026-01-10',
    ].join('\n'))
    expect(filterImportedWorkspace({ leads }, '7 days').leads?.rows).toHaveLength(2)
  })

  it('filters imported records to an exact custom date range', () => {
    const leads = normaliseCsv('leads', 'leads.csv', [
      'lead_id,full_name,created_date',
      'L1,Before Range,2026-01-01',
      'L2,In Range,2026-01-09',
      'L3,Range End,2026-01-10',
      'L4,After Range,2026-01-11',
      'L5,Missing Date,',
    ].join('\n'))
    const filtered = filterImportedWorkspaceByDateRange({ leads }, '2026-01-09', '2026-01-10')
    expect(filtered.leads?.rows.map((row) => row.name)).toEqual(['In Range', 'Range End'])
  })

  it('turns the largest funnel drop into an owned measurement plan', () => {
    expect(funnelActionCue('Leads → booked', 12)).toMatchObject({
      title: 'Tighten the opt-in-to-booking process',
      owner: 'Setter / SDR manager',
    })
    expect(funnelActionCue('Qualified → closed', 5).measure).toContain('Close rate')
  })

  it('routes leak actions to the correct workspace view', () => {
    expect(sectionForLeakAction('View team')).toBe('Team')
    expect(sectionForLeakAction('Review payments')).toBe('Payments')
    expect(sectionForLeakAction('Inspect appointments')).toBe('Funnel')
  })

  it('indexes imported records and alerts for header search', () => {
    const items = importedSearchItems(workspace, generateImportLeaks(workspace))
    expect(items.some((item) => item.label === 'Daniel Woods' && item.section === 'Leak feed')).toBe(true)
    expect(items.some((item) => item.label === 'Daniel Woods - Scale Accelerator' && item.section === 'Recovery')).toBe(true)
    expect(items.some((item) => item.label === 'Alex Morgan' && item.section === 'Team')).toBe(true)
  })

  it('replaces old live datasets while preserving CSV-only datasets', () => {
    const current = sampleWorkspace()
    const livePayments = { ...current.payments!, fileName: 'Stripe live sync', rows: [{ id: 'live', amount: 100 }] }
    const merged = mergeIntegrationWorkspace({ ...current, payments: { ...current.payments!, fileName: 'Old live sync' } }, { payments: livePayments })
    expect(merged.payments?.rows).toEqual([{ id: 'live', amount: 100 }])
    expect(merged.leads?.fileName).toBe('leads.csv')
  })
})
