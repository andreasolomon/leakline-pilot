import { randomBytes } from 'node:crypto'
import type { EncryptedStore } from './store.js'
import type { PaymentRecoveryCaseRecord, PaymentRecoveryStatus, PilotValidationRecord, PromiseToPayRecord, RecoveryAttemptRecord, RecoveryPolicyRecord, RecoveryReplySuggestionRecord, StoreState, WorkspaceRecord } from './types.js'
import { classifyRecoveryReply, followUpDraft, reconcilePaymentRecoveryCases, recoveryReport, refreshRecoveryWorkflow, samplePaymentRecoveryCases, suggestedReplyForIntent } from './paymentRecovery.js'

export interface PaymentRecoveryRepository {
  snapshot(workspaceId: string): Promise<{ cases: PaymentRecoveryCaseRecord[]; policy: RecoveryPolicyRecord; pilotValidation: PilotValidationRecord; report: ReturnType<typeof recoveryReport>; sources: Array<{ id: string; connected: boolean; mode?: string }> }>
  reconcile(workspaceId: string): Promise<void>
  seedSample(workspaceId: string, actor: string): Promise<void>
  updatePolicy(workspaceId: string, policy: RecoveryPolicyRecord, actor: string, approve: boolean): Promise<void>
  updatePilotValidation(workspaceId: string, validation: PilotValidationRecord, actor: string): Promise<void>
  processDue(workspaceId: string, now?: string): Promise<void>
  getCase(workspaceId: string, caseId: string): Promise<PaymentRecoveryCaseRecord>
  addAttempt(workspaceId: string, caseId: string, attempt: Omit<RecoveryAttemptRecord, 'id' | 'createdAt'>): Promise<PaymentRecoveryCaseRecord>
  addPromise(workspaceId: string, caseId: string, promise: Omit<PromiseToPayRecord, 'id' | 'createdAt' | 'status'>): Promise<PaymentRecoveryCaseRecord>
  prepareFollowUp(workspaceId: string, caseId: string, followUpId: string): Promise<RecoveryReplySuggestionRecord>
  updateSuggestion(workspaceId: string, caseId: string, suggestionId: string, input: { status: RecoveryReplySuggestionRecord['status']; body?: string; subject?: string }): Promise<PaymentRecoveryCaseRecord>
  updateCase(workspaceId: string, caseId: string, input: { status?: PaymentRecoveryStatus; owner?: string; escalationReason?: string; recoveredAmount?: number; note?: string }, actor: string): Promise<PaymentRecoveryCaseRecord>
}

export class EncryptedPaymentRecoveryRepository implements PaymentRecoveryRepository {
  constructor(private readonly store: EncryptedStore) {}

  private workspace(state: StoreState, workspaceId: string): WorkspaceRecord {
    const workspace = state.workspaces.find((item) => item.id === workspaceId && !item.archivedAt)
    if (!workspace) throw new Error('Workspace not found.')
    return workspace
  }

  async snapshot(workspaceId: string) {
    await this.processDue(workspaceId)
    const state = await this.store.read()
    const workspace = this.workspace(state, workspaceId)
    const cases = [...workspace.paymentRecoveryCases].sort((left, right) => {
      const statusWeight = (value: PaymentRecoveryStatus) => value === 'recovered' || value === 'closed_unrecovered' ? 1 : 0
      return statusWeight(left.status) - statusWeight(right.status) || right.amountDue - left.amountDue
    })
    return {
      cases,
      policy: workspace.recoveryPolicy,
      pilotValidation: workspace.pilotValidation,
      report: recoveryReport(cases),
      sources: (['stripe', 'whop', 'fanbasis'] as const).map((id) => ({ id, connected: Boolean(workspace.credentials[id]) || workspace.connections[id]?.mode === 'sandbox', mode: workspace.connections[id]?.mode, sample: cases.some((item) => item.provider === id && item.sourcePaymentId.includes('_sample_')) })),
    }
  }

