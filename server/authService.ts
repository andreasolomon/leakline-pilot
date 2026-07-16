import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Request, Response } from 'express'
import type { EncryptedStore } from './store.js'
import type { InviteRecord, StoreState, UserRecord, WorkspaceRecord } from './types.js'

const scrypt = promisify(scryptCallback)
const sessionCookieName = 'leakline_session'
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS ?? 30))

export type UserRole = 'owner' | 'admin' | 'manager' | 'viewer'
export type InviteRole = Exclude<UserRole, 'owner'>
export type UserStatus = 'active' | 'disabled'
export type PublicWorkspace = { id: string; name: string; clientName: string; role: UserRole; recordCount: number }
export type PublicUser = { id: string; name: string; email: string; role: UserRole; status: UserStatus; workspaceId: string; workspaces: PublicWorkspace[] }
export type AdminUser = PublicUser & { createdAt: string; lastLoginAt?: string; createdBy?: string; disabledAt?: string }
export type PublicInvite = { id: string; email: string; role: InviteRole; workspaceIds: string[]; workspaces: PublicWorkspace[]; status: 'pending' | 'accepted' | 'revoked' | 'expired'; createdAt: string; expiresAt: string; acceptedAt?: string; revokedAt?: string; createdBy?: string; token?: string }
export type InvitePreview = { email: string; role: InviteRole; workspaces: Array<{ id: string; name: string; clientName: string }>; expiresAt: string }

const roleLabels: Record<UserRole, string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager', viewer: 'Viewer' }

const normaliseEmail = (email: string) => email.trim().toLowerCase()
const sessionHash = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex')
const inviteTokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const inviteDays = Math.max(1, Number(process.env.INVITE_DAYS ?? 7))

async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64) as Buffer
  return { salt, hash: derived.toString('hex') }
}

async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const { hash } = await hashPassword(password, salt)
  const actual = Buffer.from(hash, 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function parseCookies(header: string | undefined) {
  return Object.fromEntries((header ?? '').split(';').map((part) => {
    const [name, ...value] = part.trim().split('=')
    return [decodeURIComponent(name ?? ''), decodeURIComponent(value.join('=') ?? '')]
  }).filter(([name]) => name))
}

function recordCount(workspace: WorkspaceRecord) {
  return Object.values(workspace.workspace ?? {}).reduce((sum, dataset) => sum + (dataset?.rows.length ?? 0), 0) + (workspace.calls?.length ?? 0)
}

function accessibleWorkspaces(state: StoreState, user: UserRecord) {
  if ((user.role ?? 'manager') === 'owner') return state.workspaces.filter((workspace) => !workspace.archivedAt)
  const allowed = new Set(user.workspaceIds ?? [])
  return state.workspaces.filter((workspace) => !workspace.archivedAt && allowed.has(workspace.id))
}

function publicWorkspace(workspace: WorkspaceRecord, user: UserRecord): PublicWorkspace {
  return { id: workspace.id, name: workspace.name, clientName: workspace.clientName, role: user.role ?? 'manager', recordCount: recordCount(workspace) }
}

function resolveWorkspaceId(state: StoreState, user: UserRecord, requested?: string | null) {
  const accessible = accessibleWorkspaces(state, user)
  if (!accessible.length) return ''
  if (requested && accessible.some((workspace) => workspace.id === requested)) return requested
  if (user.defaultWorkspaceId && accessible.some((workspace) => workspace.id === user.defaultWorkspaceId)) return user.defaultWorkspaceId
  return accessible[0].id
}

function publicUser(user: UserRecord, state: StoreState, workspaceId?: string): PublicUser {
  const activeWorkspaceId = resolveWorkspaceId(state, user, workspaceId)
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role ?? 'manager',
    status: user.status ?? 'active',
    workspaceId: activeWorkspaceId,
    workspaces: accessibleWorkspaces(state, user).map((workspace) => publicWorkspace(workspace, user)),
  }
}

