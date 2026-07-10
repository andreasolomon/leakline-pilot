export function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected server error.'
  return message
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_-]+/g, '[redacted Stripe key]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:access_token|refresh_token|api_key)=?\s*[A-Za-z0-9._-]+/gi, '$1=[redacted]')
    .slice(0, 500)
}
