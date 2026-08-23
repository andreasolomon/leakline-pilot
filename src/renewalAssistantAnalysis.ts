import {
  daysSinceLastWebinar,
  daysUntilProgrammeEnd,
  programmePhase,
  recommendedRenewalAction,
  renewalReadiness,
  type RenewalClient,
} from './renewalCommand'

export const RENEWAL_ASSISTANT_PROMPTS = [
  'Who needs attention today?',
  'Who is most ready to renew?',
  'What client data is missing?',
] as const

export type RenewalAssistantQuestion = 'attention' | 'readiness' | 'missing' | 'help' | 'unsupported'

export type RenewalAssistantItem = {
  id: string
  heading: string
  evidence: string
  recommendation?: string
}

export type RenewalAssistantAnswer = {
  kind: 'answer' | 'empty' | 'unsupported'
  title: string
  summary: string
  items: RenewalAssistantItem[]
  note?: string
}

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const phaseLabels = {
  awaiting_activation: 'Awaiting activation',
  active: 'Active program',
  inactive: 'Inactive',
  renewal_window: 'Renewal window',
  completion_overdue: 'Past completion',
  renewed: 'Renewed',
  declined: 'Declined',
} as const

export function classifyRenewalAssistantQuestion(question: string): RenewalAssistantQuestion {
  const normalized = question.trim().toLowerCase()
  if (!normalized || /\b(help|questions|can you do|what can you)\b/.test(normalized)) return 'help'
  if (/\b(missing|incomplete|data gap|gaps|unknown)\b/.test(normalized)) return 'missing'
  if (/\b(ready|readiness|likely to renew|most likely|renew next)\b/.test(normalized)) return 'readiness'
  if (/\b(attention|priority|prioritise|prioritize|today|next action|contact first|focus on)\b/.test(normalized)) return 'attention'
  return 'unsupported'
}

function attentionScore(client: RenewalClient, now: Date) {
  const statusScores: Record<RenewalClient['renewalStatus'], number> = {
    not_started: 0,
    renewal_opportunity: 50,
    conversation_needed: 65,
    call_booked: 70,
    decision_pending: 80,
    renewed: -1_000,
    declined: -1_000,
  }
  const phaseScores = {
    awaiting_activation: 45,
    active: 15,
    inactive: 55,
    renewal_window: 60,
    completion_overdue: 25,
    renewed: -1_000,
    declined: -1_000,
  } as const
  const remaining = daysUntilProgrammeEnd(client, now)
  const finalThirtyDays = remaining !== undefined && remaining >= 0 && remaining <= 30 ? 30 - remaining : 0
  const inactivity = daysSinceLastWebinar(client, now)
  const inactivityWeight = inactivity !== undefined && inactivity >= 14 ? Math.min(inactivity - 13, 20) : 0
  const missingFeedback = client.feedbackScore === undefined ? 5 : 0
  return statusScores[client.renewalStatus] + phaseScores[programmePhase(client, now)] + finalThirtyDays + inactivityWeight + missingFeedback
}

function clientEvidence(client: RenewalClient, now: Date) {
  const phase = programmePhase(client, now)
  const readiness = renewalReadiness(client, now)
  const remaining = daysUntilProgrammeEnd(client, now)
  const timing = remaining === undefined
    ? 'Program timing missing'
    : remaining < 0
      ? `${Math.abs(remaining)} days past completion`
      : `${remaining} days remaining`
  return `${phaseLabels[phase]} · ${timing} · ${client.webinarsHosted} webinar${client.webinarsHosted === 1 ? '' : 's'} · ${readiness.label} readiness`
}

