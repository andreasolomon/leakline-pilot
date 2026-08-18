import { randomBytes } from 'node:crypto'
import type { ClickUpRenewalRow, RenewalClientRecord, WorkspaceRecord } from './types.js'

export type RenewalImportResult = {
  created: number
  updated: number
  unchanged: number
}

export function upsertClickUpRenewalClients(workspace: WorkspaceRecord, rows: ClickUpRenewalRow[], now = new Date().toISOString()): RenewalImportResult {
  const result: RenewalImportResult = { created: 0, updated: 0, unchanged: 0 }
  const seenTaskIds = new Set<string>()
  const seenEmails = new Set<string>()

  for (const row of rows) {
    const emailKey = row.email?.toLowerCase()
    if (seenTaskIds.has(row.clickUpTaskId) || emailKey && seenEmails.has(emailKey)) {
      throw new Error('The ClickUp import contains duplicate client records.')
    }
    seenTaskIds.add(row.clickUpTaskId)
    if (emailKey) seenEmails.add(emailKey)

    const existing = workspace.renewalClients.find((client) => client.clickUpTaskId === row.clickUpTaskId)
      ?? (emailKey ? workspace.renewalClients.find((client) => client.email?.toLowerCase() === emailKey) : undefined)
    if (!existing) {
      workspace.renewalClients.push({
        id: `renewal-${randomBytes(8).toString('hex')}`,
        name: row.name,
        email: row.email,
        phone: row.phone,
        owner: 'Yonas',
        firstWebinarAt: row.firstWebinarAt,
        lastWebinarAt: row.lastWebinarAt,
        nextWebinarAt: row.nextWebinarAt,
        webinarsHosted: row.webinarsHosted,
        renewalStatus: 'not_started',
        expectedRenewalValue: 8_000,
        renewalCashCollected: 0,
        outreachStatus: 'paused',
        outreachStatusReason: 'Awaiting the approved Launch Webinars campaign list.',
        outreach: [],
        source: 'clickup',
        clickUpTaskId: row.clickUpTaskId,
        clickUpStatus: row.clickUpStatus,
        createdAt: now,
        updatedAt: now,
      })
      result.created += 1
      continue
    }

    const sourceFields = {
      name: row.name,
      email: row.email,
      phone: row.phone,
      firstWebinarAt: row.firstWebinarAt,
      lastWebinarAt: row.lastWebinarAt,
      nextWebinarAt: row.nextWebinarAt,
      webinarsHosted: row.webinarsHosted,
      source: 'clickup' as const,
      clickUpTaskId: row.clickUpTaskId,
      clickUpStatus: row.clickUpStatus,
    }
    const changed = Object.entries(sourceFields).some(([key, value]) => existing[key as keyof RenewalClientRecord] !== value)
    if (changed) {
      Object.assign(existing, sourceFields, { updatedAt: now })
      result.updated += 1
    } else result.unchanged += 1
  }

  return result
}