function adminUser(user: UserRecord, state: StoreState): AdminUser {
  return { ...publicUser(user, state), createdAt: user.createdAt, lastLoginAt: user.lastLoginAt, createdBy: user.createdBy, disabledAt: user.disabledAt }
}

function activeOwners(users: UserRecord[]) {
  return users.filter((user) => (user.role ?? 'manager') === 'owner' && (user.status ?? 'active') === 'active')
}

function actorWorkspaceIds(actor: PublicUser) {
  return new Set(actor.workspaces.map((workspace) => workspace.id))
}

function usersShareWorkspace(actor: PublicUser, user: UserRecord) {
  if (actor.role === 'owner') return true
  const allowed = actorWorkspaceIds(actor)
  return (user.workspaceIds ?? []).some((workspaceId) => allowed.has(workspaceId))
}

function validWorkspaceIdsForActor(actor: PublicUser, state: StoreState, requested?: string[]) {
  const existing = new Set(state.workspaces.filter((workspace) => !workspace.archivedAt).map((workspace) => workspace.id))
  const requestedExisting = (requested ?? []).filter((workspaceId) => existing.has(workspaceId))
  if (actor.role === 'owner') return requestedExisting.length ? requestedExisting : [...existing]
  const allowed = actorWorkspaceIds(actor)
  const scoped = requestedExisting.filter((workspaceId) => allowed.has(workspaceId))
  return scoped.length ? scoped : [actor.workspaceId].filter(Boolean)
}

function canActorManageUser(actor: PublicUser, user: UserRecord) {
  if (actor.role === 'owner') return true
  if (actor.role !== 'admin') return false
  if ((user.role ?? 'manager') === 'owner' || (user.role ?? 'manager') === 'admin') return false
  return usersShareWorkspace(actor, user)
}

function assertCreatableRole(actor: PublicUser, role: UserRole) {
  if (actor.role === 'owner') return
  if (actor.role === 'admin' && (role === 'manager' || role === 'viewer')) return
  throw new Error(`${roleLabels[role]} users can only be created by a LeakLine owner.`)
}

function inviteStatus(invite: InviteRecord): PublicInvite['status'] {
  if (invite.revokedAt) return 'revoked'
  if (invite.acceptedAt) return 'accepted'
  if (Date.parse(invite.expiresAt) <= Date.now()) return 'expired'
  return 'pending'
}

function inviteWorkspaces(state: StoreState, invite: InviteRecord, role: InviteRole = invite.role) {
  return state.workspaces
    .filter((workspace) => invite.workspaceIds.includes(workspace.id) && !workspace.archivedAt)
    .map((workspace) => publicWorkspace(workspace, { id: invite.id, name: invite.email, email: invite.email, role, status: 'active', passwordHash: '', passwordSalt: '', createdAt: invite.createdAt, workspaceIds: invite.workspaceIds, defaultWorkspaceId: invite.workspaceIds[0] }))
}

function publicInvite(invite: InviteRecord, state: StoreState, token?: string): PublicInvite {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    workspaceIds: invite.workspaceIds,
    workspaces: inviteWorkspaces(state, invite),
    status: inviteStatus(invite),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    revokedAt: invite.revokedAt,
    createdBy: invite.createdBy,
    token,
  }
}

function findInviteByToken(state: StoreState, token: string) {
  const hash = inviteTokenHash(token)
  return state.invites.find((invite) => invite.tokenHash === hash)
}

function canActorManageInvite(actor: PublicUser, invite: InviteRecord) {
  if (actor.role === 'owner') return true
  if (actor.role !== 'admin') return false
  const allowed = actorWorkspaceIds(actor)
  return invite.workspaceIds.some((workspaceId) => allowed.has(workspaceId))
}

export class AuthService {
  constructor(private readonly store: EncryptedStore) {}

  enabled() {
    if (process.env.LEAKLINE_AUTH_DISABLED === 'true') return false
    if (process.env.NODE_ENV === 'test' && process.env.LEAKLINE_AUTH_ENABLED !== 'true') return false
    return true
  }