  async reconcile(workspaceId: string) {
    await this.store.update((state) => { reconcilePaymentRecoveryCases(this.workspace(state, workspaceId)) })
  }

  async seedSample(workspaceId: string, _actor: string) {
    await this.store.update((state) => {
      const workspace = this.workspace(state, workspaceId)
      const hasRealCases = workspace.paymentRecoveryCases.some((recoveryCase) => !recoveryCase.sourcePaymentId.includes('_sample_'))
      const hasLivePaymentSource = (['stripe', 'whop', 'fanbasis'] as const).some((provider) => Boolean(workspace.credentials[provider]) || workspace.connections[provider]?.mode === 'live')
      if (hasRealCases || hasLivePaymentSource) throw new Error('Sample recovery data cannot replace live payment recovery data.')
      workspace.paymentRecoveryCases = samplePaymentRecoveryCases(workspace.recoveryPolicy)
    })
  }

  async updatePolicy(workspaceId: string, policy: RecoveryPolicyRecord, actor: string, approve: boolean) {
    await this.store.update((state) => {
      const workspace = this.workspace(state, workspaceId)
      workspace.recoveryPolicy = {
        ...policy,
        templatesApprovedAt: approve ? new Date().toISOString() : undefined,
        templatesApprovedBy: approve ? actor : undefined,
      }
    })
  }

  async updatePilotValidation(workspaceId: string, validation: PilotValidationRecord, actor: string) {
    await this.store.update((state) => {
      this.workspace(state, workspaceId).pilotValidation = {
        ...validation,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      }
    })
  }

  async processDue(workspaceId: string, now = new Date().toISOString()) {
    await this.store.update((state) => {
      const workspace = this.workspace(state, workspaceId)
      for (const recoveryCase of workspace.paymentRecoveryCases) refreshRecoveryWorkflow(recoveryCase, workspace.recoveryPolicy, now)
    })
  }

  async getCase(workspaceId: string, caseId: string) {
    const state = await this.store.read()
    const recoveryCase = this.workspace(state, workspaceId).paymentRecoveryCases.find((item) => item.id === caseId)
    if (!recoveryCase) throw new Error('Payment recovery case not found.')
    return recoveryCase
  }

  async addAttempt(workspaceId: string, caseId: string, input: Omit<RecoveryAttemptRecord, 'id' | 'createdAt'>) {
    let updated: PaymentRecoveryCaseRecord | undefined
    await this.store.update((state) => {
      const workspace = this.workspace(state, workspaceId)
      const recoveryCase = workspace.paymentRecoveryCases.find((item) => item.id === caseId)
      if (!recoveryCase) throw new Error('Payment recovery case not found.')
      if (input.idempotencyKey && recoveryCase.attempts.some((attempt) => attempt.idempotencyKey === input.idempotencyKey)) { updated = recoveryCase; return }
      if (input.providerMessageId && recoveryCase.attempts.some((attempt) => attempt.providerMessageId === input.providerMessageId)) { updated = recoveryCase; return }
      const createdAt = new Date().toISOString()
      const attempt: RecoveryAttemptRecord = { ...input, id: `attempt-${randomBytes(8).toString('hex')}`, createdAt }
      if (input.direction === 'inbound') {
        const analysis = classifyRecoveryReply(input.body || input.summary)
        attempt.intent = analysis.intent
        recoveryCase.lastInboundAt = createdAt
        recoveryCase.conversationId = input.conversationId ?? recoveryCase.conversationId
        recoveryCase.followUps = (recoveryCase.followUps ?? []).map((followUp) => followUp.kind === 'no_response' && ['scheduled', 'due'].includes(followUp.status) ? { ...followUp, status: 'cancelled', completedAt: createdAt } : followUp)
        const channel = input.channel === 'email' ? 'email' : 'sms'
        recoveryCase.suggestions ??= []
        recoveryCase.suggestions.unshift({ id: `suggestion-${randomBytes(8).toString('hex')}`, triggerAttemptId: attempt.id, intent: analysis.intent, confidence: analysis.confidence, recommendedAction: analysis.recommendedAction, channel, subject: channel === 'email' ? `Re: your ${workspace.recoveryPolicy.businessName} payment` : undefined, body: suggestedReplyForIntent(analysis.intent, recoveryCase, workspace.recoveryPolicy), status: analysis.pauseRoutine ? 'escalated' : 'draft', createdAt, updatedAt: createdAt })
        if (analysis.pauseRoutine) { recoveryCase.status = 'human_intervention'; recoveryCase.escalationReason = analysis.recommendedAction }
      } else if (input.direction === 'outbound' && input.deliveryStatus !== 'pending' && input.deliveryStatus !== 'failed') recoveryCase.lastOutboundAt = createdAt
      recoveryCase.attempts.unshift(attempt)
      recoveryCase.updatedAt = createdAt
      refreshRecoveryWorkflow(recoveryCase, workspace.recoveryPolicy, createdAt)
      updated = recoveryCase
    })
    return updated!
  }

