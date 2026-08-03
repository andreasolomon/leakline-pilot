import { describe, expect, it } from 'vitest'
import { classifyClickUpImport, parseClickUpRenewalCsv } from './clickUpRenewalImport'
import type { RenewalClient } from './renewalCommand'

const headers = 'Task ID,Task Name,Webinar 1 (date),Webinar 2 (date),Webinar NEXT (date),Email (short text),Phone (short text),z[Webinar Plan Status]z (drop down)'

describe('ClickUp renewal import', () => {
  it('maps completed webinars separately from future sessions', () => {
    const preview = parseClickUpRenewalCsv('clients.csv', `${headers}
task-1,Donna Kelly,"Thursday, July 16th 2026","Wednesday, July 29th 2026","Wednesday, July 29th 2026",DONNA@example.com,"(518) 368-4959",Ended`, new Date('2026-07-28T12:00:00.000Z'))

    expect(preview.rows).toEqual([{
      clickUpTaskId: 'task-1',
      name: 'Donna Kelly',
      email: 'donna@example.com',
      phone: '+15183684959',
      firstWebinarAt: '2026-07-16',
      lastWebinarAt: '2026-07-16',
      nextWebinarAt: '2026-07-29',
      webinarsHosted: 1,
      clickUpStatus: 'Ended',
    }])
    expect(preview.completedWebinarDates).toBe(1)
    expect(preview.futureWebinarDates).toBe(1)
  })

  it('requires task identity and reports invalid source values', () => {
    const preview = parseClickUpRenewalCsv('clients.csv', `${headers}
,Missing ID,not-a-date,,,,wrong-email,,
task-2,Valid Client,,,,valid@example.com,,`)

    expect(preview.rows).toHaveLength(1)
    expect(preview.issues.some((issue) => issue.includes('Task ID or Task Name'))).toBe(true)
  })

  it('classifies create, update and unchanged records before import', () => {
    const base = {
      owner: 'Yonas',
      enrolledAt: undefined,
      feedbackScore: undefined,
      feedbackNote: '',
      renewalCallAt: undefined,
      renewalStatus: 'not_started',
      expectedRenewalValue: 0,
      renewalCashCollected: 0,
      nextAction: '',
      source: 'clickup',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    } satisfies Partial<RenewalClient>
    const clients = [
      { ...base, id: 'one', clickUpTaskId: 'task-1', name: 'One', email: 'one@example.com', webinarsHosted: 1, firstWebinarAt: '2026-07-01', lastWebinarAt: '2026-07-01' },
      { ...base, id: 'two', clickUpTaskId: 'task-2', name: 'Old name', email: 'two@example.com', webinarsHosted: 0 },
    ] as RenewalClient[]
    const rows = [
      { clickUpTaskId: 'task-1', name: 'One', email: 'one@example.com', webinarsHosted: 1, firstWebinarAt: '2026-07-01', lastWebinarAt: '2026-07-01' },
      { clickUpTaskId: 'task-2', name: 'Two', email: 'two@example.com', webinarsHosted: 0 },
      { clickUpTaskId: 'task-3', name: 'Three', webinarsHosted: 0 },
    ]

    expect(classifyClickUpImport(rows, clients)).toEqual({ create: 1, update: 1, unchanged: 1 })
  })
})
