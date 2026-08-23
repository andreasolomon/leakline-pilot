import { describe, expect, it } from 'vitest'
import { daysUntilProgrammeEnd, programmeEndDate, programmePhase, recommendedRenewalAction, recommendedRenewalOutreachKind, renewalOutreachAvailability, renewalPipelineStage, renewalPipelineSummary, renewalReadiness, renewalSummary, upsellCampaignStage, upsellCampaignSummary, type RenewalClient } from './renewalCommand'

const client = (overrides: Partial<RenewalClient> = {}): RenewalClient => ({
  id: 'renewal-1',
  name: 'Example Client',
  owner: 'Client Success',
  webinarsHosted: 0,
  renewalStatus: 'not_started',
  expectedRenewalValue: 0,
  renewalCashCollected: 0,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
})

describe('Renewal Command calculations', () => {
  it('starts the 90-day programme from the first webinar rather than the payment date', () => {
    const item = client({ enrolledAt: '2026-06-01', firstWebinarAt: '2026-07-01' })
    expect(programmeEndDate(item.firstWebinarAt)).toBe('2026-09-29')
    expect(daysUntilProgrammeEnd(item, new Date('2026-07-31T15:00:00.000Z'))).toBe(60)
  })

  it('keeps paid clients awaiting activation until their first webinar happens', () => {
    const item = client({ enrolledAt: '2026-06-01', webinarsHosted: 0 })
    expect(programmePhase(item, new Date('2026-07-31T00:00:00.000Z'))).toBe('awaiting_activation')
    expect(recommendedRenewalAction(item)).toMatch(/first webinar/i)
  })

  it('makes the readiness score transparent and requires feedback before labelling it high', () => {
    const withoutFeedback = client({ firstWebinarAt: '2026-07-01', webinarsHosted: 6, lastWebinarAt: '2026-07-25' })
    expect(renewalReadiness(withoutFeedback, new Date('2026-07-27T00:00:00.000Z'))).toMatchObject({ score: 70, label: 'Needs feedback' })

    const ready = client({ firstWebinarAt: '2026-07-01', webinarsHosted: 6, lastWebinarAt: '2026-07-25', feedbackScore: 5 })
    expect(renewalReadiness(ready, new Date('2026-07-27T00:00:00.000Z'))).toEqual({
      score: 100,
      label: 'High',
      explanation: '50/50 usage · 20/20 recency · 30/30 feedback',
    })
  })

  it('does not label incomplete webinar activity as high readiness', () => {
    const incomplete = client({ webinarsHosted: 6, feedbackScore: 5 })
    expect(renewalReadiness(incomplete, new Date('2026-07-27T00:00:00.000Z'))).toMatchObject({ label: 'Needs activity' })
  })

  it('prioritises the renewal review once a client enters the final 30 days', () => {
    const item = client({
      firstWebinarAt: '2026-05-15',
      lastWebinarAt: '2026-06-20',
      webinarsHosted: 3,
      feedbackScore: 4,
    })
    expect(programmePhase(item, new Date('2026-07-27T00:00:00.000Z'))).toBe('renewal_window')
    expect(recommendedRenewalAction(item, new Date('2026-07-27T00:00:00.000Z'))).toMatch(/renewal-window review/i)
  })

  it('selects outreach from the client phase and blocks clients awaiting activation', () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const active = client({ firstWebinarAt: '2026-07-01', lastWebinarAt: '2026-07-25', webinarsHosted: 2 })
    const inactive = client({ firstWebinarAt: '2026-06-01', lastWebinarAt: '2026-07-01', webinarsHosted: 2 })
    const renewalWindow = client({ firstWebinarAt: '2026-05-15', lastWebinarAt: '2026-07-20', webinarsHosted: 5 })
    const completed = client({ firstWebinarAt: '2026-04-01', lastWebinarAt: '2026-06-20', webinarsHosted: 6 })
    const awaitingActivation = client({ enrolledAt: '2026-07-20' })

    expect(recommendedRenewalOutreachKind(active, now)).toBe('programme_check_in')
    expect(recommendedRenewalOutreachKind(inactive, now)).toBe('webinar_accountability')
    expect(recommendedRenewalOutreachKind(renewalWindow, now)).toBe('renewal_window_review')
    expect(recommendedRenewalOutreachKind(completed, now)).toBe('post_completion_review')
    expect(recommendedRenewalAction(active, now)).toMatch(/program check-in/i)
    expect(recommendedRenewalAction(renewalWindow, now)).toMatch(/renewal-window review/i)
    expect(recommendedRenewalAction(completed, now)).toMatch(/post-completion review/i)
    expect(renewalOutreachAvailability(active, now)).toMatchObject({ available: false, reason: expect.stringMatching(/final 30 days/i) })
    expect(renewalOutreachAvailability(inactive, now)).toMatchObject({ available: false, reason: expect.stringMatching(/final 30 days/i) })
    expect(renewalOutreachAvailability(renewalWindow, now).available).toBe(true)
    expect(renewalOutreachAvailability(completed, now)).toMatchObject({ available: false, reason: expect.stringMatching(/excluded/i) })
    expect(renewalOutreachAvailability(awaitingActivation, now)).toMatchObject({ available: false })
    expect(renewalOutreachAvailability({ ...active, outreachStatus: 'paused', outreachStatusReason: 'Not approved by Yonas.' }, now)).toMatchObject({ available: false, reason: 'Not approved by Yonas.' })
    expect(renewalOutreachAvailability({ ...active, outreachStatus: 'do_not_contact' }, now)).toMatchObject({ available: false, reason: expect.stringMatching(/do not contact/i) })
  })

  it('automatically moves approaching clients into the renewal-opportunity stage', () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const active = client({ firstWebinarAt: '2026-07-01', lastWebinarAt: '2026-07-20', webinarsHosted: 2 })
    const approaching = client({ firstWebinarAt: '2026-05-15', lastWebinarAt: '2026-07-20', webinarsHosted: 6 })

    expect(renewalPipelineStage(active, now)).toBe('active_programme')
    expect(renewalPipelineStage(approaching, now)).toBe('renewal_opportunity')
  })

  it('respects the explicit stages used after renewal work begins', () => {
    const item = client({
      firstWebinarAt: '2026-05-15',
      lastWebinarAt: '2026-07-20',
      webinarsHosted: 6,
      renewalStatus: 'decision_pending',
    })

    expect(renewalPipelineStage(item, new Date('2026-07-27T00:00:00.000Z'))).toBe('decision_pending')
    expect(recommendedRenewalAction(item)).toMatch(/renewal decision/i)
  })

  it('summarises the client count and commercial value in every pipeline stage', () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const pipeline = renewalPipelineSummary([
      client({ id: 'one', expectedRenewalValue: 5000 }),
      client({ id: 'two', renewalStatus: 'conversation_needed', expectedRenewalValue: 4000 }),
      client({ id: 'three', renewalStatus: 'renewed', expectedRenewalValue: 5000, renewalCashCollected: 4500 }),
    ], now)

    expect(pipeline.find((stage) => stage.stage === 'active_programme')).toMatchObject({ clientCount: 1, value: 5000 })
    expect(pipeline.find((stage) => stage.stage === 'conversation_needed')).toMatchObject({ clientCount: 1, value: 4000 })
    expect(pipeline.find((stage) => stage.stage === 'renewed')).toMatchObject({ clientCount: 1, value: 4500 })
  })

  it('summarises renewal opportunities and collected cash without counting closed clients', () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const clients = [
      client({ id: 'one', firstWebinarAt: '2026-05-15', lastWebinarAt: '2026-07-20', webinarsHosted: 6, feedbackScore: 5, expectedRenewalValue: 8000 }),
      client({ id: 'two', enrolledAt: '2026-07-01' }),
      client({ id: 'three', firstWebinarAt: '2026-04-01', renewalStatus: 'renewed', renewalCashCollected: 8000, feedbackScore: 5, webinarsHosted: 6 }),
    ]
    expect(renewalSummary(clients, now)).toEqual({
      activeClients: 1,
      awaitingActivation: 1,
      renewalOpportunities: 1,
      highReadiness: 1,
      renewalPipelineValue: 8000,
      renewalCashCollected: 8000,
    })
  })

  it('only counts genuinely open renewal stages in pipeline value', () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const clients = [
      client({ id: 'active', expectedRenewalValue: 8000 }),
      client({ id: 'opportunity', firstWebinarAt: '2026-05-15', expectedRenewalValue: 8000 }),
      client({ id: 'conversation', renewalStatus: 'conversation_needed', expectedRenewalValue: 9000 }),
      client({ id: 'renewed', renewalStatus: 'renewed', expectedRenewalValue: 8000, renewalCashCollected: 8000 }),
      client({ id: 'declined', renewalStatus: 'declined', expectedRenewalValue: 8000 }),
    ]

    expect(renewalSummary(clients, now)).toMatchObject({
      renewalOpportunities: 2,
      renewalPipelineValue: 17000,
      renewalCashCollected: 8000,
    })
  })

  it('tracks every completed upsell milestone without losing earlier funnel counts', () => {
    const clients = [
      client({ id: 'sent', upsellCampaign: { openerSentAt: '2026-08-01T10:00:00.000Z' } }),
      client({ id: 'booked', upsellCampaign: { openerSentAt: '2026-08-01T10:00:00.000Z', repliedAt: '2026-08-01T10:05:00.000Z', interestConfirmedAt: '2026-08-01T10:10:00.000Z', callOfferedAt: '2026-08-01T10:15:00.000Z', callBookedAt: '2026-08-01T10:20:00.000Z' } }),
      client({ id: 'lost', upsellCampaign: { openerSentAt: '2026-08-02T10:00:00.000Z', repliedAt: '2026-08-02T10:05:00.000Z', outcome: 'lost', outcomeAt: '2026-08-02T10:10:00.000Z', nonProceedReason: 'Timing was not right.' } }),
    ]

    expect(upsellCampaignStage(clients[0])).toBe('opener_sent')
    expect(upsellCampaignStage(clients[1])).toBe('call_booked')
    expect(upsellCampaignStage(clients[2])).toBe('lost')
    expect(upsellCampaignSummary(clients)).toEqual({ openerSent: 3, replied: 2, interestConfirmed: 1, callOffered: 1, callBooked: 1, callAttended: 0, won: 0, lost: 1 })
  })
})