  async addPromise(workspaceId: string, caseId: string, input: Omit<PromiseToPayRecord, 'id' | 'createdAt' | 'status'>) {
    let updated: PaymentRecoveryCaseRecord | undefined
    await this.store.update((state) => {
      const recoveryCase = this.workspace(state, workspaceId).paymentRecoveryCases.find((item) => item.id === caseId)
      if (!recoveryCase) throw new Error('Payment recovery case not found.')
      if (input.amount > recoveryCase.amountDue) throw new Error('A promise cannot exceed the outstanding instalment amount.')
      if (!Number.isFinite(Date.parse(input.dueAt))) throw new Error('Choose a valid promise date.')
      const createdAt = new Date().toISOString()
      recoveryCase.promises = recoveryCase.promises.map((promise) => promise.status === 'pending' ? { ...promise, status: 'cancelled' } : promise)
      const cancelledFollowUpIds = new Set(recoveryCase.followUps.filter((followUp) => followUp.kind === 'promise_due' && ['scheduled', 'due'].includes(followUp.status)).map((followUp) => followUp.id))
      recoveryCase.followUps = recoveryCase.followUps.map((followUp) => cancelledFollowUpIds.has(followUp.id) ? { ...followUp, status: 'cancelled', completedAt: createdAt } : followUp)
      recoveryCase.suggestions = recoveryCase.suggestions.map((suggestion) => suggestion.followUpId && cancelledFollowUpIds.has(suggestion.followUpId) && suggestion.status === 'draft' ? { ...suggestion, status: 'dismissed', updatedAt: createdAt } : suggestion)
      recoveryCase.promises.unshift({ ...input, id: `promise-${randomBytes(8).toString('hex')}`, status: 'pending', createdAt })
      recoveryCase.status = 'promise_pending'
      recoveryCase.updatedAt = createdAt
      refreshRecoveryWorkflow(recoveryCase, this.workspace(state, workspaceId).recoveryPolicy, recoveryCase.updatedAt)
      updated = recoveryCase
    })
    return updated!
  }

