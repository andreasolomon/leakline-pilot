export type ProviderId = 'stripe' | 'whop' | 'fanbasis' | 'highlevel' | 'google-calendar' | 'fathom' | 'clickup' | 'quo' | 'zoom'
export type PaymentProviderId = 'stripe' | 'whop' | 'fanbasis'

export type NormalizedRow = Record<string, string | number | boolean | null>

export type DatasetImport = {
  kind: 'leads' | 'appointments' | 'deals' | 'payments' | 'closers'
  fileName: string
  rows: NormalizedRow[]
  sourceRows: number
  issues: string[]
  mappedFields: string[]
  headers: string[]
  mapping: Record<string, string>
}

export type IntegrationWorkspace = Partial<Record<DatasetImport['kind'], DatasetImport>>

export type CallRecord = {
  id: string
  title: string
  startedAt: string | null
  owner: string
  participants: string[]
  transcript: string
  summary: string
  url: string
}

export type RecordCounts = Partial<Record<DatasetImport['kind'] | 'calls' | 'renewalClients' | 'coachingSessions' | 'coachingParticipants', number>>

export type ConnectionMeta = {
  connectedAt: string
  lastSyncAt?: string
  lastError?: string
  accountLabel?: string
  recordCounts?: RecordCounts
  mode?: 'live' | 'sandbox'
}

export type StripeCredential = { secretKey: string }
export type WhopCredential = { apiKey: string; companyId: string; sandbox: boolean }
export type FanBasisCredential = { webhookSecret: string; accountLabel: string }
export type HighLevelCredential = { accessToken: string; locationId: string }
export type FathomCredential = { apiKey: string }
export type GoogleCredential = { accessToken: string; refreshToken?: string; expiresAt: number; email?: string }
export type ClickUpCredential = { apiToken: string; listId: string }
export type QuoCredential = { apiKey: string; from: string; phoneNumberId?: string }
export type ZoomCredential = { accountId: string; clientId: string; clientSecret: string }

export type CredentialMap = {
  stripe: StripeCredential
  whop: WhopCredential
  fanbasis: FanBasisCredential
  highlevel: HighLevelCredential
  fathom: FathomCredential
  'google-calendar': GoogleCredential
  clickup: ClickUpCredential
  quo: QuoCredential
  zoom: ZoomCredential
}

export type StoreState = {
  workspaces: WorkspaceRecord[]
  credentials: Partial<{ [K in ProviderId]: CredentialMap[K] }>
  connections: Partial<Record<ProviderId, ConnectionMeta>>
  oauthConfig: Partial<Record<'google-calendar', { clientId: string; clientSecret: string }>>
  workspace: IntegrationWorkspace
  calls: CallRecord[]
  oauthStates: Partial<Record<ProviderId, { value: string; expiresAt: number }>>
  users: UserRecord[]
  sessions: SessionRecord[]
  invites: InviteRecord[]
  leadApplications: LeadApplicationRecord[]
  marketingEvents: MarketingEventRecord[]
}

export type WorkspaceIntegrationState = {
  credentials: Partial<{ [K in ProviderId]: CredentialMap[K] }>
  connections: Partial<Record<ProviderId, ConnectionMeta>>
  oauthConfig: Partial<Record<'google-calendar', { clientId: string; clientSecret: string }>>
  workspace: IntegrationWorkspace
  imports: IntegrationWorkspace
  calls: CallRecord[]
  oauthStates: Partial<Record<ProviderId, { value: string; expiresAt: number }>>
  recoveryCases: RecoveryCaseRecord[]
  paymentRecoveryCases: PaymentRecoveryCaseRecord[]
  recoveryPolicy: RecoveryPolicyRecord
  pilotValidation: PilotValidationRecord
  renewalClients: RenewalClientRecord[]
  clickUpRenewalImport?: ClickUpRenewalImportRecord
  kpiSnapshots: KpiSnapshotRecord[]
  highLevelKpi: HighLevelKpiState
  coachingAttendance: CoachingAttendanceState
}

export type CoachingAttendanceSettingsRecord = {
  meetingSeries: CoachingMeetingSeriesRecord[]
  meetingId?: string
  minimumMinutes: number
  requiredSessionsPerWeek: number
  teamEmails: string[]
  updatedAt?: string
  updatedBy?: string
}

