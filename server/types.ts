export type ProviderId = 'stripe' | 'highlevel' | 'google-calendar' | 'fathom'

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
export type HighLevelCredential = { accessToken: string; locationId: string }
export type FathomCredential = { apiKey: string }
export type GoogleCredential = { accessToken: string; refreshToken?: string; expiresAt: number; email?: string }

export type CredentialMap = {
  stripe: StripeCredential
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
  calls: CallRecord[]
  oauthStates: Partial<Record<ProviderId, { value: string; expiresAt: number }>>
  recoveryCases: RecoveryCaseRecord[]
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
  crm?: string
  suspectedLeak?: string
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
