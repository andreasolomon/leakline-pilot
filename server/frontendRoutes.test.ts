import { describe, expect, it } from 'vitest'
import { frontendEntryForPath } from './frontendRoutes.js'

describe('separate landing and software entry points', () => {
  it('keeps public pages on the landing entry', () => {
    expect(frontendEntryForPath('/')).toBe('index.html')
    expect(frontendEntryForPath('/landing')).toBe('index.html')
    expect(frontendEntryForPath('/privacy')).toBe('index.html')
    expect(frontendEntryForPath('/terms')).toBe('index.html')
  })

  it('keeps authenticated and invitation routes on the software entry', () => {
    expect(frontendEntryForPath('/app')).toBe('app/index.html')
    expect(frontendEntryForPath('/app/')).toBe('app/index.html')
    expect(frontendEntryForPath('/app/settings')).toBe('app/index.html')
    expect(frontendEntryForPath('/invite/pilot-token')).toBe('app/index.html')
  })

  it('does not silently map unknown paths to either product', () => {
    expect(frontendEntryForPath('/unknown')).toBeNull()
    expect(frontendEntryForPath('/api/health')).toBeNull()
  })
})
