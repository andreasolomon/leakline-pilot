import { describe, expect, it } from 'vitest'
import { reconcileHighLevelKpi, summarizeHighLevelKpis, type HighLevelKpiSyncData } from './highLevelKpi.js'
import { defaultPilotValidation, defaultRecoveryPolicy } from './store.js'
import type { HighLevelKpiOutcome, WorkspaceRecord } from './types.js'

function workspace(): WorkspaceRecord {
  return {
    id: 'workspace-launch-webinars',
    name: 'Launch Webinars',
    clientName: 'Launch Webinars',
    createdAt: '2026-08-01T00:00:00.000Z',
    credentials: {},
    connections: { highlevel: { connectedAt: '2026-08-01T00:00:00.000Z', accountLabel: 'Launch Webinars GHL' } },
    oauthConfig: {},
    workspace: {},
    imports: {},
    calls: [],
    oauthStates: {},
    recoveryCases: [],
    paymentRecoveryCases: [],
    recoveryPolicy: defaultRecoveryPolicy('Launch Webinars'),
    pilotValidation: defaultPilotValidation(),
    renewalClients: [],
    kpiSnapshots: [],
    highLevelKpi: { settings: { stageMappings: {} }, stages: [], opportunities: [], stageEvents: [] },
  }
}

const stages = [
  { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'booked', stageName: 'Booked appointment' },
  { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'no-show', stageName: 'No-show' },
  { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'rescheduled', stageName: 'Rescheduled' },
  { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'started', stageName: 'Started' },
  { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'not-converted', stageName: 'Did not convert' },
]

function opportunity(opportunityId: string, stageId: string, changedAt: string) {
  return {
    opportunityId,
    contactId: `contact-${opportunityId}`,
    personName: `Person ${opportunityId}`,
    owner: 'Yonas',
    pipelineId: 'sales',
    stageId,
    stageName: stages.find((stage) => stage.stageId === stageId)?.stageName ?? stageId,
    status: 'open',
    value: 5_000,
    changedAt,
  }
}