export type CoachingMeetingSeriesRecord = {
  meetingId: string
  label: string
}

export type CoachingParticipantRecord = {
  id: string
  name: string
  email?: string
  joinTime?: string
  leaveTime?: string
  durationMinutes: number
  matchedClientId?: string
  matchType: 'email' | 'name' | 'unmatched' | 'team'
}

export type CoachingSessionRecord = {
  id: string
  meetingId: string
  topic: string
  startedAt: string
  participants: CoachingParticipantRecord[]
  syncedAt: string
}

export type CoachingAttendanceState = {
  settings: CoachingAttendanceSettingsRecord
  sessions: CoachingSessionRecord[]
}

export type HighLevelKpiOutcome = 'appointment_booked' | 'no_show' | 'rescheduled' | 'showed_started' | 'showed_not_converted'

export type HighLevelPipelineStageRecord = {
  pipelineId: string
  pipelineName: string
  stageId: string
  stageName: string
}

export type HighLevelOpportunitySyncRecord = {
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
}

export type HighLevelKpiOpportunityRecord = HighLevelOpportunitySyncRecord & {
  firstSeenAt: string
  lastSeenAt: string
}

export type HighLevelKpiStageEventRecord = HighLevelOpportunitySyncRecord & {
  id: string
  recordedAt: string
}

export type HighLevelKpiSettingsRecord = {
  pipelineId?: string
  stageMappings: Record<string, HighLevelKpiOutcome>
  updatedAt?: string
  updatedBy?: string
}

export type HighLevelKpiState = {
  settings: HighLevelKpiSettingsRecord
  stages: HighLevelPipelineStageRecord[]
  opportunities: HighLevelKpiOpportunityRecord[]
  stageEvents: HighLevelKpiStageEventRecord[]
}

