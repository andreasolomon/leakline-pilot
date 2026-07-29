import { randomBytes } from 'node:crypto'
import type { PublicUser } from './authService.js'
import { sendHighLevelMessage } from './providers.js'
import type { NormalizedRow, RenewalClientRecord, RenewalOutreachActivityRecord, RenewalOutreachKind, WorkspaceRecord } from './types.js'
import type { EncryptedStore } from './store.js'

type OutreachChannel = 'sms' | 'email'
type OutreachPreviewInput = { channel: OutreachChannel; kind: RenewalOutreachKind }
type OutreachSendInput = OutreachPreviewInput & { subject?: string; body: string; approved: true; idempotencyKey: string }

const dayMs = 86_400_000
const stoppedStatuses = new Set(['call_booked', 'decision_pending', 'renewed', 'declined'])

function text(value: unknown) {
  return String(value ?? '').trim()
}

function lower(value: unknown) {
  return text(value).toLowerCase()
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

export function renewalOutreachEligibility(client: RenewalClientRecord, now = new Date()) {
  if (stoppedStatuses.has(client.renewalStatus)) {
    return { available: false, reason: 'Outreach stops after a renewal call is booked or the opportunity is closed.' }
  }
  const daysRemaining = renewalDaysRemaining(client, now)
  if (daysRemaining === undefined || daysRemaining > 30) {
    return { available: false, reason: 'Assisted outreach becomes available in the final 30 days of the program.', daysRemaining }
  }
  return { available: true, reason: 'Ready for assisted feedback and renewal outreach.', daysRemaining }
}

function contactForClient(workspace: WorkspaceRecord, client: RenewalClientRecord) {
  const leads = workspace.workspace.leads?.rows ?? []
  const lead = leads.find((row) => client.crmContactId && text(row.id) === client.crmContactId)
    ?? leads.find((row) => client.email && lower(row.email) === client.email.toLowerCase())
    ?? leads.find((row) => lower(row.name) === client.name.toLowerCase())
  return {
    contactId: text(lead?.id) || client.crmContactId,
    email: text(lead?.email) || client.email,
    phone: text(lead?.phone),
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

function buildMessage(workspace: WorkspaceRecord, client: RenewalClientRecord, kind: RenewalOutreachKind, daysRemaining: number | undefined) {
  const greeting = `Hi ${firstName(client.name)},`
  const signoff = `${client.owner}\n${workspace.clientName}`
  if (kind === 'feedback_request') {
    const body = `${greeting}\n\nAs you approach the end of your program, I’d love your honest feedback. What has been most valuable so far, and what would you still like help with? Your response will help us prepare your progress review.\n\n${signoff}`
    return { templateKey: 'feedback_request', subject: 'A quick check-in on your program', body }
  }
  if (kind === 'no_response_follow_up') {
    const body = `${greeting}\n\nJust following up on my last message. I’d like to review the progress you’ve made and discuss the best next step before your current program finishes. When would be a good time for a short conversation?\n\n${signoff}`
    return { templateKey: 'no_response_follow_up', subject: 'Following up on your progress review', body }
  }
  const timing = timingKey(daysRemaining)
  const context = timing === 'overdue'
    ? 'Your current program period has now completed.'
    : timing === '7_day'
      ? 'You’re entering the final week of your current program.'
      : timing === '14_day'
        ? 'You’re around two weeks from the end of your current program.'
        : 'You’re entering the final 30 days of your current program.'
  const body = `${greeting}\n\n${context} I’d like to review your progress, what you want to achieve next, and whether continuing together makes sense. When would be a good time for a short progress and renewal conversation?\n\n${signoff}`
  return { templateKey: `renewal_invitation_${timing}`, subject: 'Your progress and next steps', body }
}

function latestDirection(client: RenewalClientRecord, direction: RenewalOutreachActivityRecord['direction']) {
  return [...(client.outreach ?? [])].filter((item) => item.direction === direction && item.deliveryStatus !== 'failed').sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

function validateKind(client: RenewalClientRecord, kind: RenewalOutreachKind) {
  if (kind !== 'no_response_follow_up') return
  const latestOutbound = latestDirection(client, 'outbound')
  const latestInbound = latestDirection(client, 'inbound')
  if (!latestOutbound || latestInbound && latestInbound.createdAt > latestOutbound.createdAt) {
    throw new Error('A no-response follow-up is only available after an unanswered renewal message.')
  }
}

export class RenewalOutreachService {
  constructor(private readonly store: EncryptedStore, private readonly fetcher: typeof fetch = fetch) {}

  async preview(workspaceId: string, clientId: string, input: OutreachPreviewInput) {
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    const client = workspace?.renewalClients.find((item) => item.id === clientId)
    if (!workspace || !client) throw new Error('Renewal client not found.')
    const eligibility = renewalOutreachEligibility(client)
    validateKind(client, input.kind)
    const contact = contactForClient(workspace, client)
    const destination = input.channel === 'sms' ? contact.phone : contact.email
    const connected = Boolean(workspace.credentials.highlevel) || workspace.connections.highlevel?.mode === 'sandbox'
    const draft = buildMessage(workspace, client, input.kind, eligibility.daysRemaining)
    const reason = !eligibility.available
      ? eligibility.reason
      : !connected
        ? 'Connect GoHighLevel before sending this draft.'
        : !contact.contactId
          ? 'Match this renewal client to a GoHighLevel contact before sending.'
          : !destination
            ? `Add a ${input.channel === 'sms' ? 'phone number' : 'valid email'} to the matched GoHighLevel contact.`
            : 'Ready for review and approval.'
    return {
      ...draft,
      channel: input.channel,
      kind: input.kind,
      to: destination,
      contactMatched: Boolean(contact.contactId),
      highLevelConnected: connected,
      canSend: eligibility.available && connected && Boolean(contact.contactId) && Boolean(destination),
      reason,
      daysRemaining: eligibility.daysRemaining,
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
    const simulated = workspace.connections.highlevel?.mode === 'sandbox'
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
        const credential = workspace.credentials.highlevel
        if (!credential || !contact.contactId) throw new Error('Connect and match GoHighLevel before sending.')
        const sent = await sendHighLevelMessage(credential, {
          contactId: contact.contactId,
          channel: input.channel,
          body: input.body,
          subject: input.subject,
        }, this.fetcher)
        providerMessageId = sent.messageId
        conversationId = sent.conversationId
      }
    } catch (error) {
      const failureReason = error instanceof Error ? error.message.slice(0, 500) : 'GoHighLevel delivery failed.'
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
      if (updatedClient.renewalStatus === 'not_started' || updatedClient.renewalStatus === 'renewal_opportunity') updatedClient.renewalStatus = 'conversation_needed'
      updatedClient.nextAction = 'Review the client response and book the progress and renewal call.'
      updatedClient.updatedAt = new Date().toISOString()
    })
    return { client: updatedClient!, activity: updatedClient!.outreach!.find((item) => item.id === activityId)!, simulated, replayed: false }
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