function attentionAnswer(clients: RenewalClient[], now: Date): RenewalAssistantAnswer {
  const candidates = clients
    .filter((client) => !['renewed', 'declined'].includes(client.renewalStatus))
    .map((client) => ({ client, score: attentionScore(client, now) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.client.expectedRenewalValue - left.client.expectedRenewalValue)
    .slice(0, 3)

  if (!candidates.length) {
    return {
      kind: 'empty',
      title: 'No open renewal priorities',
      summary: 'The current records do not contain an open client that needs renewal attention.',
      items: [],
      note: `Checked ${clients.length} permitted renewal record${clients.length === 1 ? '' : 's'}.`,
    }
  }

  return {
    kind: 'answer',
    title: 'Clients needing attention first',
    summary: `These ${candidates.length} clients have the strongest combination of timing, inactivity and open renewal work.`,
    items: candidates.map(({ client }) => ({
      id: client.id,
      heading: client.name,
      evidence: clientEvidence(client, now),
      recommendation: recommendedRenewalAction(client, now),
    })),
    note: `Prioritised from ${clients.length} current record${clients.length === 1 ? '' : 's'}. This is an operational priority, not a prediction.`,
  }
}

function readinessAnswer(clients: RenewalClient[], now: Date): RenewalAssistantAnswer {
  const candidates = clients
    .filter((client) => !['renewed', 'declined'].includes(client.renewalStatus) && client.webinarsHosted > 0)
    .map((client) => ({ client, readiness: renewalReadiness(client, now) }))
    .sort((left, right) => right.readiness.score - left.readiness.score || right.client.expectedRenewalValue - left.client.expectedRenewalValue)
    .slice(0, 3)

  if (!candidates.length) {
    return {
      kind: 'empty',
      title: 'Not enough activity to rank readiness',
      summary: 'LeakLine needs at least one client with recorded webinar activity before it can compare renewal readiness.',
      items: [],
      note: `Checked ${clients.length} permitted renewal record${clients.length === 1 ? '' : 's'}.`,
    }
  }

  return {
    kind: 'answer',
    title: 'Strongest current renewal signals',
    summary: 'These clients rank highest using webinar usage, recent activity and recorded feedback.',
    items: candidates.map(({ client, readiness }) => ({
      id: client.id,
      heading: `${client.name} · ${readiness.score}/100`,
      evidence: `${readiness.label} · ${readiness.explanation} · ${currency.format(client.expectedRenewalValue)} expected value`,
      recommendation: recommendedRenewalAction(client, now),
    })),
    note: 'Readiness is a transparent signal from current records. It does not guarantee that a client will renew.',
  }
}

const missingFieldChecks: Array<{ label: string; isMissing: (client: RenewalClient) => boolean }> = [
  { label: 'first webinar date', isMissing: (client) => !client.firstWebinarAt },
  { label: 'last webinar date', isMissing: (client) => !client.lastWebinarAt },
  { label: 'feedback score', isMissing: (client) => client.feedbackScore === undefined },
  { label: 'expected renewal value', isMissing: (client) => client.expectedRenewalValue <= 0 },
  { label: 'SMS phone number', isMissing: (client) => !client.phone?.trim() },
  { label: 'client owner', isMissing: (client) => !client.owner?.trim() },
]

function missingDataAnswer(clients: RenewalClient[]): RenewalAssistantAnswer {
  const gaps = missingFieldChecks
    .map((field) => ({ field, clients: clients.filter(field.isMissing) }))
    .filter(({ clients: missingClients }) => missingClients.length > 0)
    .sort((left, right) => right.clients.length - left.clients.length)

  if (!gaps.length) {
    return {
      kind: 'answer',
      title: 'Core renewal fields are complete',
      summary: 'Every current client has the minimum program, feedback, value, contact and ownership fields checked by this assistant.',
      items: [],
      note: `Checked ${clients.length} permitted renewal record${clients.length === 1 ? '' : 's'}.`,
    }
  }

  return {
    kind: 'answer',
    title: 'Data gaps affecting renewal decisions',
    summary: `${gaps.length} core field${gaps.length === 1 ? '' : 's'} need attention across the current client records.`,
    items: gaps.slice(0, 4).map(({ field, clients: missingClients }) => ({
      id: field.label,
      heading: `${missingClients.length} missing ${field.label}`,
      evidence: missingClients.slice(0, 4).map((client) => client.name).join(', ') + (missingClients.length > 4 ? ` and ${missingClients.length - 4} more` : ''),
      recommendation: `Update ${field.label} before relying on related renewal recommendations.`,
    })),
    note: `Checked ${clients.length} permitted renewal record${clients.length === 1 ? '' : 's'}.`,
  }
}

export function answerRenewalAssistantQuestion(clients: RenewalClient[], question: string, now = new Date()): RenewalAssistantAnswer {
  const questionType = classifyRenewalAssistantQuestion(question)

  if (questionType === 'help') {
    return {
      kind: 'answer',
      title: 'What I can answer reliably',
      summary: 'This first version is limited to three renewal questions grounded in the active workspace’s client records.',
      items: RENEWAL_ASSISTANT_PROMPTS.map((prompt) => ({ id: prompt, heading: prompt, evidence: 'Uses the current Renewal Command records.' })),
      note: 'The assistant is read-only and cannot change data or contact clients.',
    }
  }

  if (questionType === 'unsupported') {
    return {
      kind: 'unsupported',
      title: 'I cannot answer that reliably yet',
      summary: 'Try one of the supported renewal questions below. I will not guess or invent an answer from data I do not have.',
      items: [],
      note: 'This preview currently analyses renewal timing, activity, feedback and record completeness.',
    }
  }

  if (!clients.length) {
    return {
      kind: 'empty',
      title: 'No renewal client data is available',
      summary: 'Connect ClickUp or import the client manager CSV before the assistant can analyse renewal activity.',
      items: [],
      note: 'No sample records are substituted for this workspace.',
    }
  }

  if (questionType === 'attention') return attentionAnswer(clients, now)
  if (questionType === 'readiness') return readinessAnswer(clients, now)
  return missingDataAnswer(clients)
}