  private inviteCode() {
    const configured = process.env.LEAKLINE_INVITE_CODE?.trim()
    if (configured) return configured
    return process.env.NODE_ENV === 'production' ? null : 'dev-invite'
  }

  async meta() {
    const state = await this.store.read()
    return {
      enabled: this.enabled(),
      signupAvailable: state.users.length === 0,
      inviteRequired: Boolean(this.inviteCode()),
    }
  }

  async currentUser(request: Request) {
    if (!this.enabled()) {
      const state = await this.store.read()
      const workspace = state.workspaces[0]
      return { id: 'local-dev', name: 'Local pilot', email: 'local@leakline.dev', role: 'owner' as const, status: 'active' as const, workspaceId: workspace?.id ?? '', workspaces: workspace ? [publicWorkspace(workspace, { id: 'local-dev', name: 'Local pilot', email: 'local@leakline.dev', role: 'owner', status: 'active', passwordHash: '', passwordSalt: '', createdAt: '' })] : [] }
    }
    const sessionId = parseCookies(request.headers.cookie)[sessionCookieName]
    if (!sessionId) return null
    const now = Date.now()
    const state = await this.store.update((draft) => {
      draft.sessions = draft.sessions.filter((session) => session.expiresAt > now)
    })
    const session = state.sessions.find((item) => item.idHash === sessionHash(sessionId))
    if (!session) return null
    const user = state.users.find((item) => item.id === session.userId)
    if (user?.status === 'disabled') {
      await this.store.update((draft) => { draft.sessions = draft.sessions.filter((item) => item.userId !== user.id) })
      return null
    }
    return user ? publicUser(user, state, session.activeWorkspaceId) : null
  }

  async signup(input: { name: string; email: string; password: string; inviteCode?: string }) {
    if (!this.enabled()) throw new Error('Authentication is disabled for this environment.')
    const requiredInvite = this.inviteCode()
    if (!requiredInvite) throw new Error('Signup is not configured yet. Add LEAKLINE_INVITE_CODE before creating client accounts.')
    if (input.inviteCode?.trim() !== requiredInvite) throw new Error('Invite code is incorrect.')
    const email = normaliseEmail(input.email)
    const name = input.name.trim() || email.split('@')[0] || 'Leakline user'
    if (input.password.length < 10) throw new Error('Password must be at least 10 characters.')
    let createdUser: PublicUser | null = null
    let createdSessionId = ''
    await this.store.update(async (state) => {
      if (state.users.length > 0) throw new Error('The first admin account has already been created. Ask an admin to add another user.')
      if (state.users.some((item) => item.email === email)) throw new Error('An account with this email already exists.')
      const password = await hashPassword(input.password)
      const createdAt = new Date().toISOString()
      const workspaceId = state.workspaces[0]?.id ?? ''
      const user: UserRecord = { id: randomBytes(12).toString('hex'), name, email, role: state.users.length === 0 ? 'owner' : 'manager', status: 'active', passwordHash: password.hash, passwordSalt: password.salt, createdAt, lastLoginAt: createdAt, workspaceIds: workspaceId ? [workspaceId] : [], defaultWorkspaceId: workspaceId }
      const sessionId = randomBytes(32).toString('base64url')
      state.users.push(user)
      state.sessions.push({ idHash: sessionHash(sessionId), userId: user.id, createdAt, expiresAt: Date.now() + sessionDays * 86400_000, activeWorkspaceId: workspaceId })
      createdUser = publicUser(user, state, workspaceId)
      createdSessionId = sessionId
    })
    if (!createdUser || !createdSessionId) throw new Error('Account could not be created.')
    return { user: createdUser, sessionId: createdSessionId }
  }

