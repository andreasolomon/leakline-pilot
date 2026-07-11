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
}

export type WorkspaceIntegrationState = {
  credentials: Partial<{ [K in ProviderId]: CredentialMap[K] }>
  connections: Partial<Record<ProviderId, ConnectionMeta>>
  oauthConfig: Partial<Record<'google-calendar', { clientId: string; clientSecret: string }>>
  workspace: IntegrationWorkspace
  calls: CallRecord[]
  oauthStates: Partial<Record<ProviderId, { value: string; expiresAt: number }>>
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
  role: 'admin' | 'member'
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

export type SessionRecord = {
  idHash: string
  userId: string
  createdAt: string
  expiresAt: number
  activeWorkspaceId?: string
}
