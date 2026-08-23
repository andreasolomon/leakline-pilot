import type {
  HighLevelKpiOutcome,
  HighLevelOpportunitySyncRecord,
  HighLevelPipelineStageRecord,
  WorkspaceRecord,
} from './types.js'

export const highLevelKpiOutcomeLabels: Record<HighLevelKpiOutcome, string> = {
  appointment_booked: 'Appointment booked',
  no_show: 'No-show',
  rescheduled: 'Rescheduled',
  showed_started: 'Showed up and converted',
  showed_not_converted: 'Showed and did not convert',
}

export type HighLevelKpiSyncData = {
  stages: HighLevelPipelineStageRecord[]
  opportunities: HighLevelOpportunitySyncRecord[]
}

export type HighLevelKpiReportOptions = {
  period?: 'all' | 'week' | 'month' | 'custom'
  startDate?: string
  endDate?: string
  now?: Date
}

const validTimestamp = (value: string, fallback: string) => Number.isNaN(Date.parse(value)) ? fallback : new Date(value).toISOString()
const eventId = (opportunity: HighLevelOpportunitySyncRecord, changedAt: string) => `ghl-stage-${opportunity.opportunityId}-${opportunity.stageId}-${changedAt}`

const localDate = (value: Date | string, timeZone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const daysInclusive = (startDate: string, endDate: string) => Math.round((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000) + 1

function reportingRange(workspace: WorkspaceRecord, options: HighLevelKpiReportOptions) {
  const period = options.period ?? 'all'
  const timeZone = workspace.recoveryPolicy.timezone || 'UTC'
  const today = localDate(options.now ?? new Date(), timeZone)
  if (period === 'all') return { period, timeZone, today }
  if (period === 'custom') return { period, timeZone, today, startDate: options.startDate!, endDate: options.endDate! }
  if (period === 'week') {
    const day = new Date(`${today}T00:00:00.000Z`).getUTCDay()
    const startDate = shiftDate(today, -(day === 0 ? 6 : day - 1))
    return { period, timeZone, today, startDate, endDate: shiftDate(startDate, 6) }
  }
  const startDate = `${today.slice(0, 7)}-01`
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { period, timeZone, today, startDate, endDate }
}

const dateIsInRange = (timestamp: string | undefined, range: ReturnType<typeof reportingRange>) => {
  if (!range.startDate || !range.endDate) return true
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return false
  const date = localDate(timestamp, range.timeZone)
  return date >= range.startDate && date <= range.endDate
}

export function reconcileHighLevelKpi(workspace: WorkspaceRecord, sync: HighLevelKpiSyncData, recordedAt = new Date().toISOString()) {
  workspace.highLevelKpi.stages = [...sync.stages]
    .filter((stage) => stage.pipelineId && stage.stageId)
    .sort((left, right) => left.pipelineName.localeCompare(right.pipelineName) || left.stageName.localeCompare(right.stageName))

  let created = 0
  let changed = 0
  let unchanged = 0

  for (const incoming of sync.opportunities.filter((opportunity) => opportunity.opportunityId && opportunity.stageId)) {
    const changedAt = validTimestamp(incoming.changedAt, recordedAt)
    const existing = workspace.highLevelKpi.opportunities.find((opportunity) => opportunity.opportunityId === incoming.opportunityId)
    const stageChanged = !existing || existing.stageId !== incoming.stageId || existing.pipelineId !== incoming.pipelineId

    if (!existing) {
      workspace.highLevelKpi.opportunities.push({ ...incoming, changedAt, firstSeenAt: recordedAt, lastSeenAt: recordedAt })
      created += 1
    } else {
      Object.assign(existing, incoming, { changedAt, lastSeenAt: recordedAt })
      if (stageChanged) changed += 1
      else unchanged += 1
    }

    if (stageChanged) {
      const id = eventId(incoming, changedAt)
      if (!workspace.highLevelKpi.stageEvents.some((event) => event.id === id)) {
        workspace.highLevelKpi.stageEvents.push({ id, ...incoming, changedAt, recordedAt })
      }
    }
  }

  workspace.highLevelKpi.stageEvents.sort((left, right) => left.changedAt.localeCompare(right.changedAt) || left.recordedAt.localeCompare(right.recordedAt))
  return { created, changed, unchanged, eventCount: workspace.highLevelKpi.stageEvents.length }
}

export function summarizeHighLevelKpis(workspace: WorkspaceRecord, options: HighLevelKpiReportOptions = {}) {
  const { settings, stages, opportunities, stageEvents } = workspace.highLevelKpi
  const range = reportingRange(workspace, options)
  const pipelineId = settings.pipelineId
  const pipelineOpportunities = opportunities.filter((opportunity) => !pipelineId || opportunity.pipelineId === pipelineId)
  const pipelineEvents = stageEvents.filter((event) => (!pipelineId || event.pipelineId === pipelineId) && dateIsInRange(event.changedAt, range))
  const sets: Record<HighLevelKpiOutcome | 'appointments' | 'showed', Set<string>> = {
    appointments: new Set<string>(),
    appointment_booked: new Set<string>(),
    no_show: new Set<string>(),
    rescheduled: new Set<string>(),
    showed_started: new Set<string>(),
    showed_not_converted: new Set<string>(),
    showed: new Set<string>(),
  }

  for (const event of pipelineEvents) {
    const outcome = settings.stageMappings[event.stageId]
    if (!outcome) continue
    if (!range.startDate || outcome === 'appointment_booked') sets.appointments.add(event.opportunityId)
    sets[outcome].add(event.opportunityId)
    if (outcome === 'showed_started' || outcome === 'showed_not_converted') sets.showed.add(event.opportunityId)
  }

  // Pipeline entry time lets the first sync count bookings even when the current stage is already an outcome.
  for (const opportunity of pipelineOpportunities) {
    const outcome = settings.stageMappings[opportunity.stageId]
    if (!outcome) continue
    const hasEventInRange = pipelineEvents.some((event) => event.opportunityId === opportunity.opportunityId && settings.stageMappings[event.stageId] === outcome)
    if (!range.startDate || dateIsInRange(opportunity.enteredAt || opportunity.firstSeenAt || opportunity.changedAt, range)) sets.appointments.add(opportunity.opportunityId)
    if (!hasEventInRange && dateIsInRange(opportunity.changedAt, range)) {
      sets[outcome].add(opportunity.opportunityId)
      if (outcome === 'showed_started' || outcome === 'showed_not_converted') sets.showed.add(opportunity.opportunityId)
    }
  }

  const percentage = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator * 100 : 0
  const appointments = sets.appointments.size
  const showed = sets.showed.size
  const started = sets.showed_started.size
  const mappedStageIds = new Set(Object.keys(settings.stageMappings))
  const availableStages = stages.filter((stage) => !pipelineId || stage.pipelineId === pipelineId)
  const convertedRevenue = pipelineEvents.reduce((total, event, index, events) => {
    if (settings.stageMappings[event.stageId] !== 'showed_started') return total
    if (events.findIndex((candidate) => candidate.opportunityId === event.opportunityId && settings.stageMappings[candidate.stageId] === 'showed_started') !== index) return total
    return total + Math.max(0, event.value)
  }, 0)
  const totalDays = range.startDate && range.endDate ? daysInclusive(range.startDate, range.endDate) : 0
  const elapsedDays = range.startDate && range.endDate && range.today >= range.startDate && range.today <= range.endDate ? daysInclusive(range.startDate, range.today) : 0
  const projectionFactor = elapsedDays > 0 && elapsedDays < totalDays ? totalDays / elapsedDays : 0
  const project = (value: number) => Math.round(value * projectionFactor)

  return {
    connected: Boolean(workspace.credentials.highlevel) || workspace.connections.highlevel?.mode === 'sandbox',
    lastSyncAt: workspace.connections.highlevel?.lastSyncAt,
    settings,
    stages,
    range: { period: range.period, startDate: range.startDate, endDate: range.endDate, timeZone: range.timeZone },
    projection: projectionFactor ? {
      elapsedDays,
      totalDays,
      appointments: project(appointments),
      showed: project(showed),
      started: project(started),
      convertedRevenue: project(convertedRevenue),
    } : undefined,
    summary: {
      appointments,
      noShows: sets.no_show.size,
      rescheduled: sets.rescheduled.size,
      showed,
      started,
      didNotConvert: sets.showed_not_converted.size,
      convertedRevenue,
      showRate: percentage(showed, appointments),
      conversionFromAppointments: percentage(started, appointments),
      conversionFromShows: percentage(started, showed),
      trackedOpportunities: pipelineOpportunities.length,
      mappedOpportunities: pipelineOpportunities.filter((opportunity) => mappedStageIds.has(opportunity.stageId)).length,
      unmappedOpportunities: pipelineOpportunities.filter((opportunity) => !mappedStageIds.has(opportunity.stageId)).length,
      mappedStages: availableStages.filter((stage) => mappedStageIds.has(stage.stageId)).length,
      availableStages: availableStages.length,
      trackedSince: stageEvents[0]?.recordedAt,
    },
    opportunities: pipelineOpportunities.map((opportunity) => ({
      ...opportunity,
      outcome: settings.stageMappings[opportunity.stageId] ?? null,
      outcomeLabel: settings.stageMappings[opportunity.stageId] ? highLevelKpiOutcomeLabels[settings.stageMappings[opportunity.stageId]] : 'Not mapped',
    })).sort((left, right) => right.changedAt.localeCompare(left.changedAt) || left.personName.localeCompare(right.personName)),
  }
}