  async prepareFollowUp(workspaceId: string, caseId: string, followUpId: string) {
    let suggestion: RecoveryReplySuggestionRecord | undefined
    await this.store.update((state) => {
      const workspace = this.workspace(state, workspaceId)
      const recoveryCase = workspace.paymentRecoveryCases.find((item) => item.id === caseId)
      if (!recoveryCase) throw new Error('Payment recovery case not found.')
      refreshRecoveryWorkflow(recoveryCase, workspace.recoveryPolicy)
      const followUp = recoveryCase.followUps.find((item) => item.id === followUpId)
      if (!followUp || followUp.status !== 'due') throw new Error('This follow-up is no longer due.')
      suggestion = recoveryCase.suggestions.find((item) => item.followUpId === followUpId && item.status === 'draft')
      if (suggestion) return
      const createdAt = new Date().toISOString()
      suggestion = { id: `suggestion-${randomBytes(8).toString('hex')}`, followUpId, intent: followUp.kind === 'promise_due' ? 'promise_to_pay' : 'unclear', confidence: 1, recommendedAction: followUp.kind === 'promise_due' ? 'Confirm whether the promised payment was completed before sending this reminder.' : 'Send the next approved no-response follow-up.', channel: followUp.channel, subject: followUp.channel === 'email' ? `Follow-up on your ${workspace.recoveryPolicy.businessName} payment` : undefined, body: followUpDraft(recoveryCase, workspace.recoveryPolicy, followUp), status: 'draft', createdAt, updatedAt: createdAt }
      recoveryCase.suggestions.unshift(suggestion)
      recoveryCase.updatedAt = createdAt
    })
    return suggestion!
  }

  async updateSuggestion(workspaceId: string, caseId: string, suggestionId: string, input: { status: RecoveryReplySuggestionRecord['status']; body?: string; subject?: string }) {
    let updated: PaymentRecoveryCaseRecord | undefined
    await this.store.update((state) => {
      const recoveryCase = this.workspace(state, workspaceId).paymentRecoveryCases.find((item) => item.id === caseId)
      if (!recoveryCase) throw new Error('Payment recovery case not found.')
      const suggestion = recoveryCase.suggestions.find((item) => item.id === suggestionId)
      if (!suggestion) throw new Error('Assisted reply not found.')
      suggestion.status = input.status
      if (input.body !== undefined) suggestion.body = input.body
      if (input.subject !== undefined) suggestion.subject = input.subject
      suggestion.updatedAt = new Date().toISOString()
      if (suggestion.followUpId && input.status === 'sent') {
        const followUp = recoveryCase.followUps.find((item) => item.id === suggestion.followUpId)
        if (followUp) { followUp.status = 'completed'; followUp.completedAt = suggestion.updatedAt }
      }
      recoveryCase.updatedAt = suggestion.updatedAt
      updated = recoveryCase
    })
    return updated!
  }

  async updateCase(workspaceId: string, caseId: string, input: { status?: PaymentRecoveryStatus; owner?: string; escalationReason?: string; recoveredAmount?: number; note?: string }, actor: string) {
    let updated: PaymentRecoveryCaseRecord | undefined
    await this.store.update((state) => {
      const recoveryCase = this.workspace(state, workspaceId).paymentRecoveryCases.find((item) => item.id === caseId)
      if (!recoveryCase) throw new Error('Payment recovery case not found.')
      if (input.owner !== undefined) recoveryCase.owner = input.owner.trim()
      if (input.escalationReason !== undefined) recoveryCase.escalationReason = input.escalationReason.trim() || undefined
      if (input.status !== undefined) recoveryCase.status = input.status
      if (input.status === 'recovered') {
        const amount = Math.min(input.recoveredAmount ?? recoveryCase.amountDue, recoveryCase.amountDue)
        recoveryCase.outcome = { type: 'recovered', amount, source: 'manual', note: input.note, recordedAt: new Date().toISOString(), recordedBy: actor }
        recoveryCase.recoveredAt = new Date().toISOString()
      } else if (input.status === 'closed_unrecovered') {
        recoveryCase.outcome = { type: 'closed_unrecovered', amount: 0, source: 'manual', note: input.note, recordedAt: new Date().toISOString(), recordedBy: actor }
        recoveryCase.recoveredAt = undefined
      } else if (input.status !== undefined) {
        recoveryCase.outcome = undefined
        recoveryCase.recoveredAt = undefined
      }
      recoveryCase.updatedAt = new Date().toISOString()
      refreshRecoveryWorkflow(recoveryCase, this.workspace(state, workspaceId).recoveryPolicy, recoveryCase.updatedAt)
      updated = recoveryCase
    })
    return updated!
  }
}