describe('GoHighLevel KPI tracking', () => {
  it('uses the same connection definition as Data Sources', () => {
    const target = workspace()
    delete target.connections.highlevel
    target.credentials.highlevel = { accessToken: 'saved-private-integration-token', locationId: 'location-one' }
    expect(summarizeHighLevelKpis(target).connected).toBe(true)

    delete target.credentials.highlevel
    target.connections.highlevel = { connectedAt: '2026-08-01T00:00:00.000Z', accountLabel: 'Legacy metadata', mode: 'live' }
    expect(summarizeHighLevelKpis(target).connected).toBe(false)

    target.connections.highlevel.mode = 'sandbox'
    expect(summarizeHighLevelKpis(target).connected).toBe(true)
  })

  it('does not duplicate stage history when the same sync is replayed', () => {
    const target = workspace()
    const sync: HighLevelKpiSyncData = { stages, opportunities: [opportunity('one', 'booked', '2026-08-20T10:00:00.000Z')] }

    expect(reconcileHighLevelKpi(target, sync, '2026-08-20T10:01:00.000Z')).toMatchObject({ created: 1, changed: 0, eventCount: 1 })
    expect(reconcileHighLevelKpi(target, sync, '2026-08-20T10:02:00.000Z')).toMatchObject({ created: 0, changed: 0, unchanged: 1, eventCount: 1 })
    expect(target.highLevelKpi.opportunities).toHaveLength(1)
    expect(target.highLevelKpi.stageEvents).toHaveLength(1)
  })

  it('records a real stage movement and recalculates the mapped outcomes', () => {
    const target = workspace()
    target.highLevelKpi.settings = {
      pipelineId: 'sales',
      stageMappings: {
        booked: 'appointment_booked',
        'no-show': 'no_show',
        rescheduled: 'rescheduled',
        started: 'showed_started',
        'not-converted': 'showed_not_converted',
      } satisfies Record<string, HighLevelKpiOutcome>,
    }

    reconcileHighLevelKpi(target, { stages, opportunities: [
      opportunity('one', 'booked', '2026-08-20T10:00:00.000Z'),
      opportunity('two', 'no-show', '2026-08-20T10:05:00.000Z'),
      opportunity('three', 'rescheduled', '2026-08-20T10:10:00.000Z'),
      opportunity('four', 'not-converted', '2026-08-20T10:15:00.000Z'),
    ] }, '2026-08-20T10:20:00.000Z')

    reconcileHighLevelKpi(target, { stages, opportunities: [
      opportunity('one', 'started', '2026-08-21T10:00:00.000Z'),
      opportunity('two', 'no-show', '2026-08-20T10:05:00.000Z'),
      opportunity('three', 'rescheduled', '2026-08-20T10:10:00.000Z'),
      opportunity('four', 'not-converted', '2026-08-20T10:15:00.000Z'),
    ] }, '2026-08-21T10:01:00.000Z')

    const result = summarizeHighLevelKpis(target)
    expect(target.highLevelKpi.stageEvents).toHaveLength(5)
    expect(result.summary).toMatchObject({
      appointments: 4,
      noShows: 1,
      rescheduled: 1,
      showed: 2,
      started: 1,
      didNotConvert: 1,
      showRate: 50,
      conversionFromAppointments: 25,
      conversionFromShows: 50,
    })
  })

  it('keeps opportunities from other pipelines out of the selected totals', () => {
    const target = workspace()
    target.highLevelKpi.settings = { pipelineId: 'sales', stageMappings: { booked: 'appointment_booked' } }
    reconcileHighLevelKpi(target, {
      stages,
      opportunities: [opportunity('sales-one', 'booked', '2026-08-20T10:00:00.000Z'), { ...opportunity('support-one', 'booked', '2026-08-20T10:00:00.000Z'), pipelineId: 'support' }],
    })

    expect(summarizeHighLevelKpis(target).summary.appointments).toBe(1)
  })

  it('tracks the four-stage Launch Webinars appointment lifecycle', () => {
    const target = workspace()
    const launchStages = [
      { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'booked', stageName: 'Booked call' },
      { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'no-show', stageName: 'No-show' },
      { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'converted', stageName: 'Showed up & did convert' },
      { pipelineId: 'sales', pipelineName: 'Sales pipeline', stageId: 'not-converted', stageName: 'Showed up & did not convert' },
    ]
    target.highLevelKpi.settings = {
      pipelineId: 'sales',
      stageMappings: {
        booked: 'appointment_booked',
        'no-show': 'no_show',
        converted: 'showed_started',
        'not-converted': 'showed_not_converted',
      },
    }

    reconcileHighLevelKpi(target, {
      stages: launchStages,
      opportunities: ['one', 'two', 'three'].map((id) => opportunity(id, 'booked', '2026-08-20T10:00:00.000Z')),
    }, '2026-08-20T10:01:00.000Z')

    reconcileHighLevelKpi(target, {
      stages: launchStages,
      opportunities: [
        { ...opportunity('one', 'no-show', '2026-08-21T10:00:00.000Z'), stageName: 'No-show' },
        { ...opportunity('two', 'converted', '2026-08-21T10:05:00.000Z'), stageName: 'Showed up & did convert' },
        { ...opportunity('three', 'not-converted', '2026-08-21T10:10:00.000Z'), stageName: 'Showed up & did not convert' },
      ],
    }, '2026-08-21T10:11:00.000Z')

    const summary = summarizeHighLevelKpis(target).summary
    expect(summary).toMatchObject({
      appointments: 3,
      noShows: 1,
      rescheduled: 0,
      showed: 2,
      started: 1,
      didNotConvert: 1,
      conversionFromShows: 50,
    })
    expect(summary.showRate).toBeCloseTo(66.67, 2)
    expect(summary.conversionFromAppointments).toBeCloseTo(33.33, 2)
  })

  it('filters GHL movements by week, month and custom dates and projects an active period', () => {
    const target = workspace()
    target.recoveryPolicy.timezone = 'America/New_York'
    target.highLevelKpi.settings = { pipelineId: 'sales', stageMappings: { booked: 'appointment_booked', started: 'showed_started' } }
    reconcileHighLevelKpi(target, { stages, opportunities: [
      { ...opportunity('july', 'booked', '2026-07-30T14:00:00.000Z'), enteredAt: '2026-07-30T14:00:00.000Z' },
      { ...opportunity('august', 'booked', '2026-08-10T14:00:00.000Z'), enteredAt: '2026-08-10T14:00:00.000Z' },
      { ...opportunity('current-week', 'booked', '2026-08-20T14:00:00.000Z'), enteredAt: '2026-08-20T14:00:00.000Z' },
    ] }, '2026-08-20T14:01:00.000Z')
    reconcileHighLevelKpi(target, { stages, opportunities: [
      { ...opportunity('july', 'started', '2026-07-31T14:00:00.000Z'), enteredAt: '2026-07-30T14:00:00.000Z' },
      { ...opportunity('august', 'started', '2026-08-11T14:00:00.000Z'), enteredAt: '2026-08-10T14:00:00.000Z' },
      { ...opportunity('current-week', 'started', '2026-08-21T14:00:00.000Z'), enteredAt: '2026-08-20T14:00:00.000Z' },
    ] }, '2026-08-21T14:01:00.000Z')

    const now = new Date('2026-08-23T12:00:00.000Z')
    const month = summarizeHighLevelKpis(target, { period: 'month', now })
    expect(month.range).toMatchObject({ startDate: '2026-08-01', endDate: '2026-08-31' })
    expect(month.summary).toMatchObject({ appointments: 2, showed: 2, started: 2, convertedRevenue: 10_000 })
    expect(month.projection).toMatchObject({ elapsedDays: 23, totalDays: 31, appointments: 3, showed: 3, started: 3, convertedRevenue: 13_478 })
    expect(summarizeHighLevelKpis(target, { period: 'week', now }).summary.appointments).toBe(1)
    expect(summarizeHighLevelKpis(target, { period: 'custom', startDate: '2026-07-01', endDate: '2026-07-31', now }).summary.appointments).toBe(1)
  })
})
