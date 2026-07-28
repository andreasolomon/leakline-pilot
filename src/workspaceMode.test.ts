import { describe, expect, it } from 'vitest'
import { isRenewalPilotClient } from './workspaceMode'

describe('workspace mode', () => {
  it('recognises the Launch Webinars pilot with or without spaces', () => {
    expect(isRenewalPilotClient('Launch Webinars', 'LaunchWebinars')).toBe(true)
    expect(isRenewalPilotClient('Launch-Webinars', 'Launch Webinars')).toBe(true)
    expect(isRenewalPilotClient('Ascend Growth', 'Ascend Growth Partners')).toBe(false)
  })
})
