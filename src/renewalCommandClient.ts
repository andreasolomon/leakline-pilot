import type { RenewalClient, RenewalClientInput } from './renewalCommand'

export async function renewalApi<T>(path = '/api/renewal-clients', init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`)
  return body
}

export const emptyRenewalClient = (): RenewalClientInput => ({
  name: '',
  email: '',
  owner: 'Client success manager',
  enrolledAt: undefined,
  firstWebinarAt: undefined,
  lastWebinarAt: undefined,
  nextWebinarAt: undefined,
  webinarsHosted: 0,
  feedbackScore: undefined,
  feedbackNote: '',
  renewalCallAt: undefined,
  renewalStatus: 'not_started',
  expectedRenewalValue: 0,
  renewalCashCollected: 0,
  nextAction: '',
})

export function inputFromRenewalClient(client: RenewalClient): RenewalClientInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, source: _source, clickUpTaskId: _clickUpTaskId, clickUpStatus: _clickUpStatus, crmContactId: _crmContactId, outreach: _outreach, ...input } = client
  return input
}