  async login(input: { email: string; password: string }) {
    if (!this.enabled()) throw new Error('Authentication is disabled for this environment.')
    const email = normaliseEmail(input.email)
    const now = new Date().toISOString()
    const state = await this.store.read()
    const user = state.users.find((item) => item.email === email)
    if (!user || !(await verifyPassword(input.password, user.passwordSalt, user.passwordHash))) throw new Error('Email or password is incorrect.')
    if (user.status === 'disabled') throw new Error('This account has been disabled. Ask the Leakline admin to restore access.')
    const sessionId = randomBytes(32).toString('base64url')
    let activeWorkspaceId = ''
    await this.store.update((draft) => {
      const currentUser = draft.users.find((item) => item.id === user.id)
      if (currentUser) currentUser.lastLoginAt = now
      if (currentUser) activeWorkspaceId = resolveWorkspaceId(draft, currentUser, currentUser.defaultWorkspaceId)
      draft.sessions = draft.sessions.filter((session) => session.expiresAt > Date.now() && session.userId !== user.id)
      draft.sessions.push({ idHash: sessionHash(sessionId), userId: user.id, createdAt: now, expiresAt: Date.now() + sessionDays * 86400_000, activeWorkspaceId })
    })
    const nextState = await this.store.read()
    return { user: publicUser(user, nextState, activeWorkspaceId), sessionId }
  }

