import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = join(root, '.data')
const pidPath = join(dataDir, 'preview.pid')
const logPath = join(dataDir, 'preview.log')
const port = Number(process.env.PORT ?? 8787)
const baseUrl = `http://localhost:${port}`
const healthUrl = `${baseUrl}/api/health`

const command = process.argv[2] ?? 'status'

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true })
}

function pidFromFile() {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function isRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch { return false }
}

function listeningPids() {
  try {
    return execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  } catch { return [] }
}

async function health() {
  try {
    const response = await fetch(healthUrl, { cache: 'no-store' })
    if (!response.ok) return { ok: false, status: response.status }
    return { ok: true, status: response.status, body: await response.json().catch(() => null) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForHealth() {
  const started = Date.now()
  let latest = await health()
  while (!latest.ok && Date.now() - started < 10_000) {
    await new Promise((resolve) => setTimeout(resolve, 350))
    latest = await health()
  }
  return latest
}

function requireBuildArtifacts() {
  const missing = []
  if (!existsSync(join(root, 'dist', 'index.html'))) missing.push('dist/index.html')
  if (!existsSync(join(root, 'server-dist', 'index.js'))) missing.push('server-dist/index.js')
  if (missing.length) {
    throw new Error(`Missing build output: ${missing.join(', ')}. Run npm run build first, or use npm run demo.`)
  }
}

function stopPid(pid) {
  if (!isRunning(pid)) return
  try { process.kill(pid, 'SIGTERM') } catch { /* process already gone */ }
}

async function stop() {
  const filePid = pidFromFile()
  if (filePid) stopPid(filePid)
  for (const pid of listeningPids()) stopPid(pid)
  await new Promise((resolve) => setTimeout(resolve, 500))
  try { rmSync(pidPath) } catch { /* no pid file */ }
}

async function start() {
  ensureDataDir()
  requireBuildArtifacts()

  const current = await health()
  if (current.ok) {
    const pid = pidFromFile()
    console.log(`Leakline preview already healthy at ${baseUrl}${pid ? ` (pid ${pid})` : ''}.`)
    return
  }

  const listening = listeningPids()
  if (listening.length) {
    console.log(`Port ${port} is occupied but health failed. Restarting stale listener: ${listening.join(', ')}.`)
    await stop()
  }

  const logFd = openSync(logPath, 'a')
  const child = spawn(process.execPath, ['server-dist/index.js'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: String(port),
      APP_BASE_URL: baseUrl,
      GOOGLE_REDIRECT_URI: `${baseUrl}/api/integrations/google-calendar/callback`,
      FATHOM_SYNC_PAGE_LIMIT: process.env.FATHOM_SYNC_PAGE_LIMIT ?? '2',
      FATHOM_SYNC_PAGE_SIZE: process.env.FATHOM_SYNC_PAGE_SIZE ?? '15',
      FATHOM_SYNC_DELAY_MS: process.env.FATHOM_SYNC_DELAY_MS ?? '2500',
    },
  })
  child.unref()
  writeFileSync(pidPath, String(child.pid))

  const result = await waitForHealth()
  if (!result.ok) {
    throw new Error(`Preview failed to become healthy. Check ${logPath}. Last result: ${JSON.stringify(result)}`)
  }
  console.log(`Leakline preview ready at ${baseUrl} (pid ${child.pid}).`)
  console.log(`Health: ${JSON.stringify(result.body ?? { status: result.status })}`)
  console.log(`Logs: ${logPath}`)
}

async function status() {
  const pid = pidFromFile()
  const result = await health()
  console.log(`URL: ${baseUrl}`)
  console.log(`Health: ${result.ok ? 'healthy' : 'not responding'}`)
  if (pid) console.log(`PID file: ${pid} (${isRunning(pid) ? 'running' : 'not running'})`)
  const pids = listeningPids()
  console.log(`Listening PIDs: ${pids.length ? pids.join(', ') : 'none'}`)
  if (!result.ok) console.log(`Details: ${JSON.stringify(result)}`)
}

try {
  if (command === 'start' || command === 'up') await start()
  else if (command === 'restart') { await stop(); await start() }
  else if (command === 'stop') { await stop(); console.log(`Leakline preview stopped on ${baseUrl}.`) }
  else if (command === 'status') await status()
  else {
    console.error('Usage: node scripts/preview.mjs <start|restart|stop|status>')
    process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

