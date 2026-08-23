import { describe, expect, it } from 'vitest'
import { answerRenewalAssistantQuestion, classifyRenewalAssistantQuestion } from './renewalAssistantAnalysis'
import type { RenewalClient } from './renewalCommand'

const now = new Date('2026-08-22T12:00:00.000Z')

const client = (overrides: Partial<RenewalClient> = {}): RenewalClient => ({
  id: 'renewal-1',
  name: 'Example Client',
  owner: 'Yonas',
  firstWebinarAt: '2026-06-10',
  lastWebinarAt: '2026-08-18',
  webinarsHosted: 5,
  feedbackScore: 4,
  phone: '+15555550100',
  renewalStatus: 'not_started',
  expectedRenewalValue: 8_000,
  renewalCashCollected: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
})

describe('LeakLine renewal assistant', () => {
  it('recognises the supported renewal questions', () => {
    expect(classifyRenewalAssistantQuestion('Who needs attention today?')).toBe('attention')
    expect(classifyRenewalAssistantQuestion('Who is most ready to renew?')).toBe('readiness')
    expect(classifyRenewalAssistantQuestion('What client data is missing?')).toBe('missing')
    expect(classifyRenewalAssistantQuestion('Forecast next year revenue')).toBe('unsupported')
  })

  it('ranks urgent open work ahead of an ordinary active client', () => {
    const answer = answerRenewalAssistantQuestion([
      client({ id: 'active', name: 'Active Client', firstWebinarAt: '2026-08-01', lastWebinarAt: '2026-08-20', webinarsHosted: 2 }),
      client({ id: 'decision', name: 'Decision Client', renewalStatus: 'decision_pending' }),
    ], 'Who needs attention today?', now)

    expect(answer.kind).toBe('answer')
    expect(answer.items[0].heading).toBe('Decision Client')
    expect(answer.items[0].recommendation).toMatch(/renewal decision/i)
  })

  it('explains readiness using the existing transparent score', () => {
    const answer = answerRenewalAssistantQuestion([
      client({ id: 'strong', name: 'Strong Client', webinarsHosted: 6, feedbackScore: 5 }),
      client({ id: 'weaker', name: 'Weaker Client', webinarsHosted: 2, feedbackScore: 3 }),
    ], 'Who is most ready to renew?', now)

    expect(answer.items[0].heading).toMatch(/^Strong Client/)
    expect(answer.items[0].evidence).toContain('usage')
    expect(answer.note).toMatch(/does not guarantee/i)
  })

  it('reports missing fields with affected client names', () => {
    const answer = answerRenewalAssistantQuestion([
      client({ id: 'complete', name: 'Complete Client' }),
      client({ id: 'incomplete', name: 'Incomplete Client', firstWebinarAt: undefined, lastWebinarAt: undefined, feedbackScore: undefined, phone: '' }),
    ], 'What client data is missing?', now)

    expect(answer.items.some((item) => item.heading.includes('first webinar date') && item.evidence.includes('Incomplete Client'))).toBe(true)
    expect(answer.items.some((item) => item.heading.includes('feedback score'))).toBe(true)
  })

  it('does not invent an answer when a question is unsupported or data is absent', () => {
    expect(answerRenewalAssistantQuestion([client()], 'Forecast our revenue', now)).toMatchObject({ kind: 'unsupported' })
    expect(answerRenewalAssistantQuestion([], 'Who needs attention today?', now)).toMatchObject({
      kind: 'empty',
      title: 'No renewal client data is available',
    })
  })
})
