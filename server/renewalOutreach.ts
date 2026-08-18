import { randomBytes } from 'node:crypto'
import type { PublicUser } from './authService.js'
import { listQuoMessages, sendHighLevelMessage, sendQuoMessage } from './providers.js'
import type { NormalizedRow, RenewalClientRecord, RenewalOutreachActivityRecord, RenewalOutreachKind, WorkspaceRecord } from './types.js'
import type { EncryptedStore } from './store.js'

type OutreachChannel = 'sms' | 'email'
type OutreachPreviewInput = { channel: OutreachChannel; kind: RenewalOutreachKind }
type OutreachSendInput = OutreachPreviewInput & { subject?: string; body: string; approved: true; idempotencyKey: string }
export type RenewalReplyIntent = 'ready_to_continue' | 'positive_feedback' | 'webinar_blocked' | 'needs_support' | 'timing_or_budget' | 'not_interested' | 'opt_out' | 'unclear'
export type RenewalReplySuggestion = {
  intent: RenewalReplyIntent
  label: string
  rationale: string
  body: string
  recommendedNextAction: string
  sourceMessageId?: string
}

const dayMs = 86_400_000
const hourMs = 3_600_000
const inactivityDays = 14
const firstFollowUpDelayHours = 48
const finalFollowUpDelayHours = 72
const maxNoResponseFollowUps = 2
const stoppedStatuses = new Set(['call_booked', 'decision_pending', 'renewed', 'declined'])

function text(value: unknown) {
  return String(value ?? '').trim()
}

function lower(value: unknown) {
  return text(value).toLowerCase()
}

