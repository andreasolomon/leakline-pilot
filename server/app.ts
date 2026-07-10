import express from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { EncryptedStore } from './store.js'
import { IntegrationService } from './integrationService.js'
import type { ProviderId } from './types.js'
import { safeErrorMessage } from './safety.js'

const providerSchema = z.enum(['stripe', 'highlevel', 'google-calendar', 'fathom'])

export function createApp(store = new EncryptedStore(), fetcher: typeof fetch = fetch) {
  const app = express()
  const service = new IntegrationService(store, fetcher)
  app.disable('x-powered-by')
  app.use(express.json({ limit: '256kb' }))
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next() })

  app.get('/api/health', (_request, response) => response.json({ ok: true, version: 2 }))
  app.get('/api/integrations', async (_request, response, next) => { try { response.json(await service.snapshot()) } catch (error) { next(error) } })
  app.get('/api/calls', async (request, response, next) => { try { response.json({ calls: await service.calls(Number(request.query.limit ?? 50)) }) } catch (error) { next(error) } })
  app.post('/api/integrations/sync-all', async (_request, response, next) => { try { response.json(await service.syncAll()) } catch (error) { next(error) } })

  app.post('/api/integrations/google-calendar/configure', async (request, response, next) => {
    try {
      const config = z.object({ clientId: z.string().min(12), clientSecret: z.string().min(12) }).parse(request.body)
      response.json(await service.configureGoogleOAuth(config.clientId, config.clientSecret))
    } catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/connect', async (request, response, next) => {
    try {
      const provider = providerSchema.parse(request.params.provider)
      if (provider === 'google-calendar') return response.status(400).json({ error: 'Use the Google OAuth start endpoint.' })
      const credential = provider === 'stripe'
        ? z.object({ secretKey: z.string().min(20).regex(/^(sk|rk)_(test|live)_/, 'Use a Stripe secret or restricted key.') }).parse(request.body)
        : provider === 'highlevel'
          ? z.object({ accessToken: z.string().min(20), locationId: z.string().min(5) }).parse(request.body)
          : z.object({ apiKey: z.string().min(10) }).parse(request.body)
      await service.connect(provider, credential as never)
      response.json(await service.snapshot())
    } catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/sync', async (request, response, next) => {
    try { response.json(await service.sync(providerSchema.parse(request.params.provider))) }
    catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/sandbox-sync', async (request, response, next) => {
    try { response.json(await service.syncSandbox(providerSchema.parse(request.params.provider))) }
    catch (error) { next(error) }
  })

  app.post('/api/integrations/:provider/disconnect', async (request, response, next) => {
    try { await service.disconnect(providerSchema.parse(request.params.provider)); response.json(await service.snapshot()) }
    catch (error) { next(error) }
  })

  app.get('/api/integrations/google-calendar/start', async (_request, response, next) => {
    try { response.json({ url: await service.googleAuthorizationUrl() }) }
    catch (error) { next(error) }
  })

  app.get('/api/integrations/google-calendar/callback', async (request, response, next) => {
    try {
      const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query)
      await service.finishGoogleAuthorization(query.code, query.state)
      response.redirect('/?integration=google-calendar&connected=1')
    } catch (error) { next(error) }
  })

  const dist = join(process.cwd(), 'dist')
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }))
    app.get(/.*/, (request, response, next) => request.path.startsWith('/api/') ? next() : response.sendFile(join(dist, 'index.html')))
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(', ') : safeErrorMessage(error)
    response.status(error instanceof z.ZodError ? 400 : 502).json({ error: message })
  })
  return app
}