  async listUsers(actor: PublicUser) {
    this.requireAdmin(actor)
    const state = await this.store.read()
    return state.users
      .filter((user) => actor.role === 'owner' || ((user.role ?? 'manager') !== 'owner' && usersShareWorkspace(actor, user)))
      .map((user) => adminUser(user, state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async createUser(actor: PublicUser, input: { name: string; email: string; password: string; role?: UserRole; workspaceIds?: string[] }) {
    this.requireAdmin(actor)
    const email = normaliseEmail(input.email)
    const name = input.name.trim() || email.split('@')[0] || 'Leakline user'
    if (input.password.length < 10) throw new Error('Password must be at least 10 characters.')
    const role = input.role ?? 'manager'
    assertCreatableRole(actor, role)
    let created: AdminUser | null = null
    await this.store.update(async (state) => {
      if (state.users.some((item) => item.email === email)) throw new Error('An account with this email already exists.')
      const workspaceIds = validWorkspaceIdsForActor(actor, state, input.workspaceIds)
      const password = await hashPassword(input.password)
      const createdAt = new Date().toISOString()
      const user: UserRecord = { id: randomBytes(12).toString('hex'), name, email, role, status: 'active', passwordHash: password.hash, passwordSalt: password.salt, createdAt, createdBy: actor.id, workspaceIds, defaultWorkspaceId: workspaceIds[0] }
      state.users.push(user)
      created = adminUser(user, state)
    })
    if (!created) throw new Error('User could not be created.')
    return created
  }

  async listInvites(actor: PublicUser) {
    this.requireAdmin(actor)
    const state = await this.store.read()
    return state.invites
      .filter((invite) => canActorManageInvite(actor, invite))
      .map((invite) => publicInvite(invite, state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async createInvite(actor: PublicUser, input: { email: string; role: InviteRole; workspaceIds?: string[]; expiresInDays?: number }) {
    this.requireAdmin(actor)
    assertCreatableRole(actor, input.role)
    const email = normaliseEmail(input.email)
    const days = Math.max(1, Math.min(30, Math.floor(input.expiresInDays ?? inviteDays)))
    const token = randomBytes(32).toString('base64url')
    let created: PublicInvite | null = null
    await this.store.update((state) => {
      if (state.users.some((user) => user.email === email)) throw new Error('An account with this email already exists.')
      if (state.invites.some((invite) => invite.email === email && inviteStatus(invite) === 'pending')) throw new Error('A pending invite already exists for this email.')
      const workspaceIds = validWorkspaceIdsForActor(actor, state, input.workspaceIds)
      if (!workspaceIds.length) throw new Error('Invite must be assigned to a workspace.')
      const createdAt = new Date().toISOString()
      const invite: InviteRecord = {
        id: randomBytes(12).toString('hex'),
        email,
        role: input.role,
        workspaceIds,
        tokenHash: inviteTokenHash(token),
        createdBy: actor.id,
        createdAt,
        expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
      }
      state.invites.push(invite)
      created = publicInvite(invite, state, token)
    })
    if (!created) throw new Error('Invite could not be created.')
    return created
  }

  async revokeInvite(actor: PublicUser, inviteId: string) {
    this.requireAdmin(actor)
    let updated: PublicInvite | null = null
    await this.store.update((state) => {
      const invite = state.invites.find((item) => item.id === inviteId)
      if (!invite) throw new Error('Invite not found.')
      if (!canActorManageInvite(actor, invite)) throw new Error('You do not have permission to manage this invite.')
      if (invite.acceptedAt) throw new Error('Accepted invites cannot be revoked.')
      if (!invite.acceptedAt) {
        invite.revokedAt = new Date().toISOString()
        invite.revokedBy = actor.id
      }
      updated = publicInvite(invite, state)
    })
    if (!updated) throw new Error('Invite could not be revoked.')
    return updated
  }

  async previewInvite(token: string): Promise<InvitePreview> {
    const state = await this.store.read()
    const invite = findInviteByToken(state, token)
    if (!invite || inviteStatus(invite) !== 'pending') throw new Error('Invite is invalid or no longer available.')
    return {
      email: invite.email,
      role: invite.role,
      workspaces: state.workspaces
        .filter((workspace) => invite.workspaceIds.includes(workspace.id) && !workspace.archivedAt)
        .map((workspace) => ({ id: workspace.id, name: workspace.name, clientName: workspace.clientName })),
      expiresAt: invite.expiresAt,
    }
  }

  async acceptInvite(token: string, input: { name: string; password: string }) {
    if (!this.enabled()) throw new Error('Authentication is disabled for this environment.')
    if (input.password.length < 10) throw new Error('Password must be at least 10 characters.')
    const name = input.name.trim()
    let acceptedUser: PublicUser | null = null
    let createdSessionId = ''
    await this.store.update(async (state) => {
      const invite = findInviteByToken(state, token)
      if (!invite || inviteStatus(invite) !== 'pending') throw new Error('Invite is invalid or no longer available.')
      if (state.users.some((user) => user.email === invite.email)) throw new Error('An account with this email already exists.')
      const password = await hashPassword(input.password)
      const createdAt = new Date().toISOString()
      const user: UserRecord = {
        id: randomBytes(12).toString('hex'),
        name: name || invite.email.split('@')[0] || 'Leakline user',
        email: invite.email,
        role: invite.role,
        status: 'active',
        passwordHash: password.hash,
        passwordSalt: password.salt,
        createdAt,
        createdBy: invite.createdBy,
        lastLoginAt: createdAt,
        workspaceIds: invite.workspaceIds,
        defaultWorkspaceId: invite.workspaceIds[0],
      }
      const sessionId = randomBytes(32).toString('base64url')
      state.users.push(user)
      invite.acceptedAt = createdAt
      invite.acceptedBy = user.id
      state.sessions.push({ idHash: sessionHash(sessionId), userId: user.id, createdAt, expiresAt: Date.now() + sessionDays * 86400_000, activeWorkspaceId: user.defaultWorkspaceId })
      acceptedUser = publicUser(user, state, user.defaultWorkspaceId)
      createdSessionId = sessionId
    })
    if (!acceptedUser || !createdSessionId) throw new Error('Invite could not be accepted.')
    return { user: acceptedUser, sessionId: createdSessionId }
  }

  async updateUser(actor: PublicUser, userId: string, input: { name?: string; role?: UserRole; status?: UserStatus }) {
    this.requireAdmin(actor)
    let updated: AdminUser | null = null
    await this.store.update((state) => {
      const user = state.users.find((item) => item.id === userId)
      if (!user) throw new Error('User not found.')
      if (!canActorManageUser(actor, user)) throw new Error('You do not have permission to manage this user.')
      if (input.name !== undefined) user.name = input.name.trim() || user.email.split('@')[0] || 'Leakline user'
      if (input.role) {
        assertCreatableRole(actor, input.role)
        if (user.id === actor.id && user.role !== input.role) throw new Error('You cannot change your own role.')
        if (user.role === 'owner' && input.role !== 'owner' && activeOwners(state.users).length <= 1) throw new Error('Keep at least one active owner account.')
        user.role = input.role
      }
      if (input.status) {
        if (user.id === actor.id && input.status === 'disabled') throw new Error('You cannot disable your own account.')
        if (user.role === 'owner' && input.status === 'disabled' && activeOwners(state.users).length <= 1) throw new Error('Keep at least one active owner account.')
        user.status = input.status
        user.disabledAt = input.status === 'disabled' ? new Date().toISOString() : undefined
        if (input.status === 'disabled') state.sessions = state.sessions.filter((session) => session.userId !== user.id)
      }
      updated = adminUser(user, state)
    })
    if (!updated) throw new Error('User could not be updated.')
    return updated
  }

  async setActiveWorkspace(request: Request, actor: PublicUser, workspaceId: string) {
    const sessionId = parseCookies(request.headers.cookie)[sessionCookieName]
    if (!sessionId) throw new Error('Login required.')
    const hash = sessionHash(sessionId)
    let updated: PublicUser | null = null
    await this.store.update((state) => {
      const user = state.users.find((item) => item.id === actor.id)
      if (!user) throw new Error('User not found.')
      const nextWorkspaceId = resolveWorkspaceId(state, user, workspaceId)
      if (nextWorkspaceId !== workspaceId) throw new Error('Workspace access denied.')
      const session = state.sessions.find((item) => item.idHash === hash)
      if (!session) throw new Error('Login required.')
      session.activeWorkspaceId = nextWorkspaceId
      user.defaultWorkspaceId = nextWorkspaceId
      updated = publicUser(user, state, nextWorkspaceId)
    })
    if (!updated) throw new Error('Workspace could not be selected.')
    return updated
  }

  async resetPassword(actor: PublicUser, userId: string, password: string) {
    this.requireAdmin(actor)
    if (password.length < 10) throw new Error('Password must be at least 10 characters.')
    await this.store.update(async (state) => {
      const user = state.users.find((item) => item.id === userId)
      if (!user) throw new Error('User not found.')
      if (!canActorManageUser(actor, user)) throw new Error('You do not have permission to manage this user.')
      const next = await hashPassword(password)
      user.passwordHash = next.hash
      user.passwordSalt = next.salt
      state.sessions = state.sessions.filter((session) => session.userId !== user.id)
    })
    return { ok: true }
  }

  requireAdmin(user: PublicUser | null) {
    if (!user || (user.role !== 'owner' && user.role !== 'admin') || user.status !== 'active') throw new Error('Admin access required.')
  }

  requireOwner(user: PublicUser | null) {
    if (!user || user.role !== 'owner' || user.status !== 'active') throw new Error('Owner access required.')
  }

  requireDataEditor(user: PublicUser | null) {
    if (!user || user.role === 'viewer' || user.status !== 'active') throw new Error('Manager access required.')
  }

  requireIntegrationManager(user: PublicUser | null) {
    if (!user || (user.role !== 'owner' && user.role !== 'admin') || user.status !== 'active') throw new Error('Admin access required to manage integrations.')
  }

  requireWorkspaceAdmin(user: PublicUser | null, workspaceId: string) {
    this.requireAdmin(user)
    if (!user) throw new Error('Admin access required.')
    if (user.role !== 'owner' && !actorWorkspaceIds(user).has(workspaceId)) throw new Error('Workspace access denied.')
  }

  async logout(request: Request) {
    const sessionId = parseCookies(request.headers.cookie)[sessionCookieName]
    if (!sessionId) return
    const hash = sessionHash(sessionId)
    await this.store.update((draft) => { draft.sessions = draft.sessions.filter((session) => session.idHash !== hash) })
  }

  setSessionCookie(response: Response, sessionId: string) {
    response.cookie(sessionCookieName, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: sessionDays * 86400_000,
    })
  }

  clearSessionCookie(response: Response) {
    response.clearCookie(sessionCookieName, { path: '/' })
  }
}
