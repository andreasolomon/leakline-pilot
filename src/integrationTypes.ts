import type { ImportWorkspace } from './csvEngine'

export type ProviderId = 'stripe' | 'highlevel' | 'google-calendar' | 'fathom'

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
  recordCounts: Record<string, number>
}

export type IntegrationSnapshot = {
  workspace: ImportWorkspace
  calls: Array<{ id: string }>
  statuses: ProviderStatus[]
}
