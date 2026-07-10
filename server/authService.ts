import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Request, Response } from 'express'
import type { EncryptedStore } from './store.js'
import type { SessionRecord, UserRecord } from './types.js'

const scrypt = promisify(scryptCallback)
const sessionCookieName = 'leakline_session'
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS ?? 30))

export type PublicUser = { id: string; name: string; email: string }

const normaliseEmail = (email: string) => email.trim().toLowerCase()
const sessionHash = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex')

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

function publicUser(user: UserRecord): PublicUser {
  return { id: user.id, name: user.name, email: user.email }
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
      signupAvailable: state.users.length === 0 || process.env.ALLOW_ADDITIONAL_USERS === 'true',
      inviteRequired: Boolean(this.inviteCode()),
    }
  }

  async currentUser(request: Request) {
    if (!this.enabled()) return { id: 'local-dev', name: 'Local pilot', email: 'local@leakline.dev' }
    const sessionId = parseCookies(request.headers.cookie)[sessionCookieName]
    if (!sessionId) return null
    const now = Date.now()
    const state = await this.store.update((draft) => {
      draft.sessions = draft.sessions.filter((session) => session.expiresAt > now)
    })
    const session = state.sessions.find((item) => item.idHash === sessionHash(sessionId))
    if (!session) return null
    const user = state.users.find((item) => item.id === session.userId)
    return user ? publicUser(user) : null
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
      if (state.users.length > 0 && process.env.ALLOW_ADDITIONAL_USERS !== 'true') throw new Error('The pilot account has already been created. Ask the Leakline admin to add another user.')
      if (state.users.some((item) => item.email === email)) throw new Error('An account with this email already exists.')
      const password = await hashPassword(input.password)
      const createdAt = new Date().toISOString()
      const user: UserRecord = { id: randomBytes(12).toString('hex'), name, email, passwordHash: password.hash, passwordSalt: password.salt, createdAt, lastLoginAt: createdAt }
      const sessionId = randomBytes(32).toString('base64url')
      state.users.push(user)
      state.sessions.push({ idHash: sessionHash(sessionId), userId: user.id, createdAt, expiresAt: Date.now() + sessionDays * 86400_000 })
      createdUser = publicUser(user)
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
    const sessionId = randomBytes(32).toString('base64url')
    await this.store.update((draft) => {
      const currentUser = draft.users.find((item) => item.id === user.id)
      if (currentUser) currentUser.lastLoginAt = now
      draft.sessions = draft.sessions.filter((session) => session.expiresAt > Date.now() && session.userId !== user.id)
      draft.sessions.push({ idHash: sessionHash(sessionId), userId: user.id, createdAt: now, expiresAt: Date.now() + sessionDays * 86400_000 })
    })
    return { user: publicUser(user), sessionId }
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
