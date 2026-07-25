export function validateProductionConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.NODE_ENV !== 'production') return

  const errors: string[] = []
  try {
    const baseUrl = new URL(environment.APP_BASE_URL ?? '')
    if (baseUrl.protocol !== 'https:') errors.push('APP_BASE_URL must use HTTPS.')
  } catch {
    errors.push('APP_BASE_URL must be a valid public HTTPS URL.')
  }

  if (!/^[a-f0-9]{64}$/i.test(environment.LEAKLINE_ENCRYPTION_KEY ?? '')) {
    errors.push('LEAKLINE_ENCRYPTION_KEY must be a stable 64-character hexadecimal key.')
  }
  if ((environment.LEAKLINE_INVITE_CODE ?? '').trim().length < 20) {
    errors.push('LEAKLINE_INVITE_CODE must contain at least 20 characters.')
  }
  if (environment.LEAKLINE_AUTH_DISABLED === 'true') {
    errors.push('LEAKLINE_AUTH_DISABLED cannot be true in production.')
  }

  if (errors.length) throw new Error(`Unsafe production configuration:\n- ${errors.join('\n- ')}`)
}
