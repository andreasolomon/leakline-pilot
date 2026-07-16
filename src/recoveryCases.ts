export type RecoveryCaseStatus = 'detected' | 'assigned' | 'in_progress' | 'resolved'

export type RecoveryCase = {
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

export type RecoveryCaseUpdate = {
  status?: RecoveryCaseStatus
  owner?: string
  deadline?: string | null
  recoveredAmount?: number
  resolution?: string
  actionId?: string
  actionCompleted?: boolean
  note?: string
}

export const recoveryStatusLabels: Record<RecoveryCaseStatus, string> = {
  detected: 'Detected',
  assigned: 'Assigned',
  in_progress: 'In progress',
  resolved: 'Resolved',
}

export async function recoveryCaseRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'Recovery case request failed.')
  return payload as T
}
