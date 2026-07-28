export type ProviderId = 'stripe' | 'whop' | 'fanbasis' | 'highlevel' | 'google-calendar' | 'fathom'
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

export type RecordCounts = Partial<Record<DatasetImport['kind'] | 'calls', number>>

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

export type CredentialMap = {
  stripe: StripeCredential
  whop: WhopCredential
  fanbasis: FanBasisCredential
  highlevel: HighLevelCredential
  fathom: FathomCredential
  'google-calendar': GoogleCredential
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
}

export type RenewalStatus = 'not_started' | 'renewal_opportunity' | 'conversation_needed' | 'call_booked' | 'decision_pending' | 'renewed' | 'declined'

export type RenewalClientRecord = {
  id: string
  name: string
  email?: string
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
  notes?: string
  source: 'manual' | 'clickup'
  createdAt: string
  updatedAt: string
}

export type PaymentRecoveryClassification = 'retryable_failure' | 'payment_method_required' | 'authentication_required' | 'secure_payment_link' | 'human_review'
export type PaymentRecoveryStatus = 'retry_in_progress' | 'payment_method_required' | 'authentication_required' | 'secure_payment_link_required' | 'promise_pending' | 'human_intervention' | 'recovered' | 'closed_unrecovered'
export type RecoveryAttemptChannel = 'sms' | 'email' | 'call' | 'note'
export type RecoveryReplyIntent = 'payment_link' | 'promise_to_pay' | 'retry_request' | 'payment_method_update' | 'payment_question' | 'hardship' | 'dispute_or_refund' | 'wrong_contact' | 'opt_out' | 'already_paid' | 'unclear'
export type RecoverySuggestionStatus = 'draft' | 'sent' | 'dismissed' | 'escalated'
export type RecoveryFollowUpKind = 'no_response' | 'promise_due'

export type RecoveryAttemptRecord = {
  id: string
  channel: RecoveryAttemptChannel
  direction: 'outbound' | 'inbound' | 'internal'
  summary: string
  body?: string
  providerMessageId?: string
  conversationId?: string
  intent?: RecoveryReplyIntent
  simulated?: boolean
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