export type RenewalStatus = 'not_started' | 'renewal_opportunity' | 'conversation_needed' | 'call_booked' | 'decision_pending' | 'renewed' | 'declined'
export type RenewalOutreachStatus = 'eligible' | 'paused' | 'do_not_contact'
export type RenewalOutreachKind = 'feedback_request' | 'renewal_invitation' | 'programme_check_in' | 'webinar_accountability' | 'renewal_window_review' | 'post_completion_review' | 'no_response_follow_up' | 'va_upsell_opener'
export type UpsellCampaignStage = 'not_contacted' | 'opener_sent' | 'replied' | 'interest_confirmed' | 'call_offered' | 'call_booked' | 'call_attended' | 'won' | 'lost'
export type UpsellCampaignTrackingRecord = {
  openerSentAt?: string
  repliedAt?: string
  interestConfirmedAt?: string
  callOfferedAt?: string
  callBookedAt?: string
  callAttendedAt?: string
  outcome?: 'won' | 'lost'
  outcomeAt?: string
  nonProceedReason?: string
  updatedAt?: string
  updatedBy?: string
}
export type RenewalOutreachActivityRecord = {
  id: string
  idempotencyKey?: string
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

export type RenewalClientRecord = {
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
  outreachStatus?: RenewalOutreachStatus
  outreachStatusReason?: string
  outreach?: RenewalOutreachActivityRecord[]
  upsellCampaign?: UpsellCampaignTrackingRecord
  createdAt: string
  updatedAt: string
}

export type ClickUpRenewalImportRecord = {
  fileName: string
  importedAt: string
  importedBy: string
  sourceRows: number
  acceptedRows: number
  created: number
  updated: number
  unchanged: number
}

export type ClickUpRenewalRow = {
  clickUpTaskId: string
  name: string
  email?: string
  phone?: string
  firstWebinarAt?: string
  lastWebinarAt?: string
  nextWebinarAt?: string
  webinarsHosted: number
  clickUpStatus?: string
}

export type KpiSnapshotRecord = {
  id: string
  periodStart: string
  periodEnd: string
  bookedCalls: number
  callsTaken: number
  deals: number
  refunds: number
  totalRevenue: number
  cashCollected: number
  financialsPending?: boolean
  notes?: string
  entries?: KpiCallEntryRecord[]
  source: 'manual' | 'clickup' | 'csv'
  createdAt: string
  updatedAt: string
}

export type KpiCallOutcome = 'full_pay' | 'split_pay' | 'deposit' | 'no_deposit_follow_up' | 'offer_didnt_buy' | 'bad_fit_no_offer' | 'no_show'

export type KpiCallEntryRecord = {
  id: string
  occurredOn: string
  personName: string
  outcome: KpiCallOutcome
  revenueValue: number
  cashCollected: number
  notes?: string
  createdAt: string
  createdBy: string
}

export type PaymentRecoveryClassification = 'retryable_failure' | 'payment_method_required' | 'authentication_required' | 'secure_payment_link' | 'human_review'
export type PaymentRecoveryStatus = 'retry_in_progress' | 'payment_method_required' | 'authentication_required' | 'secure_payment_link_required' | 'promise_pending' | 'human_intervention' | 'recovered' | 'closed_unrecovered'
export type RecoveryAttemptChannel = 'sms' | 'email' | 'call' | 'note'
export type RecoveryReplyIntent = 'payment_link' | 'promise_to_pay' | 'retry_request' | 'payment_method_update' | 'payment_question' | 'hardship' | 'dispute_or_refund' | 'wrong_contact' | 'opt_out' | 'already_paid' | 'unclear'
export type RecoverySuggestionStatus = 'draft' | 'sent' | 'dismissed' | 'escalated'
export type RecoveryFollowUpKind = 'no_response' | 'promise_due'

export type RecoveryAttemptRecord = {
  id: string
  idempotencyKey?: string
  channel: RecoveryAttemptChannel
  direction: 'outbound' | 'inbound' | 'internal'
  summary: string
  body?: string
  providerMessageId?: string
  conversationId?: string
  intent?: RecoveryReplyIntent
  simulated?: boolean
  deliveryStatus?: 'pending' | 'sent' | 'simulated' | 'failed' | 'received' | 'recorded'
  failureReason?: string
  createdAt: string
  createdBy: string
}

export type RecoveryReplySuggestionRecord = {
  id: string
  triggerAttemptId?: string
  followUpId?: string
  intent: RecoveryReplyIntent
  confidence: number
  recommendedAction: string
  channel: 'sms' | 'email'
  subject?: string
  body: string
  status: RecoverySuggestionStatus
  createdAt: string
  updatedAt: string
}

export type RecoveryFollowUpRecord = {
  id: string
  kind: RecoveryFollowUpKind
  channel: 'sms' | 'email'
  dueAt: string
  status: 'scheduled' | 'due' | 'completed' | 'cancelled'
  attemptNumber: number
  reason: string
  createdAt: string
  completedAt?: string
}

export type PromiseToPayRecord = {
  id: string
  amount: number
  dueAt: string
  note?: string
  status: 'pending' | 'kept' | 'missed' | 'cancelled'
  createdAt: string
  createdBy: string
}

export type RecoveryOutcomeRecord = {
  type: 'recovered' | 'closed_unrecovered'
  amount: number
  source: 'provider_sync' | 'manual'
  note?: string
  recordedAt: string
  recordedBy: string
}

export type RecoveryMessageTemplate = {
  sms: string
  emailSubject: string
  emailBody: string
}

export type RecoveryPolicyRecord = {
  businessName: string
  senderName: string
  senderEmail: string
  senderPhone: string
  defaultOwner: string
  timezone: string
  escalationDays: number
  maxTouches: number
  followUpDelaysHours: number[]
  promiseGraceHours: number
  tone: 'warm' | 'direct' | 'formal'
  templates: Record<PaymentRecoveryClassification, RecoveryMessageTemplate>
  templatesApprovedAt?: string
  templatesApprovedBy?: string
}

export type PilotValidationRecord = {
  monthlyFee: number
  startedAt?: string
  baselineWindowDays: number
  historicEligibleBalance: number
  historicRecoveredAmount: number
  onboardingMinutes: number
  supportMinutes: number
  renewalStatus: 'not_asked' | 'yes' | 'no' | 'undecided'
  notes: string
  updatedAt?: string
  updatedBy?: string
}

export type PaymentRecoveryCaseRecord = {
  id: string
  provider: PaymentProviderId
  sourcePaymentId: string
  sourceInvoiceId?: string
  sourcePaymentIntentId?: string
  dealId?: string
  customerId?: string
  contactId?: string
  customerName: string
  customerEmail?: string
  customerPhone?: string
  owner: string
  amountDue: number
  totalOutstanding: number
  currency: string
  dueAt?: string
  failureCode?: string
  failureReason?: string
  attemptCount: number
  nextRetryAt?: string
  hostedPaymentUrl?: string
  classification: PaymentRecoveryClassification
  status: PaymentRecoveryStatus
  priority: 'critical' | 'high' | 'medium'
  recommendedAction: string
  attempts: RecoveryAttemptRecord[]
  promises: PromiseToPayRecord[]
  suggestions: RecoveryReplySuggestionRecord[]
  followUps: RecoveryFollowUpRecord[]
  conversationId?: string
  lastInboundAt?: string
  lastOutboundAt?: string
  escalationReason?: string
  outcome?: RecoveryOutcomeRecord
  createdAt: string
  updatedAt: string
  recoveredAt?: string
}

export type RecoveryCaseStatus = 'detected' | 'assigned' | 'in_progress' | 'resolved'

export type RecoveryCaseRecord = {
  id: string
  leakId: number
  type: string
  title: string
  description: string
  impact: number
  affectedRecords: number
  severity: 'critical' | 'warning' | 'opportunity'
  status: RecoveryCaseStatus
  owner: string
  deadline?: string
  recoveredAmount: number
  resolution?: string
  actions: Array<{ id: string; text: string; completed: boolean; completedAt?: string; completedBy?: string }>
  notes: Array<{ id: string; text: string; createdAt: string; createdBy: string }>
  activity: Array<{ id: string; type: string; text: string; createdAt: string; createdBy: string }>
  createdAt: string
  updatedAt: string
  resolvedAt?: string
}

export type WorkspaceRecord = WorkspaceIntegrationState & {
  id: string
  name: string
  clientName: string
  createdAt: string
  createdBy?: string
  archivedAt?: string
}

export type ProviderStatus = {
  id: ProviderId
  label: string
  category: string
  description: string
  connected: boolean
  available: boolean
  mode?: 'live' | 'sandbox'
  connectedAt?: string
  lastSyncAt?: string
  lastError?: string
  accountLabel?: string
  recordCounts: RecordCounts
}

export type UserRecord = {
  id: string
  name: string
  email: string
  role: 'owner' | 'admin' | 'manager' | 'viewer'
  status: 'active' | 'disabled'
  passwordHash: string
  passwordSalt: string
  createdAt: string
  lastLoginAt?: string
  createdBy?: string
  disabledAt?: string
  workspaceIds?: string[]
  defaultWorkspaceId?: string
}

export type InviteRecord = {
  id: string
  email: string
  role: 'admin' | 'manager' | 'viewer'
  workspaceIds: string[]
  tokenHash: string
  createdBy: string
  createdAt: string
  expiresAt: string
  acceptedAt?: string
  acceptedBy?: string
  revokedAt?: string
  revokedBy?: string
}

export type LeadApplicationRecord = {
  id: string
  name: string
  email: string
  phone?: string
  company: string
  website?: string
  role?: string
  monthlyBookedCalls?: string
  offerPrice?: string
  monthlyOverdueVolume?: string
  monthlyFailedPayments?: string
  paymentProvider?: string
  crm?: string
  suspectedLeak?: string
  currentRecoveryProcess?: string
  notes?: string
  source: 'landing-page'
  status: 'new' | 'qualified'
  createdAt: string
  qualifiedAt?: string
}

export type MarketingEventName = 'page_view' | 'apply_click' | 'vsl_click' | 'sample_report_click' | 'client_login_click' | 'application_details_submitted' | 'application_completed'

export type MarketingEventRecord = {
  id: string
  event: MarketingEventName
  path: string
  createdAt: string
  leadId?: string
}

export type SessionRecord = {
  idHash: string
  userId: string
  createdAt: string
  expiresAt: number
  activeWorkspaceId?: string
}
