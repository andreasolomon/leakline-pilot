import 'dotenv/config'
import { createApp } from './app.js'
import { EncryptedStore } from './store.js'
import { IntegrationService } from './integrationService.js'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const store = new EncryptedStore()
const server = createApp(store).listen(port, host, () => {
  process.stdout.write(`Leakline v2 listening on http://${host}:${port}\n`)
})

const autoSyncMinutes = Math.max(1, Number(process.env.AUTO_SYNC_MINUTES ?? 15))
const runAutoSync = () => new IntegrationService(store).syncAll().catch((error) => process.stderr.write(`Automatic sync failed: ${error instanceof Error ? error.message : String(error)}\n`))
const initialSyncTimer = setTimeout(runAutoSync, 5_000)
initialSyncTimer.unref()
const syncTimer = setInterval(runAutoSync, autoSyncMinutes * 60_000)
syncTimer.unref()

const shutdown = () => { clearTimeout(initialSyncTimer); clearInterval(syncTimer); server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