export function renewalOptOutReason(value: unknown) {
  const message = lower(value)
  if (/\b(wrong number)\b/.test(message)) return 'The recipient reported that this is the wrong number.'
  if (/\b(stop|unsubscribe|remove me|do not contact|don['’]?t contact)\b/.test(message)) return 'The recipient asked not to receive further messages.'
  return undefined
}

function utcDay(value: Date | string) {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function renewalDaysRemaining(client: RenewalClientRecord, now = new Date()) {
  if (!client.firstWebinarAt || Number.isNaN(Date.parse(client.firstWebinarAt))) return undefined
  const end = utcDay(client.firstWebinarAt) + 90 * dayMs
  return Math.round((end - utcDay(now)) / dayMs)
}

function daysSinceLastWebinar(client: RenewalClientRecord, now = new Date()) {
  if (!client.lastWebinarAt || Number.isNaN(Date.parse(client.lastWebinarAt))) return undefined
  return Math.max(0, Math.round((utcDay(now) - utcDay(client.lastWebinarAt)) / dayMs))
}

export type RenewalOutreachPhase = 'awaiting_activation' | 'active' | 'inactive' | 'renewal_window' | 'completion_overdue'

export function renewalOutreachPhase(client: RenewalClientRecord, now = new Date()): RenewalOutreachPhase {
  if (!client.firstWebinarAt) return 'awaiting_activation'
  const daysRemaining = renewalDaysRemaining(client, now)
  if (daysRemaining !== undefined && daysRemaining < 0) return 'completion_overdue'
  if (daysRemaining !== undefined && daysRemaining <= 30) return 'renewal_window'
  const inactiveFor = daysSinceLastWebinar(client, now)
  return inactiveFor !== undefined && inactiveFor >= inactivityDays ? 'inactive' : 'active'
}

export function renewalOutreachEligibility(client: RenewalClientRecord, now = new Date()) {
  if (client.outreachStatus === 'do_not_contact') {
    return { available: false, reason: client.outreachStatusReason?.trim() || 'This client is marked do not contact.' }
  }
  if (client.outreachStatus === 'paused') {
    return { available: false, reason: client.outreachStatusReason?.trim() || 'This client is paused from the re-engagement campaign.' }
  }
  if (stoppedStatuses.has(client.renewalStatus)) {
    return { available: false, reason: 'Outreach stops after a renewal call is booked or the opportunity is closed.' }
  }
  const phase = renewalOutreachPhase(client, now)
  const daysRemaining = renewalDaysRemaining(client, now)
  if (phase === 'awaiting_activation') {
    return { available: false, reason: 'Outreach begins after the client completes their first webinar.', daysRemaining, phase }
  }
  if (phase === 'completion_overdue') {
    return { available: false, reason: 'Completed clients are excluded from the current campaign.', daysRemaining, phase }
  }
  if (phase !== 'renewal_window') {
    return { available: false, reason: 'The current campaign is limited to selected active clients in their final 30 days.', daysRemaining, phase }
  }
  const inactiveFor = daysSinceLastWebinar(client, now)
  if (client.webinarsHosted < 1 || inactiveFor === undefined || inactiveFor >= inactivityDays) {
    return { available: false, reason: 'This campaign requires recent webinar activity as well as final approval from Launch Webinars.', daysRemaining, phase }
  }
  return { available: true, reason: 'Ready for Fred’s approved final-30-day check-in.', daysRemaining, phase }
}

function contactForClient(workspace: WorkspaceRecord, client: RenewalClientRecord) {
  const leads = workspace.workspace.leads?.rows ?? []
  const lead = leads.find((row) => client.crmContactId && text(row.id) === client.crmContactId)
    ?? leads.find((row) => client.email && lower(row.email) === client.email.toLowerCase())
    ?? leads.find((row) => lower(row.name) === client.name.toLowerCase())
  return {
    contactId: text(lead?.id) || client.crmContactId,
    email: text(lead?.email) || client.email,
    phone: client.phone || text(lead?.phone),
  }
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || 'there'
}

function timingKey(daysRemaining: number | undefined) {
  if (daysRemaining === undefined) return 'renewal'
  if (daysRemaining < 0) return 'overdue'
  if (daysRemaining <= 7) return '7_day'
  if (daysRemaining <= 14) return '14_day'
  return '30_day'
}

export function buildRenewalMessage(client: RenewalClientRecord, kind: RenewalOutreachKind, daysRemaining: number | undefined, businessName: string) {
  const displayBusinessName = businessName === 'LaunchWebinars' ? 'Launch Webinars' : businessName
  const isLaunchWebinars = businessName === 'LaunchWebinars'
  const name = firstName(client.name)
  const greeting = `Hey ${firstName(client.name)}, ${client.owner} here from ${displayBusinessName}.`
  const inactiveFor = daysSinceLastWebinar(client)
  const webinarProgress = client.webinarsHosted === 1
    ? 'You’ve got your first webinar under your belt now'
    : `You’ve got ${client.webinarsHosted} webinars under your belt now`
  if (kind === 'programme_check_in') {
    const body = isLaunchWebinars
      ? `Hey ${name}, how’s everything going? ${webinarProgress}. Is there anything you’re stuck on or need a hand with?`
      : `${greeting} Quick check-in: how are things going with the program so far? Is anything getting in the way of your next webinar or the results you’re aiming for?`
    return { templateKey: 'programme_check_in', subject: 'A quick program check-in', body }
  }
  if (kind === 'webinar_accountability') {
    const timing = inactiveFor === undefined ? 'It looks like your webinar activity may have slowed down.' : `I noticed it’s been ${inactiveFor} days since your last webinar.`
    const body = isLaunchWebinars
      ? `Hey ${name}, how’s everything going? ${timing} Is anything getting in the way of getting the next one booked?`
      : `${greeting} ${timing} Is anything blocking you from getting the next one booked? If there is, let me know what it is and we’ll help you get moving again.`
    return { templateKey: 'webinar_accountability', subject: 'Checking in on your next webinar', body }
  }
  if (kind === 'renewal_window_review') {
    const body = isLaunchWebinars
      ? `Hey ${name}, how’s everything going? ${webinarProgress}. How are you feeling about the progress so far?`
      : `${greeting} You’re coming towards the end of your current program period, so I wanted to check in. How has the experience been so far, and what would you still like help with before it ends?`
    return { templateKey: 'renewal_window_review', subject: 'Checking in before your program ends', body }
  }
  if (kind === 'post_completion_review') {
    const body = `${greeting} Now that your program period has finished, I wanted to check in properly. How was the experience for you, and what results did you get from the webinars you ran?`
    return { templateKey: 'post_completion_review', subject: 'How did the program go?', body }
  }
  if (kind === 'feedback_request') {
    const body = isLaunchWebinars
      ? `Hey ${name}, wanted to get your honest take on how everything’s been going. What’s been the most useful part for you so far, and is there anything you still need help with?`
      : `${greeting} As you approach the end of your program, I’d really value your honest feedback. What has been most useful so far, and what would you still like help with?`
    return { templateKey: 'feedback_request', subject: 'A quick check-in on your program', body }
  }
  if (kind === 'no_response_follow_up') {
    const previousFollowUps = (client.outreach ?? []).filter((activity) => activity.direction === 'outbound' && activity.kind === 'no_response_follow_up' && activity.deliveryStatus !== 'failed').length
    if (previousFollowUps > 0) {
      const body = isLaunchWebinars
        ? `All good if you’re busy, ${name}. Just wanted to check in before you finish up. Drop me a message when you get a sec.`
        : `${greeting} Last check-in from me. If you’d still like to review your results or talk through what the next step could look like, reply here and I’ll help arrange it. If not, no problem at all.`
      return { templateKey: 'no_response_close_loop', subject: 'Closing the loop', body }
    }
    const context = daysRemaining !== undefined && daysRemaining < 0
      ? 'I’d still like to hear how the program went from your side and whether there’s anything you want to keep building on.'
      : daysRemaining !== undefined && daysRemaining <= 30
        ? 'Before your current period ends, I’d like to understand what’s worked and what support would be most useful next.'
        : 'I’d like to understand how things are going and whether anything is getting in the way.'
    const body = isLaunchWebinars
      ? `Hey ${name}, just bumping this in case it got buried. How are you feeling about everything so far?`
      : `${greeting} Just following up in case my last message got buried. ${context}`
    return { templateKey: 'no_response_follow_up', subject: 'Following up on my last message', body }
  }
  const timing = timingKey(daysRemaining)
  const context = timing === 'overdue'
    ? 'Your current program period has now completed.'
    : timing === '7_day'
      ? 'You’re entering the final week of your current program.'
      : timing === '14_day'
        ? 'You’re around two weeks from the end of your current program.'
        : 'You’re entering the final 30 days of your current program.'
  const body = isLaunchWebinars
    ? `Hey ${name}, how’s everything going? ${webinarProgress}. What are you looking to build on next?`
    : `${greeting} ${context} I’d like to hear how the experience has been and what you want to achieve next. How has it gone from your side?`
  return { templateKey: `renewal_invitation_${timing}`, subject: 'Your progress and next steps', body }
}

export function buildRenewalReplySuggestion(client: RenewalClientRecord, customerReply: string, businessName: string): RenewalReplySuggestion {
  const message = lower(customerReply)
  const displayBusinessName = businessName === 'LaunchWebinars' ? 'Launch Webinars' : businessName
  const name = firstName(client.name)
  const isLaunchWebinars = businessName === 'LaunchWebinars'
  const result = (suggestion: Omit<RenewalReplySuggestion, 'sourceMessageId'>) => suggestion

  if (renewalOptOutReason(message)) {
    return result({
      intent: 'opt_out',
      label: 'Customer wants messages to stop',
      rationale: 'The reply contains an opt-out or wrong-number instruction. Do not continue the renewal conversation.',
      body: `Understood, ${name}. We’ll stop messaging this number.`,
      recommendedNextAction: 'Confirm the opt-out in Quo and do not send further renewal messages.',
    })
  }
  if (/\b(not interested|don['’]?t want|do not want|won['’]?t continue|will not continue|not continuing|no thanks|decline)\b/.test(message)) {
    return result({
      intent: 'not_interested',
      label: 'Not interested in continuing',
      rationale: 'The customer appears to be declining rather than asking for more information.',
      body: isLaunchWebinars
        ? `No worries, ${name}, appreciate you being straight with me. Out of interest, what’s the main reason you wouldn’t want to carry on?`
        : `Understood, ${name}. Thanks for being honest. Before I close this out, would you be open to sharing the main reason you don’t want to continue? No pressure—it just helps us improve.`,
      recommendedNextAction: 'Capture the reason if they respond, then mark the renewal as declined.',
    })
  }
  if (/\b(price|pricing|cost|expensive|afford|budget|money|timing|too busy|not now|later|next month)\b/.test(message)) {
    return result({
      intent: 'timing_or_budget',
      label: 'Timing or budget concern',
      rationale: 'The customer has raised a commercial or timing concern that should be understood before proposing a renewal.',
      body: isLaunchWebinars
        ? `Yeah, I get you. Is it more a timing or budget thing right now, or are you unsure another round would be worth it?`
        : `That makes sense, ${name}. Is the main concern budget, timing, or whether another cycle would create enough value? Once I understand which one it is, we can talk through the most sensible option.`,
      recommendedNextAction: 'Clarify the real objection before offering a call or renewal option.',
    })
  }
  if (/\b(yes|interested|continue|continuing|renew|sign me up|let['’]?s do it|book a call|speak|discuss)\b/.test(message)) {
    return result({
      intent: 'ready_to_continue',
      label: 'Ready to discuss continuing',
      rationale: 'The customer has shown clear interest in continuing or speaking about the next step.',
      body: isLaunchWebinars
        ? `Love that. Let’s get a quick call in with Yonas and map out what the next phase could look like. What day works best for you?`
        : `Great to hear, ${name}. The best next step is a quick call so we can review your results and what continuing should look like. What day and time works best for you?`,
      recommendedNextAction: 'Agree a time and record the renewal call in LeakLine.',
    })
  }
  if (/\b(webinar|webinars)\b/.test(message) && /\b(can['’]?t|cannot|haven['’]?t|have not|stuck|blocked|struggl|time|tech|technical|registrations?|attendees?)\b/.test(message)) {
    return result({
      intent: 'webinar_blocked',
      label: 'Webinar delivery blocker',
      rationale: 'The customer appears to be struggling to run or progress their webinars.',
      body: isLaunchWebinars
        ? `Got you. What’s the main thing getting in the way right now: time, tech, the offer, or getting people registered?`
        : `Thanks for being honest, ${name}. What’s the main blocker right now: time, tech, the offer, or getting people registered? Once I know that, we can help you choose the right next step.`,
      recommendedNextAction: 'Identify the blocker and assign the right Launch Webinars support action.',
    })
  }
  if (/\b(not happy|unhappy|disappoint|problem|issue|struggl|stuck|confus|didn['’]?t work|did not work|no results|poor|bad)\b/.test(message)) {
    return result({
      intent: 'needs_support',
      label: 'Needs support or has negative feedback',
      rationale: 'The customer has raised a problem or disappointment that should be understood before discussing renewal.',
      body: isLaunchWebinars
        ? `Got you, ${name}. What’s been the biggest issue from your side, and what would you want us to help fix first?`
        : `Thanks for being honest, ${name}. I want to understand that properly. What specifically hasn’t worked the way you expected, and what would you need help fixing first?`,
      recommendedNextAction: 'Resolve or escalate the service issue before moving the conversation towards renewal.',
    })
  }
  if (/\b(great|good|amazing|helpful|valuable|loved|happy|worked|results?|successful|success)\b/.test(message)) {
    return result({
      intent: 'positive_feedback',
      label: 'Positive experience, next goal unknown',
      rationale: 'The customer is positive, but has not yet said whether they want to continue.',
      body: isLaunchWebinars
        ? `Love that. What result are you happiest with so far, and what do you want to build on next?`
        : `That’s great to hear, ${name}. What result are you happiest with, and what would you most like to improve or build on next?`,
      recommendedNextAction: 'Use their next goal to decide whether a renewal conversation is relevant.',
    })
  }
  return result({
    intent: 'unclear',
    label: 'More context needed',
    rationale: `The reply is not clear enough for ${displayBusinessName} to assume the customer’s intent safely.`,
    body: isLaunchWebinars
      ? `Got you. What’s gone best for you so far, and what do you feel you still need help with?`
      : `Thanks for getting back to me, ${name}. What has gone best for you so far, and what would you most like support with next?`,
    recommendedNextAction: 'Ask one open question before deciding the next renewal action.',
  })
}

function latestDirection(client: RenewalClientRecord, direction: RenewalOutreachActivityRecord['direction']) {
  return [...(client.outreach ?? [])].filter((item) => item.direction === direction && item.deliveryStatus !== 'failed').sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

export function renewalFollowUpReadiness(client: RenewalClientRecord, now = new Date()) {
  const latestOutbound = latestDirection(client, 'outbound')
  const latestInbound = latestDirection(client, 'inbound')
  if (!latestOutbound || latestInbound && latestInbound.createdAt > latestOutbound.createdAt) {
    return { available: false, reason: 'A no-response follow-up is only available after an unanswered renewal message.' }
  }
  const successfulOutbound = [...(client.outreach ?? [])]
    .filter((item) => item.direction === 'outbound' && item.deliveryStatus !== 'failed')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  let lastOpeningIndex = -1
  for (let index = successfulOutbound.length - 1; index >= 0; index -= 1) {
    if (successfulOutbound[index].kind !== 'no_response_follow_up') {
      lastOpeningIndex = index
      break
    }
  }
  const followUpCount = successfulOutbound
    .slice(lastOpeningIndex + 1)
    .filter((item) => item.kind === 'no_response_follow_up').length
  if (followUpCount >= maxNoResponseFollowUps) {
    return { available: false, reason: 'The two-message no-response sequence is complete. Do not send another follow-up.', followUpCount }
  }
  const delayHours = followUpCount === 0 ? firstFollowUpDelayHours : finalFollowUpDelayHours
  const dueAt = new Date(Date.parse(latestOutbound.createdAt) + delayHours * hourMs).toISOString()
  if (now.getTime() < Date.parse(dueAt)) {
    return { available: false, reason: `The next no-response follow-up is available after ${dueAt}.`, followUpCount, dueAt }
  }
  return { available: true, reason: followUpCount === 0 ? 'Ready for the first no-response follow-up.' : 'Ready for the final close-the-loop message.', followUpCount, dueAt }
}

export class RenewalOutreachService {
  constructor(private readonly store: EncryptedStore, private readonly fetcher: typeof fetch = fetch) {}

  async preview(workspaceId: string, clientId: string, input: OutreachPreviewInput) {
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    const client = workspace?.renewalClients.find((item) => item.id === clientId)
    if (!workspace || !client) throw new Error('Renewal client not found.')
    const eligibility = renewalOutreachEligibility(client)
    const contact = contactForClient(workspace, client)
    const destination = input.channel === 'sms' ? contact.phone : contact.email
    const simulated = input.channel === 'sms' ? workspace.connections.quo?.mode === 'sandbox' : workspace.connections.highlevel?.mode === 'sandbox'
    const highLevelConnected = Boolean(workspace.credentials.highlevel) || simulated
    const quoConnected = Boolean(workspace.credentials.quo) || simulated
    const connected = input.channel === 'sms' ? quoConnected : highLevelConnected
    let conversationBlockReason: string | undefined
    if (input.channel === 'sms' && workspace.credentials.quo && destination) {
      const messages = await listQuoMessages(workspace.credentials.quo, destination, this.fetcher)
      conversationBlockReason = messages.filter((message) => message.direction === 'inbound').map((message) => renewalOptOutReason(message.body)).find(Boolean)
      if (!conversationBlockReason && input.kind === 'no_response_follow_up' && messages.at(-1)?.direction === 'inbound') {
        conversationBlockReason = 'The client has replied in Quo. Continue the conversation instead of sending a no-response follow-up.'
      }
    }
    const followUp = input.kind === 'no_response_follow_up' ? renewalFollowUpReadiness(client) : undefined
    if (!conversationBlockReason && followUp && !followUp.available) conversationBlockReason = followUp.reason
    const draft = buildRenewalMessage(client, input.kind, eligibility.daysRemaining, workspace.clientName)
    const reason = !eligibility.available
      ? eligibility.reason
      : conversationBlockReason
        ? conversationBlockReason
        : !connected
          ? `Connect ${input.channel === 'sms' ? 'Quo' : 'GoHighLevel'} before sending this draft.`
          : input.channel === 'email' && !contact.contactId
            ? 'Match this renewal client to a GoHighLevel contact before sending email.'
            : !destination
              ? `Add a ${input.channel === 'sms' ? 'phone number' : 'valid email'} to the matched GoHighLevel contact.`
              : 'Ready for review and approval.'
    return {
      ...draft,
      channel: input.channel,
      kind: input.kind,
      to: destination,
      contactMatched: Boolean(contact.contactId),
      highLevelConnected,
      quoConnected,
      canSend: eligibility.available && !conversationBlockReason && connected && Boolean(destination) && (input.channel === 'sms' || Boolean(contact.contactId)),
      reason,
      daysRemaining: eligibility.daysRemaining,
      phase: eligibility.phase,
      history: [...(client.outreach ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    }
  }

  async send(workspaceId: string, clientId: string, input: OutreachSendInput, actor: PublicUser) {
    if (!input.approved) throw new Error('Review and approve the exact renewal message before sending.')
    if (/\{\{[^}]+\}\}/.test(input.body)) throw new Error('This renewal message contains an unresolved placeholder.')
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    const client = workspace?.renewalClients.find((item) => item.id === clientId)
    if (!workspace || !client) throw new Error('Renewal client not found.')
    const existing = (client.outreach ?? []).find((item) => item.idempotencyKey === input.idempotencyKey)
    if (existing?.deliveryStatus === 'failed') throw new Error('The previous delivery failed. Review the error and try again as a new attempt.')
    if (existing) return { client, activity: existing, simulated: existing.deliveryStatus === 'simulated', replayed: true }
    const preview = await this.preview(workspaceId, clientId, input)
    if (!preview.canSend) throw new Error(preview.reason)
    const contact = contactForClient(workspace, client)
    const simulated = input.channel === 'sms' ? workspace.connections.quo?.mode === 'sandbox' : workspace.connections.highlevel?.mode === 'sandbox'
    const now = new Date().toISOString()
    const activityId = `renewal-outreach-${randomBytes(8).toString('hex')}`
    const pending: RenewalOutreachActivityRecord = {
      id: activityId,
      idempotencyKey: input.idempotencyKey,
      direction: 'outbound',
      channel: input.channel,
      kind: input.kind,
      templateKey: preview.templateKey,
      subject: input.channel === 'email' ? input.subject : undefined,
      body: input.body,
      deliveryStatus: 'pending',
      daysRemaining: preview.daysRemaining,
      renewalStatusAtSend: client.renewalStatus,
      createdAt: now,
      createdBy: actor.name || actor.email,
    }
    await this.store.update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)
      if (!target) throw new Error('Renewal client not found.')
      target.outreach ??= []
      target.outreach.push(pending)
      target.crmContactId = contact.contactId
      target.updatedAt = now
    })

    let providerMessageId: string | undefined
    let conversationId: string | undefined
    try {
      if (!simulated) {
        const sent = input.channel === 'sms'
          ? await sendQuoMessage(workspace.credentials.quo!, { to: contact.phone!, body: input.body }, this.fetcher)
          : await sendHighLevelMessage(workspace.credentials.highlevel!, { contactId: contact.contactId!, channel: 'email', body: input.body, subject: input.subject }, this.fetcher)
        providerMessageId = sent.messageId
        conversationId = sent.conversationId
      }
    } catch (error) {
      const failureReason = error instanceof Error ? error.message.slice(0, 500) : `${input.channel === 'sms' ? 'Quo' : 'GoHighLevel'} delivery failed.`
      await this.store.update((draft) => {
        const activity = draft.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)?.outreach?.find((item) => item.id === activityId)
        if (activity) Object.assign(activity, { deliveryStatus: 'failed', failureReason })
      })
      throw error
    }

    let updatedClient: RenewalClientRecord | undefined
    await this.store.update((draft) => {
      updatedClient = draft.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)
      const activity = updatedClient?.outreach?.find((item) => item.id === activityId)
      if (!updatedClient || !activity) throw new Error('Renewal outreach record not found.')
      Object.assign(activity, {
        deliveryStatus: simulated ? 'simulated' : 'sent',
        providerMessageId,
        conversationId,
      })
      const startsRenewalConversation = ['feedback_request', 'renewal_invitation', 'renewal_window_review', 'post_completion_review'].includes(input.kind)
      if (startsRenewalConversation && (updatedClient.renewalStatus === 'not_started' || updatedClient.renewalStatus === 'renewal_opportunity')) updatedClient.renewalStatus = 'conversation_needed'
      const followUp = renewalFollowUpReadiness(updatedClient)
      updatedClient.nextAction = followUp.followUpCount === maxNoResponseFollowUps
        ? 'The no-response sequence is complete. Do not send another follow-up; record any later reply or close the opportunity.'
        : followUp.dueAt
          ? `Review any reply. If there is none, the next follow-up is available after ${followUp.dueAt}.`
          : input.kind === 'webinar_accountability'
            ? 'Review the response and confirm the date of the client’s next webinar.'
            : input.kind === 'programme_check_in'
              ? 'Review the client response and resolve any delivery issue they raise.'
              : 'Review the client response and book the progress and renewal call.'
      updatedClient.updatedAt = new Date().toISOString()
    })
    return { client: updatedClient!, activity: updatedClient!.outreach!.find((item) => item.id === activityId)!, simulated, replayed: false }
  }

  async conversation(workspaceId: string, clientId: string) {
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    const client = workspace?.renewalClients.find((item) => item.id === clientId)
    if (!workspace || !client) throw new Error('Renewal client not found.')
    const contact = contactForClient(workspace, client)
    if (!contact.phone) throw new Error('Add a mobile number to this renewal client before opening SMS history.')
    const credential = workspace.credentials.quo
    if (!credential) throw new Error('Connect Quo before opening SMS history.')
    const messages = await listQuoMessages(credential, contact.phone, this.fetcher)
    const latestMessage = messages.at(-1)
    const suppressionReason = messages.filter((message) => message.direction === 'inbound').map((message) => renewalOptOutReason(message.body)).find(Boolean)
    const suggestion = latestMessage?.direction === 'inbound'
      ? { ...buildRenewalReplySuggestion(client, latestMessage.body, workspace.clientName), sourceMessageId: latestMessage.id }
      : undefined
    return {
      clientId,
      participant: contact.phone,
      messages,
      suggestion,
      suppressionReason,
    }
  }

  async sendConversationMessage(workspaceId: string, clientId: string, input: { body: string; approved: true; idempotencyKey: string; sourceMessageId?: string }, actor: PublicUser) {
    if (!input.approved) throw new Error('Review and approve the exact reply before sending it through Quo.')
    if (/\{\{[^}]+\}\}/.test(input.body)) throw new Error('This SMS contains an unresolved placeholder.')
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    const client = workspace?.renewalClients.find((item) => item.id === clientId)
    if (!workspace || !client) throw new Error('Renewal client not found.')
    const existing = (client.outreach ?? []).find((item) => item.idempotencyKey === input.idempotencyKey)
    if (existing) return { client, activity: existing, replayed: true }
    const eligibility = renewalOutreachEligibility(client)
    if (!eligibility.available) throw new Error(eligibility.reason)
    const contact = contactForClient(workspace, client)
    if (!contact.phone) throw new Error('Add a mobile number to this renewal client before sending SMS.')
    const credential = workspace.credentials.quo
    if (!credential) throw new Error('Connect Quo before sending SMS.')
    const messages = await listQuoMessages(credential, contact.phone, this.fetcher)
    const suppressionReason = messages.filter((message) => message.direction === 'inbound').map((message) => renewalOptOutReason(message.body)).find(Boolean)
    if (suppressionReason) throw new Error(`${suppressionReason} Further SMS is blocked.`)
    const latestMessage = messages.at(-1)
    if (latestMessage?.direction === 'inbound' && input.sourceMessageId !== latestMessage.id) {
      throw new Error('A newer client reply is available. Refresh the conversation and review a new response before sending.')
    }
    if (latestMessage?.direction === 'outbound' && input.sourceMessageId) {
      throw new Error('This client reply has already been answered. Refresh the conversation before sending again.')
    }
    const now = new Date().toISOString()
    const activityId = `renewal-outreach-${randomBytes(8).toString('hex')}`
    const latestOutbound = latestDirection(client, 'outbound')
    const pending: RenewalOutreachActivityRecord = {
      id: activityId,
      idempotencyKey: input.idempotencyKey,
      direction: 'outbound',
      channel: 'sms',
      kind: latestOutbound?.kind ?? 'renewal_invitation',
      templateKey: 'conversation_reply',
      body: input.body,
      deliveryStatus: 'pending',
      renewalStatusAtSend: client.renewalStatus,
      createdAt: now,
      createdBy: actor.name || actor.email,
    }
    await this.store.update((draft) => {
      const target = draft.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)
      if (!target) throw new Error('Renewal client not found.')
      target.outreach ??= []
      target.outreach.push(pending)
      target.updatedAt = now
    })
    try {
      const sent = await sendQuoMessage(credential, { to: contact.phone, body: input.body }, this.fetcher)
      let updatedClient: RenewalClientRecord | undefined
      await this.store.update((draft) => {
        updatedClient = draft.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)
        const activity = updatedClient?.outreach?.find((item) => item.id === activityId)
        if (!updatedClient || !activity) throw new Error('Renewal conversation activity not found.')
        Object.assign(activity, { deliveryStatus: 'sent', providerMessageId: sent.messageId, conversationId: sent.conversationId })
        updatedClient.nextAction = 'Review the client response and continue the renewal conversation.'
        updatedClient.updatedAt = new Date().toISOString()
      })
      return { client: updatedClient!, activity: updatedClient!.outreach!.find((item) => item.id === activityId)!, replayed: false }
    } catch (error) {
      const failureReason = error instanceof Error ? error.message.slice(0, 500) : 'Quo delivery failed.'
      await this.store.update((draft) => {
        const activity = draft.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)?.outreach?.find((item) => item.id === activityId)
        if (activity) Object.assign(activity, { deliveryStatus: 'failed', failureReason })
      })
      throw error
    }
  }

  async recordInbound(workspaceId: string, clientId: string, input: { channel: OutreachChannel; body: string; providerMessageId?: string; conversationId?: string }, createdBy: string) {
    let updatedClient: RenewalClientRecord | undefined
    await this.store.update((state) => {
      updatedClient = state.workspaces.find((item) => item.id === workspaceId)?.renewalClients.find((item) => item.id === clientId)
      if (!updatedClient) throw new Error('Renewal client not found.')
      updatedClient.outreach ??= []
      if (input.providerMessageId && updatedClient.outreach.some((item) => item.providerMessageId === input.providerMessageId)) return
      const latestOutbound = latestDirection(updatedClient, 'outbound')
      updatedClient.outreach.push({
        id: `renewal-outreach-${randomBytes(8).toString('hex')}`,
        direction: 'inbound',
        channel: input.channel,
        kind: latestOutbound?.kind ?? 'renewal_invitation',
        templateKey: 'inbound_reply',
        body: input.body,
        providerMessageId: input.providerMessageId,
        conversationId: input.conversationId,
        deliveryStatus: 'received',
        createdAt: new Date().toISOString(),
        createdBy,
      })
      updatedClient.nextAction = 'Review the client reply and book the progress and renewal call.'
      updatedClient.updatedAt = new Date().toISOString()
    })
    return updatedClient!
  }
}
