export const PROGRAMME_LENGTH_DAYS = 90
export const WEBINAR_TARGET = 6
export const INACTIVITY_DAYS = 14

export type RenewalStatus = 'not_started' | 'renewal_opportunity' | 'conversation_needed' | 'call_booked' | 'decision_pending' | 'renewed' | 'declined'
export type RenewalPipelineStage = 'active_programme' | Exclude<RenewalStatus, 'not_started'>
export type RenewalOutreachKind = 'feedback_request' | 'renewal_invitation' | 'no_response_follow_up'
export type RenewalOutreachActivity = {
  id: string
  direction: 'outbound' | 'inbound'
  channel: 'sms' | 'email'
  kind: RenewalOutreachKind
  templateKey: string
  subject?: string
  body: string
  providerMessageId?: string
  conversationId?: string
  deliveryStatus: 'pending' | 'sent' | 'simulated' | 'failed' | 'received'
  failureReason?: string
  daysRemaining?: number
  renewalStatusAtSend?: RenewalStatus
  createdAt: string
  createdBy: string
}

export const RENEWAL_PIPELINE_STAGES: Array<{ id: RenewalPipelineStage; label: string }> = [
  { id: 'active_programme', label: 'Active program' },
  { id: 'renewal_opportunity', label: 'Renewal opportunity' },
  { id: 'conversation_needed', label: 'Conversation needed' },
  { id: 'call_booked', label: 'Call booked' },
  { id: 'decision_pending', label: 'Decision pending' },
  { id: 'renewed', label: 'Renewed' },
  { id: 'declined', label: 'Declined' },
]

export type RenewalClient = {
  id: string
  name: string
  email?: string
  phone?: string
  owner: string
  enrolledAt?: string
  firstWebinarAt?: string
  lastWebinarAt?: string
  nextWebinarAt?: string
  webinarsHosted: number
  feedbackScore?: number
  feedbackNote?: string
  renewalCallAt?: string
  renewalStatus: RenewalStatus
  expectedRenewalValue: number
  renewalCashCollected: number
  nextAction?: string
  source?: 'manual' | 'clickup'
  clickUpTaskId?: string
  clickUpStatus?: string
  crmContactId?: string
  outreach?: RenewalOutreachActivity[]
  createdAt: string
  updatedAt: string
}

export type RenewalClientInput = Omit<RenewalClient, 'id' | 'createdAt' | 'updatedAt' | 'source' | 'clickUpTaskId' | 'clickUpStatus' | 'crmContactId' | 'outreach'>
export type ProgrammePhase = 'awaiting_activation' | 'active' | 'inactive' | 'renewal_window' | 'completion_overdue' | 'renewed' | 'declined'
export type ReadinessLabel = 'High' | 'Medium' | 'Low' | 'Needs feedback' | 'Needs activity'

const dayMs = 86_400_000

