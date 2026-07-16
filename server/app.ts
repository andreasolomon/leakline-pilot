import express from 'express'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { EncryptedStore } from './store.js'
import { IntegrationService } from './integrationService.js'
import type { ProviderId } from './types.js'
import { safeErrorMessage } from './safety.js'
import { AuthService, type PublicUser } from './authService.js'
import { frontendEntryForPath } from './frontendRoutes.js'

const providerSchema = z.enum(['stripe', 'highlevel', 'google-calendar', 'fathom'])
const roleSchema = z.enum(['owner', 'admin', 'manager', 'viewer'])
const inviteRoleSchema = z.enum(['admin', 'manager', 'viewer'])
const marketingEventSchema = z.enum(['page_view', 'apply_click', 'vsl_click', 'sample_report_click', 'client_login_click', 'application_details_submitted', 'application_completed'])
const recoveryCaseStatusSchema = z.enum(['detected', 'assigned', 'in_progress', 'resolved'])
const detectedCaseSchema = z.object({
  leakId: z.number().int(),
  type: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(600),
  impact: z.number().min(0),
  affectedRecords: z.number().int().min(0),
  severity: z.enum(['critical', 'warning', 'opportunity']),
  suggestedOwner: z.string().min(1).max(100),
  suggestedActions: z.array(z.string().min(1).max(300)).max(8),
})

