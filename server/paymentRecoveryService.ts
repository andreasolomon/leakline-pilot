import type { EncryptedStore } from './store.js'
import type { PublicUser } from './authService.js'
import type { PaymentRecoveryClassification, RecoveryAttemptChannel } from './types.js'
import type { PaymentRecoveryRepository } from './paymentRecoveryRepository.js'
import { promiseConfirmationDraft, renderRecoveryMessage } from './paymentRecovery.js'
import { sendHighLevelRecoveryMessage } from './providers.js'

function assertSafeOutboundMessage(body: string) {
  if (body.includes('[secure payment link unavailable]') || /\{\{[^}]+\}\}/.test(body)) throw new Error('This message still contains an unresolved placeholder. Add a verified provider-hosted payment link before sending.')
}

export class PaymentRecoveryService {
  constructor(private readonly store: EncryptedStore, private readonly repository: PaymentRecoveryRepository, private readonly fetcher: typeof fetch = fetch) {}

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

  async send(workspaceId: string, caseId: string, channel: 'sms' | 'email', approved: boolean, actor: PublicUser) {
    if (!approved) throw new Error('Review and approve the exact message before sending.')
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    if (!workspace) throw new Error('Workspace not found.')
    if (!workspace.recoveryPolicy.templatesApprovedAt) throw new Error('Approve this workspace’s recovery templates before sending.')
    const recoveryCase = await this.repository.getCase(workspaceId, caseId)
    if (recoveryCase.classification === 'human_review') throw new Error('Routine outreach is paused for this case. Complete the human review first.')
    if (recoveryCase.attempts.filter((attempt) => attempt.direction === 'outbound').length >= workspace.recoveryPolicy.maxTouches) throw new Error('This case reached the workspace touch limit and needs human review.')
    const preview = await this.preview(workspaceId, caseId, channel)
    assertSafeOutboundMessage(preview.body)
    const simulated = recoveryCase.sourcePaymentId.includes('_sample_') || workspace.connections.highlevel?.mode === 'sandbox'
    let providerMessageId: string | undefined
    if (!simulated) {
      const credential = workspace.credentials.highlevel
      if (!credential) throw new Error('Connect GoHighLevel before sending live SMS or email.')
      if (!recoveryCase.contactId) throw new Error('Match this payment customer to a GoHighLevel contact before sending.')
      const sent = await sendHighLevelRecoveryMessage(credential, { contactId: recoveryCase.contactId, channel, body: preview.body, subject: preview.subject, fromEmail: workspace.recoveryPolicy.senderEmail, fromNumber: workspace.recoveryPolicy.senderPhone }, this.fetcher)
      providerMessageId = sent.messageId
    }
    let updated = await this.repository.addAttempt(workspaceId, caseId, {
      channel,
      direction: 'outbound',
      summary: `${channel.toUpperCase()} recovery message ${simulated ? 'simulated' : 'sent through GoHighLevel'}.`,
      body: preview.body,
      providerMessageId,
      simulated,
      createdBy: actor.name || actor.email,
    })
    if (updated.attempts.filter((attempt) => attempt.direction === 'outbound').length >= workspace.recoveryPolicy.maxTouches) updated = await this.repository.updateCase(workspaceId, caseId, { status: 'human_intervention', escalationReason: `Reached the workspace limit of ${workspace.recoveryPolicy.maxTouches} routine recovery touches.` }, actor.name || actor.email)
    return { case: updated, simulated }
  }

  async sendSuggestion(workspaceId: string, caseId: string, suggestionId: string, input: { body: string; subject?: string; approved: boolean }, actor: PublicUser) {
    if (!input.approved) throw new Error('Review and approve the exact assisted response before sending.')
    const state = await this.store.read()
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    if (!workspace) throw new Error('Workspace not found.')
    const recoveryCase = await this.repository.getCase(workspaceId, caseId)
    const suggestion = recoveryCase.suggestions.find((item) => item.id === suggestionId)
    if (!suggestion || suggestion.status !== 'draft') throw new Error('This assisted response is no longer available to send.')
    if (recoveryCase.status === 'human_intervention') throw new Error('Routine outreach is paused for this case. Complete the human review first.')
    if (recoveryCase.attempts.filter((attempt) => attempt.direction === 'outbound').length >= workspace.recoveryPolicy.maxTouches) throw new Error('This case reached the workspace touch limit and needs human review.')
    assertSafeOutboundMessage(input.body)
    const simulated = recoveryCase.sourcePaymentId.includes('_sample_') || workspace.connections.highlevel?.mode === 'sandbox'
    let providerMessageId: string | undefined
    if (!simulated) {
      const credential = workspace.credentials.highlevel
      if (!credential) throw new Error('Connect GoHighLevel before sending a live assisted response.')
      if (!recoveryCase.contactId) throw new Error('Match this payment customer to a GoHighLevel contact before sending.')
      const sent = await sendHighLevelRecoveryMessage(credential, { contactId: recoveryCase.contactId, channel: suggestion.channel, body: input.body, subject: input.subject, fromEmail: workspace.recoveryPolicy.senderEmail, fromNumber: workspace.recoveryPolicy.senderPhone }, this.fetcher)
      providerMessageId = sent.messageId
    }
    await this.repository.addAttempt(workspaceId, caseId, { channel: suggestion.channel, direction: 'outbound', summary: `${suggestion.followUpId ? 'Follow-up' : 'Assisted reply'} ${simulated ? 'simulated' : 'sent through GoHighLevel'}.`, body: input.body, providerMessageId, simulated, createdBy: actor.name || actor.email })
    const updated = await this.repository.updateSuggestion(workspaceId, caseId, suggestionId, { status: 'sent', body: input.body, subject: input.subject })
    return { case: updated, simulated }
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
