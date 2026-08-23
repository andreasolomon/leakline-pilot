import 'dotenv/config'
import { createApp } from './app.js'
import { EncryptedStore } from './store.js'
import { IntegrationService } from './integrationService.js'
import { EncryptedPaymentRecoveryRepository } from './paymentRecoveryRepository.js'
import { validateProductionConfiguration } from './productionConfig.js'

validateProductionConfiguration()
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const store = new EncryptedStore()
const server = createApp(store).listen(port, host, () => {
  process.stdout.write(`Leakline v2 listening on http://${host}:${port}\n`)
})

const autoSyncMinutes = Math.max(1, Number(process.env.AUTO_SYNC_MINUTES ?? 15))
const highLevelKpiSyncMinutes = Math.max(1, Number(process.env.GHL_KPI_SYNC_MINUTES ?? 2))
const runAutoSync = async () => {
  try {
    const state = await store.read()
    const service = new IntegrationService(store)
    for (const workspace of state.workspaces.filter((item) => !item.archivedAt && item.id !== 'workspace-leakline-demo')) {
      const statuses = await service.statuses(workspace.id)
      for (const status of statuses.filter((item) => item.connected && item.id !== 'highlevel')) {
        try { await service.sync(workspace.id, status.id) }
        catch (error) { process.stderr.write(`Automatic ${status.id} sync failed for ${workspace.name}: ${error instanceof Error ? error.message : String(error)}\n`) }
      }
    }
  } catch (error) {
    process.stderr.write(`Automatic sync failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
const runHighLevelKpiSync = async () => {
  try {
    const state = await store.read()
    const service = new IntegrationService(store)
    for (const workspace of state.workspaces.filter((item) => !item.archivedAt && item.id !== 'workspace-leakline-demo')) {
      const highLevel = (await service.statuses(workspace.id)).find((status) => status.id === 'highlevel')
      if (!highLevel?.connected) continue
      try { await service.sync(workspace.id, 'highlevel') }
      catch (error) { process.stderr.write(`Automatic GoHighLevel KPI sync failed for ${workspace.name}: ${error instanceof Error ? error.message : String(error)}\n`) }
    }
  } catch (error) {
    process.stderr.write(`Automatic GoHighLevel KPI sync failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
const runRecoveryScheduler = async () => {
  try {
    const state = await store.read()
    const repository = new EncryptedPaymentRecoveryRepository(store)
    for (const workspace of state.workspaces.filter((item) => !item.archivedAt)) await repository.processDue(workspace.id)
  } catch (error) {
    process.stderr.write(`Recovery scheduler failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
const initialSyncTimer = setTimeout(runAutoSync, 5_000)
initialSyncTimer.unref()
const syncTimer = setInterval(runAutoSync, autoSyncMinutes * 60_000)
syncTimer.unref()
const initialHighLevelSyncTimer = setTimeout(runHighLevelKpiSync, 7_500)
initialHighLevelSyncTimer.unref()
const highLevelKpiSyncTimer = setInterval(runHighLevelKpiSync, highLevelKpiSyncMinutes * 60_000)
highLevelKpiSyncTimer.unref()
const recoveryTimer = setInterval(runRecoveryScheduler, 60_000)
recoveryTimer.unref()

const shutdown = () => { clearTimeout(initialSyncTimer); clearTimeout(initialHighLevelSyncTimer); clearInterval(syncTimer); clearInterval(highLevelKpiSyncTimer); clearInterval(recoveryTimer); server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