export function createApp(store = new EncryptedStore(), fetcher: typeof fetch = fetch) {
  const app = express()
  const service = new IntegrationService(store, fetcher)
  const auth = new AuthService(store)
  app.disable('x-powered-by')
  app.use(express.json({ limit: '256kb' }))
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next() })

  app.get('/api/health', (_request, response) => response.json({ ok: true, version: 2 }))

  app.post('/api/marketing-events', async (request, response) => {
    try {
      const input = z.object({
        event: marketingEventSchema,
        path: z.string().min(1).max(160),
        leadId: z.string().max(80).optional(),
      }).parse(request.body)
      await store.update((state) => {
        state.marketingEvents.push({ id: `event-${randomBytes(8).toString('hex')}`, event: input.event, path: input.path, leadId: input.leadId, createdAt: new Date().toISOString() })
        if (state.marketingEvents.length > 5_000) state.marketingEvents.splice(0, state.marketingEvents.length - 5_000)
      })
      response.status(202).json({ ok: true })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 500).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/leads', async (request, response) => {
    try {
      const input = z.object({
        name: z.string().min(2).max(80),
        email: z.string().email().max(120),
        phone: z.string().max(40).optional().default(''),
        company: z.string().min(2).max(120),
        website: z.string().max(180).optional().default(''),
        role: z.string().max(80).optional().default(''),
        monthlyBookedCalls: z.string().max(60).optional().default(''),
        offerPrice: z.string().max(60).optional().default(''),
        crm: z.string().max(80).optional().default(''),
        suspectedLeak: z.string().max(160).optional().default(''),
        notes: z.string().max(600).optional().default(''),
      }).parse(request.body)
      let leadId = ''
      await store.update((state) => {
        leadId = `lead-${randomBytes(8).toString('hex')}`
        state.leadApplications.push({
          id: leadId,
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          phone: input.phone.trim() || undefined,
          company: input.company.trim(),
          website: input.website.trim() || undefined,
          role: input.role.trim() || undefined,
          monthlyBookedCalls: input.monthlyBookedCalls.trim() || undefined,
          offerPrice: input.offerPrice.trim() || undefined,
          crm: input.crm.trim() || undefined,
          suspectedLeak: input.suspectedLeak.trim() || undefined,
          notes: input.notes.trim() || undefined,
          source: 'landing-page',
          status: 'new',
          createdAt: new Date().toISOString(),
        })
      })
      response.status(201).json({ ok: true, leadId })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 500).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/leads/:leadId/qualify', async (request, response) => {
    try {
      const input = z.object({
        website: z.string().max(180).optional().default(''),
        monthlyBookedCalls: z.string().min(1).max(60),
        offerPrice: z.string().min(1).max(60),
        crm: z.string().max(80).optional().default(''),
        suspectedLeak: z.string().min(2).max(160),
        notes: z.string().max(600).optional().default(''),
      }).parse(request.body)
      let updated = false
      await store.update((state) => {
        const lead = state.leadApplications.find((item) => item.id === request.params.leadId)
        if (!lead) throw new Error('Application not found.')
        lead.website = input.website.trim() || lead.website
        lead.monthlyBookedCalls = input.monthlyBookedCalls.trim()
        lead.offerPrice = input.offerPrice.trim()
        lead.crm = input.crm.trim() || undefined
        lead.suspectedLeak = input.suspectedLeak.trim()
        lead.notes = input.notes.trim() || undefined
        lead.status = 'qualified'
        lead.qualifiedAt = new Date().toISOString()
        updated = true
      })
      response.json({ ok: updated })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 404).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/auth/me', async (request, response, next) => {
    try {
      const user = await auth.currentUser(request)
      response.json({ ...(await auth.meta()), authenticated: Boolean(user), user })
    } catch (error) { next(error) }
  })

  app.post('/api/auth/signup', async (request, response, next) => {
    try {
      const input = z.object({ name: z.string().max(80).default(''), email: z.string().email(), password: z.string().min(10), inviteCode: z.string().optional() }).parse(request.body)
      const result = await auth.signup(input)
      auth.setSessionCookie(response, result.sessionId)
      response.status(201).json({ user: result.user })
    } catch (error) {
      if (error instanceof z.ZodError) return next(error)
      response.status(400).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body)
      const result = await auth.login(input)
      auth.setSessionCookie(response, result.sessionId)
      response.json({ user: result.user })
    } catch (error) {
      if (error instanceof z.ZodError) return next(error)
      response.status(401).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/auth/logout', async (request, response, next) => {
    try {
      await auth.logout(request)
      auth.clearSessionCookie(response)
      response.json({ ok: true })
    } catch (error) { next(error) }
  })

  app.get('/api/invites/:token', async (request, response) => {
    try {
      response.json({ invite: await auth.previewInvite(request.params.token) })
    } catch (error) {
      response.status(404).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/invites/:token/accept', async (request, response, next) => {
    try {
      const input = z.object({ name: z.string().max(80).default(''), password: z.string().min(10) }).parse(request.body)
      const result = await auth.acceptInvite(request.params.token, input)
      auth.setSessionCookie(response, result.sessionId)
      response.status(201).json({ user: result.user })
    } catch (error) {
      if (error instanceof z.ZodError) return next(error)
      response.status(400).json({ error: safeErrorMessage(error) })
    }
  })

  app.use('/api', async (request, response, next) => {
    try {
      if (!auth.enabled()) {
        response.locals.user = await auth.currentUser(request)
        return next()
      }
      const user = await auth.currentUser(request)
      if (!user) return response.status(401).json({ error: 'Login required.' })
      response.locals.user = user
      next()
    } catch (error) { next(error) }
  })

  const activeWorkspaceId = (response: express.Response) => (response.locals.user as PublicUser).workspaceId

  app.get('/api/admin/users', async (_request, response, next) => {
    try { response.json({ users: await auth.listUsers(response.locals.user as PublicUser) }) }
    catch (error) { response.status(403).json({ error: safeErrorMessage(error) }) }
  })

  app.post('/api/admin/users', async (request, response) => {
    try {
      const input = z.object({
        name: z.string().max(80).default(''),
        email: z.string().email(),
        password: z.string().min(10),
        role: roleSchema.default('manager'),
        workspaceIds: z.array(z.string()).optional(),
      }).parse(request.body)
      response.status(201).json({ user: await auth.createUser(response.locals.user as PublicUser, input) })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.patch('/api/admin/users/:userId', async (request, response) => {
    try {
      const input = z.object({
        name: z.string().max(80).optional(),
        role: roleSchema.optional(),
        status: z.enum(['active', 'disabled']).optional(),
      }).parse(request.body)
      response.json({ user: await auth.updateUser(response.locals.user as PublicUser, request.params.userId, input) })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/admin/users/:userId/reset-password', async (request, response) => {
    try {
      const input = z.object({ password: z.string().min(10) }).parse(request.body)
      response.json(await auth.resetPassword(response.locals.user as PublicUser, request.params.userId, input.password))
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/admin/invites', async (_request, response) => {
    try {
      response.json({ invites: await auth.listInvites(response.locals.user as PublicUser) })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/admin/marketing', async (_request, response) => {
    try {
      auth.requireOwner(response.locals.user as PublicUser)
      const state = await store.read()
      response.json({
        leads: [...state.leadApplications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        events: [...state.marketingEvents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/admin/invites', async (request, response) => {
    try {
      const input = z.object({
        email: z.string().email(),
        role: inviteRoleSchema.default('viewer'),
        workspaceIds: z.array(z.string()).optional(),
        expiresInDays: z.number().int().min(1).max(30).optional(),
      }).parse(request.body)
      response.status(201).json({ invite: await auth.createInvite(response.locals.user as PublicUser, input) })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/admin/invites/:inviteId/revoke', async (request, response) => {
    try {
      response.json({ invite: await auth.revokeInvite(response.locals.user as PublicUser, request.params.inviteId) })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/workspaces', async (_request, response) => {
    const user = response.locals.user as PublicUser
    response.json({ activeWorkspaceId: user.workspaceId, workspaces: user.workspaces })
  })

  app.post('/api/workspaces', async (request, response) => {
    try {
      auth.requireOwner(response.locals.user as PublicUser)
      const input = z.object({ name: z.string().min(2).max(80), clientName: z.string().min(2).max(120) }).parse(request.body)
      let workspaceId = ''
      await store.update((state) => {
        workspaceId = `workspace-${randomBytes(8).toString('hex')}`
        state.workspaces.push({
          id: workspaceId,
          name: input.name.trim(),
          clientName: input.clientName.trim(),
          createdAt: new Date().toISOString(),
          createdBy: (response.locals.user as PublicUser).id,
          credentials: {},
          connections: {},
          oauthConfig: {},
          workspace: {},
          calls: [],
          oauthStates: {},
          recoveryCases: [],
        })
        for (const user of state.users.filter((item) => item.role === 'owner')) {
          user.workspaceIds = Array.from(new Set([...(user.workspaceIds ?? []), workspaceId]))
        }
      })
      response.status(201).json({ workspaceId })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/workspaces/active', async (request, response) => {
    try {
      const input = z.object({ workspaceId: z.string().min(1) }).parse(request.body)
      const user = await auth.setActiveWorkspace(request, response.locals.user as PublicUser, input.workspaceId)
      response.json({ user })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.post('/api/workspaces/:workspaceId/members', async (request, response) => {
    try {
      auth.requireWorkspaceAdmin(response.locals.user as PublicUser, request.params.workspaceId)
      const input = z.object({ userId: z.string().min(1) }).parse(request.body)
      await store.update((state) => {
        if (!state.workspaces.some((workspace) => workspace.id === request.params.workspaceId && !workspace.archivedAt)) throw new Error('Workspace not found.')
        const user = state.users.find((item) => item.id === input.userId)
        if (!user) throw new Error('User not found.')
        user.workspaceIds = Array.from(new Set([...(user.workspaceIds ?? []), request.params.workspaceId]))
        user.defaultWorkspaceId ??= request.params.workspaceId
      })
      response.json({ ok: true })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.delete('/api/workspaces/:workspaceId/members/:userId', async (request, response) => {
    try {
      auth.requireWorkspaceAdmin(response.locals.user as PublicUser, request.params.workspaceId)
      await store.update((state) => {
        const user = state.users.find((item) => item.id === request.params.userId)
        if (!user) throw new Error('User not found.')
        if (user.role === 'owner') throw new Error('Owners keep access to every workspace.')
        user.workspaceIds = (user.workspaceIds ?? []).filter((id) => id !== request.params.workspaceId)
        if (user.defaultWorkspaceId === request.params.workspaceId) user.defaultWorkspaceId = user.workspaceIds[0]
        state.sessions = state.sessions.map((session) => session.userId === user.id && session.activeWorkspaceId === request.params.workspaceId ? { ...session, activeWorkspaceId: user.defaultWorkspaceId } : session)
      })
      response.json({ ok: true })
    } catch (error) {
      response.status(403).json({ error: safeErrorMessage(error) })
    }
  })

  app.get('/api/recovery-cases', async (_request, response) => {
    const state = await store.read()
    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
    if (!workspace) return response.status(404).json({ error: 'Workspace not found.' })
    response.json({ cases: [...workspace.recoveryCases].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) })
  })

  app.post('/api/recovery-cases/sync', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = z.object({ cases: z.array(detectedCaseSchema).max(100) }).parse(request.body)
      const actor = response.locals.user as PublicUser
      const now = new Date().toISOString()
      let cases = [] as NonNullable<(Awaited<ReturnType<typeof store.read>>['workspaces'][number])['recoveryCases']>
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        if (!workspace) throw new Error('Workspace not found.')
        for (const detected of input.cases) {
          const existing = workspace.recoveryCases.find((item) => item.leakId === detected.leakId)
          if (!existing) {
            const id = `case-${randomBytes(8).toString('hex')}`
            workspace.recoveryCases.push({
              id,
              leakId: detected.leakId,
              type: detected.type,
              title: detected.title,
              description: detected.description,
              impact: detected.impact,
              affectedRecords: detected.affectedRecords,
              severity: detected.severity,
              status: 'detected',
              owner: detected.suggestedOwner,
              recoveredAmount: 0,
              actions: detected.suggestedActions.map((text, index) => ({ id: `${id}-action-${index + 1}`, text, completed: false })),
              notes: [],
              activity: [{ id: `activity-${randomBytes(8).toString('hex')}`, type: 'detected', text: `Leak detected with ${detected.affectedRecords} affected record${detected.affectedRecords === 1 ? '' : 's'} and ${detected.impact.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} estimated impact.`, createdAt: now, createdBy: 'LeakLine detection engine' }],
              createdAt: now,
              updatedAt: now,
            })
            continue
          }
          existing.type = detected.type
          existing.title = detected.title
          existing.description = detected.description
          existing.impact = detected.impact
          existing.affectedRecords = detected.affectedRecords
          existing.severity = detected.severity
          existing.actions = detected.suggestedActions.map((text, index) => existing.actions.find((action) => action.text === text) ?? ({ id: `${existing.id}-action-${index + 1}`, text, completed: false }))
          existing.updatedAt = now
        }
        cases = [...workspace.recoveryCases].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      })
      response.json({ cases })
    } catch (error) {
      response.status(error instanceof z.ZodError ? 400 : 403).json({ error: safeErrorMessage(error) })
    }
  })

  app.patch('/api/recovery-cases/:caseId', async (request, response) => {
    try {
      auth.requireDataEditor(response.locals.user as PublicUser)
      const input = z.object({
        status: recoveryCaseStatusSchema.optional(),
        owner: z.string().min(1).max(100).optional(),
        deadline: z.string().date().nullable().optional(),
        recoveredAmount: z.number().min(0).max(100_000_000).optional(),
        resolution: z.string().min(3).max(1000).optional(),
        actionId: z.string().min(1).max(120).optional(),
        actionCompleted: z.boolean().optional(),
        note: z.string().min(2).max(1000).optional(),
      }).refine((value) => value.actionId === undefined || value.actionCompleted !== undefined, { message: 'Action completion is required when an action is selected.' }).parse(request.body)
      const actor = response.locals.user as PublicUser
      const actorName = actor.name || actor.email
      const now = new Date().toISOString()
      let updatedCase: NonNullable<(Awaited<ReturnType<typeof store.read>>['workspaces'][number])['recoveryCases'][number]> | undefined
      await store.update((state) => {
        const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId(response) && !item.archivedAt)
        const recoveryCase = workspace?.recoveryCases.find((item) => item.id === request.params.caseId)
        if (!recoveryCase) throw new Error('Recovery case not found.')
        const activity = (type: string, text: string) => recoveryCase.activity.unshift({ id: `activity-${randomBytes(8).toString('hex')}`, type, text, createdAt: now, createdBy: actorName })
        if (input.owner !== undefined && input.owner !== recoveryCase.owner) {
          recoveryCase.owner = input.owner.trim()
          activity('assignment', `Assigned to ${recoveryCase.owner}.`)
          if (recoveryCase.status === 'detected') recoveryCase.status = 'assigned'
        }
        if (input.deadline !== undefined && input.deadline !== recoveryCase.deadline) {
          recoveryCase.deadline = input.deadline ?? undefined
          activity('deadline', input.deadline ? `Deadline set for ${input.deadline}.` : 'Deadline removed.')
        }
        if (input.actionId !== undefined) {
          const action = recoveryCase.actions.find((item) => item.id === input.actionId)
          if (!action) throw new Error('Recovery action not found.')
          action.completed = Boolean(input.actionCompleted)
          action.completedAt = action.completed ? now : undefined
          action.completedBy = action.completed ? actorName : undefined
          activity('action', `${action.completed ? 'Completed' : 'Reopened'} action: ${action.text}`)
          if (action.completed && recoveryCase.status !== 'resolved') recoveryCase.status = 'in_progress'
        }
        if (input.note !== undefined) {
          recoveryCase.notes.unshift({ id: `note-${randomBytes(8).toString('hex')}`, text: input.note.trim(), createdAt: now, createdBy: actorName })
          activity('note', 'Added a case note.')
        }
        if (input.recoveredAmount !== undefined) recoveryCase.recoveredAmount = input.recoveredAmount
        if (input.resolution !== undefined) recoveryCase.resolution = input.resolution.trim()
        if (input.status !== undefined && input.status !== recoveryCase.status) {
          if (input.status === 'resolved' && !(input.resolution ?? recoveryCase.resolution)) throw new Error('Add a resolution before resolving this case.')
          recoveryCase.status = input.status
          if (input.status === 'resolved') {
            recoveryCase.resolvedAt = now
            activity('resolved', `Resolved with ${recoveryCase.recoveredAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} recovered.`)
          } else {
            recoveryCase.resolvedAt = undefined
            activity('status', `Status changed to ${input.status.replace('_', ' ')}.`)
          }
        }
        recoveryCase.updatedAt = now
        updatedCase = recoveryCase
      })
      response.json({ case: updatedCase })
    } catch (error) {
      const message = safeErrorMessage(error)
      response.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : /access|manager/i.test(message) ? 403 : 400).json({ error: message })
    }
  })

  app.get('/api/integrations', async (_request, response, next) => { try { response.json(await service.snapshot(activeWorkspaceId(response))) } catch (error) { next(error) } })
  app.get('/api/calls', async (request, response, next) => { try { response.json({ calls: await service.calls(activeWorkspaceId(response), Number(request.query.limit ?? 50)) }) } catch (error) { next(error) } })
  app.post('/api/integrations/sync-all', async (_request, response, next) => { try { auth.requireDataEditor(response.locals.user as PublicUser); response.json(await service.syncAll(activeWorkspaceId(response))) } catch (error) { next(error) } })

  app.post('/api/integrations/google-calendar/configure', async (request, response, next) => {
    try {
      const config = z.object({ clientId: z.string().min(12), clientSecret: z.string().min(12) }).parse(request.body)
      auth.requireIntegrationManager(response.locals.user as PublicUser)
      response.json(await service.configureGoogleOAuth(activeWorkspaceId(response), config.clientId, config.clientSecret))
    } catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/connect', async (request, response, next) => {
    try {
      const provider = providerSchema.parse(request.params.provider)
      auth.requireIntegrationManager(response.locals.user as PublicUser)
      if (provider === 'google-calendar') return response.status(400).json({ error: 'Use the Google OAuth start endpoint.' })
      const credential = provider === 'stripe'
        ? z.object({ secretKey: z.string().min(20).regex(/^(sk|rk)_(test|live)_/, 'Use a Stripe secret or restricted key.') }).parse(request.body)
        : provider === 'highlevel'
          ? z.object({ accessToken: z.string().min(20), locationId: z.string().min(5) }).parse(request.body)
          : z.object({ apiKey: z.string().min(10) }).parse(request.body)
      await service.connect(activeWorkspaceId(response), provider, credential as never)
      response.json(await service.snapshot(activeWorkspaceId(response)))
    } catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/sync', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); response.json(await service.sync(activeWorkspaceId(response), providerSchema.parse(request.params.provider))) }
    catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/sandbox-sync', async (request, response, next) => {
    try { auth.requireDataEditor(response.locals.user as PublicUser); response.json(await service.syncSandbox(activeWorkspaceId(response), providerSchema.parse(request.params.provider))) }
    catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/disconnect', async (request, response, next) => {
    try { auth.requireIntegrationManager(response.locals.user as PublicUser); await service.disconnect(activeWorkspaceId(response), providerSchema.parse(request.params.provider)); response.json(await service.snapshot(activeWorkspaceId(response))) }
    catch (error) { next(error) }
  })

  app.get('/api/integrations/google-calendar/start', async (_request, response, next) => {
    try { auth.requireIntegrationManager(response.locals.user as PublicUser); response.json({ url: await service.googleAuthorizationUrl(activeWorkspaceId(response)) }) }
    catch (error) { next(error) }
  })

  app.get('/api/integrations/google-calendar/callback', async (request, response, next) => {
    try {
      const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query)
      await service.finishGoogleAuthorization(query.code, query.state)
      response.redirect('/app?integration=google-calendar&connected=1')
    } catch (error) { next(error) }
  })

  const dist = join(process.cwd(), 'dist')
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }))
    app.get(/.*/, (request, response, next) => {
      const entry = frontendEntryForPath(request.path)
      return entry ? response.sendFile(join(dist, entry)) : next()
    })
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(', ') : safeErrorMessage(error)
    const permissionDenied = /access required|access denied|permission|owner access|manager access|admin access/i.test(message)
    response.status(error instanceof z.ZodError ? 400 : permissionDenied ? 403 : 502).json({ error: message })
  })
  return app
}