function utcDay(value: Date | string) {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function programmeEndDate(firstWebinarAt?: string) {
  if (!firstWebinarAt || Number.isNaN(Date.parse(firstWebinarAt))) return undefined
  return new Date(utcDay(firstWebinarAt) + PROGRAMME_LENGTH_DAYS * dayMs).toISOString().slice(0, 10)
}

export function daysUntilProgrammeEnd(client: RenewalClient, now = new Date()) {
  const end = programmeEndDate(client.firstWebinarAt)
  return end ? Math.round((utcDay(end) - utcDay(now)) / dayMs) : undefined
}

export function daysSinceLastWebinar(client: RenewalClient, now = new Date()) {
  if (!client.lastWebinarAt || Number.isNaN(Date.parse(client.lastWebinarAt))) return undefined
  return Math.max(0, Math.round((utcDay(now) - utcDay(client.lastWebinarAt)) / dayMs))
}

export function programmePhase(client: RenewalClient, now = new Date()): ProgrammePhase {
  if (client.renewalStatus === 'renewed') return 'renewed'
  if (client.renewalStatus === 'declined') return 'declined'
  if (!client.firstWebinarAt) return 'awaiting_activation'
  const remaining = daysUntilProgrammeEnd(client, now)
  if (remaining !== undefined && remaining < 0) return 'completion_overdue'
  if (remaining !== undefined && remaining <= 30) return 'renewal_window'
  const inactiveFor = daysSinceLastWebinar(client, now)
  if (inactiveFor !== undefined && inactiveFor >= INACTIVITY_DAYS) return 'inactive'
  return 'active'
}

export function renewalOutreachAvailability(client: RenewalClient, now = new Date()) {
  const phase = programmePhase(client, now)
  if (['call_booked', 'decision_pending', 'renewed', 'declined'].includes(client.renewalStatus)) {
    return { available: false, reason: 'Outreach stops after a renewal call is booked or the opportunity is closed.' }
  }
  if (phase !== 'renewal_window' && phase !== 'completion_overdue') {
    return { available: false, reason: 'Assisted outreach becomes available in the final 30 days of the program.' }
  }
  return { available: true, reason: 'Ready for assisted feedback and renewal outreach.' }
}

export function renewalReadiness(client: RenewalClient, now = new Date()) {
  const usagePoints = Math.min(client.webinarsHosted / WEBINAR_TARGET, 1) * 50
  const inactiveFor = daysSinceLastWebinar(client, now)
  const recencyPoints = inactiveFor === undefined ? 0 : inactiveFor <= INACTIVITY_DAYS ? 20 : inactiveFor <= 30 ? 10 : 0
  const feedbackPoints = client.feedbackScore === undefined ? 0 : client.feedbackScore / 5 * 30
  const score = Math.round(usagePoints + recencyPoints + feedbackPoints)
  const label: ReadinessLabel = !client.firstWebinarAt || !client.lastWebinarAt || client.webinarsHosted === 0
    ? 'Needs activity'
    : client.feedbackScore === undefined
      ? 'Needs feedback'
      : score >= 70 ? 'High' : score >= 45 ? 'Medium' : 'Low'
  const explanation = `${Math.round(usagePoints)}/50 usage · ${Math.round(recencyPoints)}/20 recency · ${Math.round(feedbackPoints)}/30 feedback`
  return { score, label, explanation }
}

export function renewalPipelineStage(client: RenewalClient, now = new Date()): RenewalPipelineStage {
  if (client.renewalStatus !== 'not_started') return client.renewalStatus
  const phase = programmePhase(client, now)
  return phase === 'renewal_window' || phase === 'completion_overdue' ? 'renewal_opportunity' : 'active_programme'
}

export function renewalStatusForPipelineStage(stage: RenewalPipelineStage): RenewalStatus {
  return stage === 'active_programme' ? 'not_started' : stage
}

export function recommendedRenewalAction(client: RenewalClient, now = new Date()) {
  if (client.nextAction?.trim()) return client.nextAction.trim()
  const phase = programmePhase(client, now)
  if (phase === 'renewed') return 'Continue onboarding into the renewed service.'
  if (phase === 'declined') return 'Record the reason and close the renewal opportunity.'
  if (phase === 'awaiting_activation') return 'Schedule and complete the first webinar to start the 90-day program.'
  if (client.renewalStatus === 'decision_pending') return 'Follow up on the renewal decision and record the outcome.'
  if (client.renewalStatus === 'call_booked') return 'Prepare the renewal conversation using webinar usage and client feedback.'
  if (client.renewalStatus === 'conversation_needed') return `Ask ${client.owner} to contact the client and book the renewal conversation.`
  const inactiveFor = daysSinceLastWebinar(client, now)
  if (phase === 'inactive' || inactiveFor !== undefined && inactiveFor >= INACTIVITY_DAYS) return `Ask ${client.owner} to re-engage the client and schedule their next webinar.`
  if (client.feedbackScore === undefined) return 'Collect a feedback score and note before preparing the renewal conversation.'
  if (client.renewalStatus === 'renewal_opportunity') return 'Review the client results and move them into a renewal conversation.'
  if ((phase === 'renewal_window' || phase === 'completion_overdue') && !client.renewalCallAt) return 'Book the progress and renewal call now.'
  if (renewalReadiness(client, now).label === 'High') return 'Begin personalised renewal nurturing while engagement is strong.'
  return 'Keep webinar participation active and review readiness at the next client check-in.'
}

export function renewalPipelineSummary(clients: RenewalClient[], now = new Date()) {
  return RENEWAL_PIPELINE_STAGES.map(({ id: stage, label }) => {
    const stageClients = clients.filter((client) => renewalPipelineStage(client, now) === stage)
    return {
      stage,
      label,
      clientCount: stageClients.length,
      value: stageClients.reduce((sum, client) => sum + (stage === 'renewed' ? client.renewalCashCollected : client.expectedRenewalValue), 0),
    }
  })
}

export function renewalSummary(clients: RenewalClient[], now = new Date()) {
  return {
    activeClients: clients.filter((client) => ['active', 'inactive', 'renewal_window'].includes(programmePhase(client, now))).length,
    awaitingActivation: clients.filter((client) => programmePhase(client, now) === 'awaiting_activation').length,
    renewalOpportunities: clients.filter((client) => ['renewal_window', 'completion_overdue'].includes(programmePhase(client, now)) && !['renewed', 'declined'].includes(client.renewalStatus)).length,
    highReadiness: clients.filter((client) => renewalReadiness(client, now).label === 'High' && !['renewed', 'declined'].includes(client.renewalStatus)).length,
    renewalCashCollected: clients.reduce((sum, client) => sum + client.renewalCashCollected, 0),
  }
}
