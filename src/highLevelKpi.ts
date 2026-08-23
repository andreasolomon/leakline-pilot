export type HighLevelKpiOutcome = 'appointment_booked' | 'no_show' | 'rescheduled' | 'showed_started' | 'showed_not_converted'

export const highLevelKpiOutcomeLabels: Record<HighLevelKpiOutcome, string> = {
  appointment_booked: 'Appointment booked',
  no_show: 'No-show',
  rescheduled: 'Rescheduled',
  showed_started: 'Showed up and converted',
  showed_not_converted: 'Showed and did not convert',
}

export type HighLevelKpiData = {
  connected: boolean
  lastSyncAt?: string
  settings: {
    pipelineId?: string
    stageMappings: Record<string, HighLevelKpiOutcome>
    updatedAt?: string
    updatedBy?: string
  }
  stages: Array<{
    pipelineId: string
    pipelineName: string
    stageId: string
    stageName: string
  }>
  range: {
    period: 'all' | 'week' | 'month' | 'custom'
    startDate?: string
    endDate?: string
    timeZone: string
  }
  projection?: {
    elapsedDays: number
    totalDays: number
    appointments: number
    showed: number
    started: number
    convertedRevenue: number
  }
  summary: {
    appointments: number
    noShows: number
    rescheduled: number
    showed: number
    started: number
    didNotConvert: number
    convertedRevenue: number
    showRate: number
    conversionFromAppointments: number
    conversionFromShows: number
    trackedOpportunities: number
    mappedOpportunities: number
    unmappedOpportunities: number
    mappedStages: number
    availableStages: number
    trackedSince?: string
  }
  opportunities: Array<{
    opportunityId: string
    contactId: string
    personName: string
    owner: string
    pipelineId: string
    stageId: string
    stageName: string
    status: string
    value: number
    enteredAt?: string
    changedAt: string
    firstSeenAt: string
    lastSeenAt: string
    outcome: HighLevelKpiOutcome | null
    outcomeLabel: string
  }>
}

export const emptyHighLevelKpiData = (): HighLevelKpiData => ({
  connected: false,
  settings: { stageMappings: {} },
  stages: [],
  range: { period: 'month', timeZone: 'UTC' },
  summary: {
    appointments: 0,
    noShows: 0,
    rescheduled: 0,
    showed: 0,
    started: 0,
    didNotConvert: 0,
    convertedRevenue: 0,
    showRate: 0,
    conversionFromAppointments: 0,
    conversionFromShows: 0,
    trackedOpportunities: 0,
    mappedOpportunities: 0,
    unmappedOpportunities: 0,
    mappedStages: 0,
    availableStages: 0,
  },
  opportunities: [],
})
