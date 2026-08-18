import { randomBytes } from 'node:crypto'
import type { EncryptedStore } from './store.js'
import type { PublicUser } from './authService.js'
import type { PaymentRecoveryClassification, RecoveryAttemptChannel, RecoveryAttemptRecord, WorkspaceRecord } from './types.js'
import type { PaymentRecoveryRepository } from './paymentRecoveryRepository.js'
import { promiseConfirmationDraft, refreshRecoveryWorkflow, renderRecoveryMessage } from './paymentRecovery.js'
import { listQuoMessages, sendHighLevelRecoveryMessage, sendQuoMessage } from './providers.js'
import { safeErrorMessage } from './safety.js'

function assertSafeOutboundMessage(body: string) {
  if (body.includes('[secure payment link unavailable]') || /\{\{[^}]+\}\}/.test(body)) throw new Error('This message still contains an unresolved placeholder. Add a verified provider-hosted payment link before sending.')
}

function countsAsDelivered(attempt: RecoveryAttemptRecord) {
  return attempt.direction === 'outbound' && attempt.deliveryStatus !== 'pending' && attempt.deliveryStatus !== 'failed'
}

function smsSuppressionReason(body: string) {
  const message = body.trim().toLowerCase()
  if (/\bwrong number\b/.test(message)) return 'The recipient reported that this is the wrong number.'
  if (/\b(stop|unsubscribe|remove me|do not contact|don['’]?t contact)\b/.test(message)) return 'The recipient asked not to receive further messages.'
  return undefined
}

export class PaymentRecoveryService {
  constructor(private readonly store: EncryptedStore, private readonly repository: PaymentRecoveryRepository, private readonly fetcher: typeof fetch = fetch) {}

  private isSimulated(workspace: WorkspaceRecord, sourcePaymentId: string, channel: 'sms' | 'email') {
    if (sourcePaymentId.includes('_sample_')) return true
    return channel === 'sms' ? workspace.connections.quo?.mode === 'sandbox' : workspace.connections.highlevel?.mode === 'sandbox'
  }

  private async assertSmsAllowed(workspace: WorkspaceRecord, phone: string) {
    if (!workspace.credentials.quo) return
    const messages = await listQuoMessages(workspace.credentials.quo, phone, this.fetcher)
    const reason = messages
      .filter((message) => message.direction === 'inbound')
      .map((message) => smsSuppressionReason(message.body))
      .find(Boolean)
    if (reason) throw new Error(reason)
  }

  private async reserveAttempt(workspaceId: string, caseId: string, input: Omit<RecoveryAttemptRecord, 'id' | 'createdAt' | 'deliveryStatus'> & { idempotencyKey: string }) {
    let reserved: RecoveryAttemptRecord | undefined
    let replayed = false
    await this.store.update((state) => {
      const recoveryCase = state.workspaces.find((workspace) => workspace.id === workspaceId && !workspace.archivedAt)?.paymentRecoveryCases.find((item) => item.id === caseId)
      if (!recoveryCase) throw new Error('Payment recovery case not found.')
      const existing = recoveryCase.attempts.find((attempt) => attempt.idempotencyKey === input.idempotencyKey)
      if (existing?.deliveryStatus === 'failed') throw new Error('The previous delivery failed. Review the error and try again as a new attempt.')
      if (existing) { reserved = existing; replayed = true; return }
      const createdAt = new Date().toISOString()
      reserved = { ...input, id: `attempt-${randomBytes(8).toString('hex')}`, deliveryStatus: 'pending', createdAt }
      recoveryCase.attempts.unshift(reserved)
      recoveryCase.updatedAt = createdAt
    })
    if (!reserved) throw new Error('Recovery delivery could not be reserved.')
    return { attempt: reserved, replayed }
  }

  private async finishAttempt(workspaceId: string, caseId: string, attemptId: string, input: { deliveryStatus: 'sent' | 'simulated' | 'failed'; summary: string; providerMessageId?: string; conversationId?: string; failureReason?: string; suggestion?: { id: string; body: string; subject?: string } }) {
    let updated: Awaited<ReturnType<PaymentRecoveryRepository['getCase']>> | undefined
    await this.store.update((state) => {
      const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
      const recoveryCase = workspace?.paymentRecoveryCases.find((item) => item.id === caseId)
      const attempt = recoveryCase?.attempts.find((item) => item.id === attemptId)
      if (!workspace || !recoveryCase || !attempt) throw new Error('Recovery delivery record not found.')
      const { suggestion: completedSuggestion, ...delivery } = input
      const completedAt = new Date().toISOString()
      Object.assign(attempt, delivery)
      if (input.deliveryStatus !== 'failed') {
        recoveryCase.lastOutboundAt = attempt.createdAt
        recoveryCase.conversationId = input.conversationId ?? recoveryCase.conversationId
        if (completedSuggestion) {
          const suggestion = recoveryCase.suggestions.find((item) => item.id === completedSuggestion.id)
          if (!suggestion) throw new Error('Assisted reply not found.')
          suggestion.status = 'sent'
          suggestion.body = completedSuggestion.body
          suggestion.subject = completedSuggestion.subject
          suggestion.updatedAt = completedAt
          if (suggestion.followUpId) {
            const followUp = recoveryCase.followUps.find((item) => item.id === suggestion.followUpId)
            if (followUp) { followUp.status = 'completed'; followUp.completedAt = completedAt }
          }
        }
      }
      recoveryCase.updatedAt = completedAt
      refreshRecoveryWorkflow(recoveryCase, workspace.recoveryPolicy, recoveryCase.updatedAt)
      updated = recoveryCase
    })
    return updated!
  }

  async preview(workspaceId: string, caseId: string, channel: 'sms' | 'email') {
    const snapshot = await this.repository.snapshot(workspaceId)
    const recoveryCase = await this.repository.getCase(workspaceId, caseId)
    const template = snapshot.policy.templates[recoveryCase.classification]
    return {
      channel,
      to: channel === 'sms' ? recoveryCase.customerPhone : recoveryCase.customerEmail,
      subject: channel === 'email' ? renderRecoveryMessage(template.emailSubject, recoveryCase, snapshot.policy) : undefined,
      body: renderRecoveryMessage(channel === 'sms' ? template.sms : template.emailBody, recoveryCase, snapshot.policy),
      approvedTemplate: Boolean(snapshot.policy.templatesApprovedAt),
      hostedPaymentUrl: recoveryCase.hostedPaymentUrl,
    }
  }

  async send(workspaceId: string, caseId: string, channel: 'sms' | 'email', approved: boolean, actor: PublicUser, idempotencyKey: string) {
    if (!approved) throw new Error('Review and approve the exact message before sending.')
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    if (!workspace) throw new Error('Workspace not found.')
    const recoveryCase = await this.repository.getCase(workspaceId, caseId)
    const existing = recoveryCase.attempts.find((attempt) => attempt.idempotencyKey === idempotencyKey)
    if (existing?.deliveryStatus === 'failed') throw new Error('The previous delivery failed. Review the error and try again as a new attempt.')
    if (existing) return { case: recoveryCase, simulated: existing.deliveryStatus === 'simulated', replayed: true }
    if (recoveryCase.attempts.some((attempt) => attempt.deliveryStatus === 'pending')) throw new Error('A recovery delivery is still pending. Verify the provider result before starting another send.')
    if (recoveryCase.classification === 'human_review') throw new Error('Routine outreach is paused for this case. Complete the human review first.')
    if (recoveryCase.attempts.filter(countsAsDelivered).length >= workspace.recoveryPolicy.maxTouches) throw new Error('This case reached the workspace touch limit and needs human review.')
    const preview = await this.preview(workspaceId, caseId, channel)
    assertSafeOutboundMessage(preview.body)
    const simulated = this.isSimulated(workspace, recoveryCase.sourcePaymentId, channel)
    if (!simulated && !workspace.recoveryPolicy.templatesApprovedAt) throw new Error('Approve this workspace’s recovery templates before sending.')
    let providerMessageId: string | undefined
    let conversationId: string | undefined
    if (!simulated && channel === 'sms') {
      if (channel === 'sms' && !workspace.credentials.quo) throw new Error('Connect Quo before sending live SMS.')
      if (channel === 'sms' && !recoveryCase.customerPhone) throw new Error('Add a customer phone number before sending SMS.')
      await this.assertSmsAllowed(workspace, recoveryCase.customerPhone!)
    }
    if (!simulated && channel === 'email') {
      if (channel === 'email' && !workspace.credentials.highlevel) throw new Error('Connect GoHighLevel before sending live email.')
      if (channel === 'email' && !recoveryCase.contactId) throw new Error('Match this payment customer to a GoHighLevel contact before sending email.')
    }
    const reservation = await this.reserveAttempt(workspaceId, caseId, {
      idempotencyKey,
      channel,
      direction: 'outbound',
      summary: `${channel.toUpperCase()} recovery message queued for delivery.`,
      body: preview.body,
      simulated,
      createdBy: actor.name || actor.email,
    })
    if (reservation.replayed) return { case: await this.repository.getCase(workspaceId, caseId), simulated: reservation.attempt.deliveryStatus === 'simulated', replayed: true }
    try {
      if (!simulated) {
      const sent = channel === 'sms'
        ? await sendQuoMessage(workspace.credentials.quo!, { to: recoveryCase.customerPhone!, body: preview.body }, this.fetcher)
        : await sendHighLevelRecoveryMessage(workspace.credentials.highlevel!, { contactId: recoveryCase.contactId!, channel: 'email', body: preview.body, subject: preview.subject, fromEmail: workspace.recoveryPolicy.senderEmail }, this.fetcher)
      providerMessageId = sent.messageId
        conversationId = sent.conversationId
      }
    } catch (error) {
      await this.finishAttempt(workspaceId, caseId, reservation.attempt.id, { deliveryStatus: 'failed', summary: `${channel.toUpperCase()} recovery message failed.`, failureReason: safeErrorMessage(error) })
      throw error
    }
    let updated = await this.finishAttempt(workspaceId, caseId, reservation.attempt.id, { deliveryStatus: simulated ? 'simulated' : 'sent', summary: `${channel.toUpperCase()} recovery message ${simulated ? 'simulated' : `sent through ${channel === 'sms' ? 'Quo' : 'GoHighLevel'}`}.`, providerMessageId, conversationId })
    if (updated.attempts.filter(countsAsDelivered).length >= workspace.recoveryPolicy.maxTouches) updated = await this.repository.updateCase(workspaceId, caseId, { status: 'human_intervention', escalationReason: `Reached the workspace limit of ${workspace.recoveryPolicy.maxTouches} routine recovery touches.` }, actor.name || actor.email)
    return { case: updated, simulated, replayed: false }
  }

  async sendSuggestion(workspaceId: string, caseId: string, suggestionId: string, input: { body: string; subject?: string; approved: boolean; idempotencyKey: string }, actor: PublicUser) {
    if (!input.approved) throw new Error('Review and approve the exact assisted response before sending.')
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    if (!workspace) throw new Error('Workspace not found.')
    const recoveryCase = await this.repository.getCase(workspaceId, caseId)
    const existing = recoveryCase.attempts.find((attempt) => attempt.idempotencyKey === input.idempotencyKey)
    if (existing?.deliveryStatus === 'failed') throw new Error('The previous delivery failed. Review the error and try again as a new attempt.')
    if (existing) return { case: recoveryCase, simulated: existing.deliveryStatus === 'simulated', replayed: true }
    if (recoveryCase.attempts.some((attempt) => attempt.deliveryStatus === 'pending')) throw new Error('A recovery delivery is still pending. Verify the provider result before starting another send.')
    const suggestion = recoveryCase.suggestions.find((item) => item.id === suggestionId)
    if (!suggestion || suggestion.status !== 'draft') throw new Error('This assisted response is no longer available to send.')
    if (recoveryCase.status === 'human_intervention') throw new Error('Routine outreach is paused for this case. Complete the human review first.')
    if (recoveryCase.attempts.filter(countsAsDelivered).length >= workspace.recoveryPolicy.maxTouches) throw new Error('This case reached the workspace touch limit and needs human review.')
    assertSafeOutboundMessage(input.body)
    const simulated = this.isSimulated(workspace, recoveryCase.sourcePaymentId, suggestion.channel)
    if (!simulated && !workspace.recoveryPolicy.templatesApprovedAt) throw new Error('Approve this workspace’s recovery templates before sending.')
    let providerMessageId: string | undefined
    let conversationId: string | undefined
    if (!simulated) {
      if (suggestion.channel === 'sms' && !workspace.credentials.quo) throw new Error('Connect Quo before sending a live assisted SMS response.')
      if (suggestion.channel === 'sms' && !recoveryCase.customerPhone) throw new Error('Add a customer phone number before sending SMS.')
      if (suggestion.channel === 'email' && !workspace.credentials.highlevel) throw new Error('Connect GoHighLevel before sending a live assisted email response.')
      if (suggestion.channel === 'email' && !recoveryCase.contactId) throw new Error('Match this payment customer to a GoHighLevel contact before sending email.')
      if (suggestion.channel === 'sms') await this.assertSmsAllowed(workspace, recoveryCase.customerPhone!)
    }
    const reservation = await this.reserveAttempt(workspaceId, caseId, { idempotencyKey: input.idempotencyKey, channel: suggestion.channel, direction: 'outbound', summary: `${suggestion.followUpId ? 'Follow-up' : 'Assisted reply'} queued for delivery.`, body: input.body, simulated, createdBy: actor.name || actor.email })
    if (reservation.replayed) return { case: await this.repository.getCase(workspaceId, caseId), simulated: reservation.attempt.deliveryStatus === 'simulated', replayed: true }
    try {
      if (!simulated) {
      const sent = suggestion.channel === 'sms'
        ? await sendQuoMessage(workspace.credentials.quo!, { to: recoveryCase.customerPhone!, body: input.body }, this.fetcher)
        : await sendHighLevelRecoveryMessage(workspace.credentials.highlevel!, { contactId: recoveryCase.contactId!, channel: 'email', body: input.body, subject: input.subject, fromEmail: workspace.recoveryPolicy.senderEmail }, this.fetcher)
      providerMessageId = sent.messageId
        conversationId = sent.conversationId
      }
    } catch (error) {
      await this.finishAttempt(workspaceId, caseId, reservation.attempt.id, { deliveryStatus: 'failed', summary: `${suggestion.followUpId ? 'Follow-up' : 'Assisted reply'} failed.`, failureReason: safeErrorMessage(error) })
      throw error
    }
    const updated = await this.finishAttempt(workspaceId, caseId, reservation.attempt.id, { deliveryStatus: simulated ? 'simulated' : 'sent', summary: `${suggestion.followUpId ? 'Follow-up' : 'Assisted reply'} ${simulated ? 'simulated' : `sent through ${suggestion.channel === 'sms' ? 'Quo' : 'GoHighLevel'}`}.`, providerMessageId, conversationId, suggestion: { id: suggestionId, body: input.body, subject: input.subject } })
    return { case: updated, simulated, replayed: false }
  }

  async recordAttempt(workspaceId: string, caseId: string, input: { channel: RecoveryAttemptChannel; direction: 'inbound' | 'outbound' | 'internal'; summary: string; body?: string }, actor: PublicUser) {
    return this.repository.addAttempt(workspaceId, caseId, { ...input, createdBy: actor.name || actor.email })
  }

  async recordPromiseFromSuggestion(workspaceId: string, caseId: string, suggestionId: string, input: { amount: number; dueAt: string; note?: string }, actor: PublicUser) {
    const snapshot = await this.repository.snapshot(workspaceId)
    const recoveryCase = await this.repository.getCase(workspaceId, caseId)
    const suggestion = recoveryCase.suggestions.find((item) => item.id === suggestionId)
    if (!suggestion || suggestion.status !== 'draft' || suggestion.intent !== 'promise_to_pay' || !suggestion.triggerAttemptId) throw new Error('This customer reply is not awaiting promise-to-pay details.')
    await this.repository.addPromise(workspaceId, caseId, { amount: input.amount, dueAt: input.dueAt, note: input.note, createdBy: actor.name || actor.email })
    const updatedCase = await this.repository.getCase(workspaceId, caseId)
    const body = promiseConfirmationDraft(updatedCase, snapshot.policy, input.amount, input.dueAt)
    const finalCase = await this.repository.updateSuggestion(workspaceId, caseId, suggestionId, { status: 'draft', body })
    return { case: finalCase, suggestion: finalCase.suggestions.find((item) => item.id === suggestionId)! }
  }

  static classifications(): PaymentRecoveryClassification[] {
    return ['retryable_failure', 'payment_method_required', 'authentication_required', 'secure_payment_link', 'human_review']
  }
}
