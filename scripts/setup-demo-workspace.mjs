import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EncryptedStore } from '../server-dist/store.js'
import { sandboxSync } from '../server-dist/sandbox.js'
import { demoSnapshot, detectLeaks } from '../src/leakEngine.ts'

const root = process.cwd()
const dataDirectory = process.env.LEAKLINE_DATA_DIR || join(root, '.data')
const workspaceId = 'workspace-leakline-demo'
const now = new Date().toISOString()
const demoLeaks = detectLeaks(demoSnapshot)

const statePath = join(dataDirectory, 'integrations.enc')
const keyPath = join(dataDirectory, 'local.key')
const backupDirectory = join(dataDirectory, 'backups', now.replaceAll(':', '-').replaceAll('.', '-'))

await mkdir(backupDirectory, { recursive: true })
if (existsSync(statePath)) await copyFile(statePath, join(backupDirectory, 'integrations.enc'))
if (existsSync(keyPath)) await copyFile(keyPath, join(backupDirectory, 'local.key'))

const fathom = await sandboxSync('fathom')
const store = new EncryptedStore(dataDirectory)

await store.update((state) => {
  let workspace = state.workspaces.find((item) => item.id === workspaceId)
  if (!workspace) {
    workspace = {
      id: workspaceId,
      name: 'Ascend Demo',
      clientName: 'Ascend Growth Partners · Demo',
      createdAt: now,
      credentials: {},
      connections: {},
      oauthConfig: {},
      workspace: {},
      calls: [],
      oauthStates: {},
      recoveryCases: [],
    }
    state.workspaces.push(workspace)
  }

  workspace.name = 'Ascend Demo'
  workspace.clientName = 'Ascend Growth Partners · Demo'
  workspace.credentials = {}
  workspace.oauthConfig = {}
  workspace.workspace = {}
  workspace.calls = fathom.calls ?? []
  workspace.oauthStates = {}
  workspace.recoveryCases = demoLeaks.map((leak) => {
    const id = `case-demo-${leak.id}`
    return {
      id,
      leakId: leak.id,
      type: leak.type,
      title: leak.title,
      description: leak.description,
      impact: leak.impact,
      affectedRecords: leak.count,
      severity: leak.severity,
      status: 'detected',
      owner: leak.owner,
      recoveredAmount: 0,
      actions: leak.suggestedActions.map((text, index) => ({ id: `${id}-action-${index + 1}`, text, completed: false })),
      notes: [],
      activity: [{
        id: `activity-demo-${leak.id}`,
        type: 'detected',
        text: `Leak detected with ${leak.count} affected record${leak.count === 1 ? '' : 's'} and ${leak.impact.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} estimated impact.`,
        createdAt: now,
        createdBy: 'LeakLine detection engine',
      }],
      createdAt: now,
      updatedAt: now,
    }
  })
  workspace.connections = {
    highlevel: {
      connectedAt: now,
      lastSyncAt: now,
      accountLabel: 'Sample GoHighLevel data connected',
      recordCounts: { leads: 824, deals: 241, closers: 5 },
      mode: 'sandbox',
    },
    stripe: {
      connectedAt: now,
      lastSyncAt: now,
      accountLabel: 'Sample Stripe payments connected',
      recordCounts: { payments: 1284 },
      mode: 'sandbox',
    },
    'google-calendar': {
      connectedAt: now,
      lastSyncAt: now,
      accountLabel: 'Sample Calendar appointments connected',
      recordCounts: { appointments: 437 },
      mode: 'sandbox',
    },
    fathom: {
      connectedAt: now,
      lastSyncAt: now,
      accountLabel: 'Sample Fathom calls connected',
      recordCounts: { calls: 312 },
      mode: 'sandbox',
    },
  }

  const ownerIds = new Set(state.users.filter((user) => user.role === 'owner').map((user) => user.id))
  for (const user of state.users.filter((item) => item.role === 'owner')) {
    user.workspaceIds = Array.from(new Set([...(user.workspaceIds ?? []), workspaceId]))
    user.defaultWorkspaceId = workspaceId
  }
  for (const session of state.sessions) {
    if (ownerIds.has(session.userId) && session.expiresAt > Date.now()) session.activeWorkspaceId = workspaceId
  }
})

console.log(`Full-stat demo workspace is active: ${workspaceId}`)
console.log(`Pilot data backup: ${backupDirectory}`)
