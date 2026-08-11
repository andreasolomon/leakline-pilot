import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import type { PaymentRecoveryClassification, PilotValidationRecord, RecoveryMessageTemplate, RecoveryPolicyRecord, StoreState, WorkspaceIntegrationState, WorkspaceRecord } from './types.js'

const defaultWorkspaceId = 'workspace-ascend-growth'

const recoveryTemplate = (instruction: string): RecoveryMessageTemplate => ({
  sms: `Hi {{first_name}}, it’s {{sender_name}} from {{business_name}}. ${instruction} The outstanding amount is {{amount_due}}. You can resolve it securely here: {{payment_link}}. Reply here if you need help.`,
  emailSubject: `Action needed for your {{business_name}} payment`,
  emailBody: `Hi {{first_name}},\n\n${instruction}\n\nOutstanding amount: {{amount_due}}\nSecure payment link: {{payment_link}}\n\nIf you need help or need us to note a payment date, reply to this message.\n\n{{sender_name}}\n{{business_name}}`,
})

export const defaultRecoveryPolicy = (businessName = 'Client business'): RecoveryPolicyRecord => ({
  businessName,
  senderName: 'Accounts team',
  senderEmail: '',
  senderPhone: '',
  defaultOwner: 'Finance / Revenue operations',
  timezone: 'America/New_York',
  escalationDays: 5,
  maxTouches: 4,
  followUpDelaysHours: [24, 72, 168],
  promiseGraceHours: 4,
  tone: 'warm',
  templates: {
    retryable_failure: recoveryTemplate('Your latest instalment did not complete and your payment provider has a retry scheduled.'),
    payment_method_required: recoveryTemplate('Your latest instalment needs an updated payment method before it can complete.'),
    authentication_required: recoveryTemplate('Your latest instalment needs a quick authentication step before it can complete.'),
    secure_payment_link: recoveryTemplate('Your latest instalment is now overdue.'),
    human_review: recoveryTemplate('We need to speak with you about the outstanding balance on your account.'),
  } satisfies Record<PaymentRecoveryClassification, RecoveryMessageTemplate>,
})

export const defaultPilotValidation = (): PilotValidationRecord => ({
  monthlyFee: 499,
  baselineWindowDays: 60,
  historicEligibleBalance: 0,
  historicRecoveredAmount: 0,
  onboardingMinutes: 0,
  supportMinutes: 0,
  renewalStatus: 'not_asked',
  notes: '',
})

const emptyWorkspaceState = (businessName = 'Client business'): WorkspaceIntegrationState => ({ credentials: {}, connections: {}, oauthConfig: {}, workspace: {}, imports: {}, calls: [], oauthStates: {}, recoveryCases: [], paymentRecoveryCases: [], recoveryPolicy: defaultRecoveryPolicy(businessName), pilotValidation: defaultPilotValidation(), renewalClients: [], clickUpRenewalImport: undefined, kpiSnapshots: [] })

const emptyState = (): StoreState => ({ workspaces: [], credentials: {}, connections: {}, oauthConfig: {}, workspace: {}, calls: [], oauthStates: {}, users: [], sessions: [], invites: [], leadApplications: [], marketingEvents: [] })

function normaliseRecoveryPolicy(policy: RecoveryPolicyRecord | undefined, businessName: string) {
  const defaults = defaultRecoveryPolicy(businessName)
  const merged: RecoveryPolicyRecord = { ...defaults, ...(policy ?? {}), templates: { ...defaults.templates, ...(policy?.templates ?? {}) } }
  const retryable = merged.templates.retryable_failure
  merged.templates.retryable_failure = {
    ...retryable,
    sms: retryable.sms.replace('and Stripe has a retry scheduled', 'and your payment provider has a retry scheduled'),
    emailBody: retryable.emailBody.replace('and Stripe has a retry scheduled', 'and your payment provider has a retry scheduled'),
  }
  return merged
}

function normaliseRole(role: unknown, index: number): StoreState['users'][number]['role'] {
  if (role === 'admin') return index === 0 ? 'owner' : 'admin'
  if (role === 'owner' || role === 'manager' || role === 'viewer') return role
  if (role === 'member') return 'manager'
  return index === 0 ? 'owner' : 'manager'
}

