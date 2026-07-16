import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import type { StoreState, WorkspaceIntegrationState, WorkspaceRecord } from './types.js'

const defaultWorkspaceId = 'workspace-ascend-growth'

const emptyWorkspaceState = (): WorkspaceIntegrationState => ({ credentials: {}, connections: {}, oauthConfig: {}, workspace: {}, calls: [], oauthStates: {}, recoveryCases: [] })

const emptyState = (): StoreState => ({ workspaces: [], credentials: {}, connections: {}, oauthConfig: {}, workspace: {}, calls: [], oauthStates: {}, users: [], sessions: [], invites: [], leadApplications: [], marketingEvents: [] })

function normaliseRole(role: unknown, index: number): StoreState['users'][number]['role'] {
  if (role === 'admin') return index === 0 ? 'owner' : 'admin'
  if (role === 'owner' || role === 'manager' || role === 'viewer') return role
  if (role === 'member') return 'manager'
  return index === 0 ? 'owner' : 'manager'
}

function workspaceFromLegacy(input: Partial<StoreState>): WorkspaceRecord {
  return {
    id: defaultWorkspaceId,
    name: 'Ascend Growth',
    clientName: 'Ascend Growth Partners',
    createdAt: new Date().toISOString(),
    credentials: input.credentials ?? {},
    connections: input.connections ?? {},
    oauthConfig: input.oauthConfig ?? {},
    workspace: input.workspace ?? {},
    calls: input.calls ?? [],
    oauthStates: input.oauthStates ?? {},
    recoveryCases: [],
  }
}

function normaliseState(input: Partial<StoreState>): StoreState {
  const state = { ...emptyState(), ...input } as StoreState
  state.workspaces = (state.workspaces?.length ? state.workspaces : [workspaceFromLegacy(input)]).map((workspace) => ({
    ...emptyWorkspaceState(),
    ...workspace,
    clientName: workspace.clientName || workspace.name || 'Client workspace',
    name: workspace.name || workspace.clientName || 'Client workspace',
    credentials: workspace.credentials ?? {},
    connections: workspace.connections ?? {},
    oauthConfig: workspace.oauthConfig ?? {},
    workspace: workspace.workspace ?? {},
    calls: workspace.calls ?? [],
    oauthStates: workspace.oauthStates ?? {},
    recoveryCases: workspace.recoveryCases ?? [],
  }))
  const fallbackWorkspaceId = state.workspaces[0]?.id ?? defaultWorkspaceId
  state.users = (state.users ?? []).map((user, index) => ({
    ...user,
    role: normaliseRole(user.role, index),
    status: user.status ?? 'active',
    workspaceIds: user.workspaceIds?.length ? user.workspaceIds : [fallbackWorkspaceId],
    defaultWorkspaceId: user.defaultWorkspaceId && state.workspaces.some((workspace) => workspace.id === user.defaultWorkspaceId) ? user.defaultWorkspaceId : fallbackWorkspaceId,
  }))
  state.sessions = (state.sessions ?? []).map((session) => ({ ...session, activeWorkspaceId: session.activeWorkspaceId ?? state.users.find((user) => user.id === session.userId)?.defaultWorkspaceId ?? fallbackWorkspaceId }))
  state.invites = state.invites ?? []
  state.leadApplications = state.leadApplications ?? []
  state.marketingEvents = state.marketingEvents ?? []
  return state
}

export class EncryptedStore {
  private readonly directory: string
  private readonly statePath: string
  private readonly keyPath: string
  private key?: Buffer
  private state?: StoreState

  constructor(directory = process.env.LEAKLINE_DATA_DIR || join(process.cwd(), '.data')) {
    this.directory = directory
    this.statePath = join(directory, 'integrations.enc')
    this.keyPath = join(directory, 'local.key')
  }

  private async getKey() {
    if (this.key) return this.key
    await mkdir(this.directory, { recursive: true })
    const configured = process.env.LEAKLINE_ENCRYPTION_KEY?.trim()
    if (configured) {
      if (!/^[a-f0-9]{64}$/i.test(configured)) throw new Error('LEAKLINE_ENCRYPTION_KEY must be 64 hexadecimal characters.')
      this.key = Buffer.from(configured, 'hex')
      return this.key
    }
    try { this.key = Buffer.from((await readFile(this.keyPath, 'utf8')).trim(), 'hex') }
    catch {
      this.key = randomBytes(32)
      await writeFile(this.keyPath, this.key.toString('hex'), { mode: 0o600 })
      await chmod(this.keyPath, 0o600)
    }
    return this.key
  }

  private async load() {
    if (this.state) return this.state
    const key = await this.getKey()
    try {
      const payload = JSON.parse(await readFile(this.statePath, 'utf8')) as { iv: string; tag: string; data: string }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
      const decoded = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8')
      this.state = normaliseState(JSON.parse(decoded) as Partial<StoreState>)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The encrypted integration store could not be read. Check the encryption key.')
      this.state = normaliseState({})
    }
    return this.state
  }

  private async persist() {
    const state = await this.load()
    const key = await this.getKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
    await mkdir(this.directory, { recursive: true })
    await writeFile(this.statePath, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600 })
  }

  async read() { return this.load() }

  async update(mutator: (state: StoreState) => void | Promise<void>) {
    const state = await this.load()
    await mutator(state)
    await this.persist()
    return state
  }
}
