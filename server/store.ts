import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import type { StoreState } from './types.js'

const emptyState = (): StoreState => ({ credentials: {}, connections: {}, oauthConfig: {}, workspace: {}, calls: [], oauthStates: {}, users: [], sessions: [] })

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
      this.state = { ...emptyState(), ...JSON.parse(decoded) } as StoreState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The encrypted integration store could not be read. Check the encryption key.')
      this.state = emptyState()
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