function normaliseRenewalStatus(status: unknown): WorkspaceIntegrationState['renewalClients'][number]['renewalStatus'] {
  if (status === 'nurturing') return 'conversation_needed'
  if (status === 'renewal_opportunity' || status === 'conversation_needed' || status === 'call_booked' || status === 'decision_pending' || status === 'renewed' || status === 'declined') return status
  return 'not_started'
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
    imports: {},
    calls: input.calls ?? [],
    oauthStates: input.oauthStates ?? {},
    recoveryCases: [],
    paymentRecoveryCases: [],
    recoveryPolicy: defaultRecoveryPolicy('Ascend Growth Partners'),
    pilotValidation: defaultPilotValidation(),
    renewalClients: [],
    clickUpRenewalImport: undefined,
    kpiSnapshots: [],
  }
}

function normaliseState(input: Partial<StoreState>): StoreState {
  const state = { ...emptyState(), ...input } as StoreState
  state.workspaces = (state.workspaces?.length ? state.workspaces : [workspaceFromLegacy(input)]).map((workspace) => ({
    ...emptyWorkspaceState(workspace.clientName || workspace.name),
    ...workspace,
    clientName: workspace.clientName || workspace.name || 'Client workspace',
    name: workspace.name || workspace.clientName || 'Client workspace',
    credentials: workspace.credentials ?? {},
    connections: workspace.connections ?? {},
    oauthConfig: workspace.oauthConfig ?? {},
    workspace: workspace.workspace ?? {},
    imports: workspace.imports ?? {},
    calls: workspace.calls ?? [],
    oauthStates: workspace.oauthStates ?? {},
    recoveryCases: workspace.recoveryCases ?? [],
    paymentRecoveryCases: (workspace.paymentRecoveryCases ?? []).map((recoveryCase) => ({
      ...recoveryCase,
      attempts: recoveryCase.attempts ?? [],
      promises: recoveryCase.promises ?? [],
      suggestions: recoveryCase.suggestions ?? [],
      followUps: recoveryCase.followUps ?? [],
      lastInboundAt: recoveryCase.lastInboundAt ?? recoveryCase.attempts?.find((attempt) => attempt.direction === 'inbound')?.createdAt,
      lastOutboundAt: recoveryCase.lastOutboundAt ?? recoveryCase.attempts?.find((attempt) => attempt.direction === 'outbound')?.createdAt,
    })),
    recoveryPolicy: normaliseRecoveryPolicy(workspace.recoveryPolicy, workspace.clientName || workspace.name),
    pilotValidation: { ...defaultPilotValidation(), ...(workspace.pilotValidation ?? {}) },
    renewalClients: (workspace.renewalClients ?? []).map((client) => ({
      ...client,
      renewalStatus: normaliseRenewalStatus(client.renewalStatus),
      outreachStatus: client.outreachStatus === 'paused' || client.outreachStatus === 'do_not_contact' ? client.outreachStatus : 'eligible',
      outreach: client.outreach ?? [],
    })),
    clickUpRenewalImport: workspace.clickUpRenewalImport,
    kpiSnapshots: (workspace.kpiSnapshots ?? []).map((snapshot) => ({ ...snapshot, entries: snapshot.entries ?? [] })),
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
  private loading?: Promise<StoreState>
  private writeQueue: Promise<void> = Promise.resolve()

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

  private async loadFromDisk(): Promise<StoreState> {
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

  private async load(): Promise<StoreState> {
    if (this.state) return this.state
    if (this.loading) return this.loading
    const pending = this.loadFromDisk()
    this.loading = pending
    try { return await pending }
    finally { if (this.loading === pending) this.loading = undefined }
  }

  private async persist() {
    const state = await this.load()
    const key = await this.getKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
    await mkdir(this.directory, { recursive: true })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600 })
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  async read() {
    await this.writeQueue
    return this.load()
  }

  async update(mutator: (state: StoreState) => void | Promise<void>) {
    const operation = this.writeQueue.then(async () => {
      const state = await this.load()
      await mutator(state)
      await this.persist()
      return state
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
