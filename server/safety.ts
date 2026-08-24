export function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected server error.'
  return message
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_-]+/g, '[redacted Stripe key]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:access_token|refresh_token|api_key)=?\s*[A-Za-z0-9._-]+/gi, '$1=[redacted]')
    .slice(0, 500)
}

export function explicitSmsOptOutReason(value: unknown) {
  const message = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const command = message.replace(/[.!?,;:]+$/g, '').trim()
  const optOutCommand = /^(?:stopall|unsubscribe|cancel|end|quit|remove me|opt out|opt me out)$/
  const stopCommand = /^(?:(?:please|kindly|can you|could you|would you)\s+)?stop(?:\s+(?:all\s+(?:messages|texts|calls)|texting|messaging|calling|contacting|sending)(?:\s+(?:me|messages|texts|calls|me messages|me texts))?)?(?:\s+(?:now|please|immediately))?$/
  const directRequest = /\b(?:do not|don['’]?t)\s+(?:text|message|call|contact)\s*(?:me|us|this number)?\b|\b(?:remove me|take me off)(?:\s+(?:your|the|this))?\s+(?:list|messages?)\b/
  if (optOutCommand.test(command) || stopCommand.test(command) || directRequest.test(message)) {
    return 'The recipient asked not to receive further messages.'
  }
  return undefined
}
