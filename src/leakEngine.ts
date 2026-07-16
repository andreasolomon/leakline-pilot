export type LeakSeverity = 'critical' | 'warning' | 'opportunity'

export type Leak = {
  id: number
  type: string
  title: string
  description: string
  impact: number
  severity: LeakSeverity
  owner: string
  count: number
  action: string
  periodLabel: string
  evidence: string[]
  suggestedActions: string[]
  breakdown?: { label: string; current: string; baseline: string; signal: string }[]
  relatedRecords?: Array<{
    id?: string
    name: string
    email?: string
    source?: string
    owner?: string
    status?: string
    createdAt?: string
  }>
}

export type DemoSnapshot = {
  optInBooking: { optedIn: number; booked: number; bookingWindowHours: number; estimatedImpact: number }
  followUps: { inactiveQualified: number; promisedDecisionDates: number; estimatedImpact: number }
  attendance: { campaign: string; campaignShowRate: number; teamShowRate: number; longWaitBookings: number; estimatedImpact: number }
  collections: { overdueInstalments: number; unrecoveredAccounts: number; minDaysLate: number; maxDaysLate: number; estimatedImpact: number }
  conversion: { currentRate: number; baselineRate: number; affectedCalls: number; estimatedImpact: number }
  retention: { strongerSource: string; weakerSource: string; retainedRevenueLift: number; comparableLeads: number; estimatedImpact: number }
}

export const demoSnapshot: DemoSnapshot = {
  optInBooking: { optedIn: 164, booked: 102, bookingWindowHours: 48, estimatedImpact: 18600 },
  followUps: { inactiveQualified: 12, promisedDecisionDates: 4, estimatedImpact: 11750 },
  attendance: { campaign: 'Meta Campaign B', campaignShowRate: 48, teamShowRate: 73, longWaitBookings: 29, estimatedImpact: 9800 },
  collections: { overdueInstalments: 4, unrecoveredAccounts: 2, minDaysLate: 2, maxDaysLate: 11, estimatedImpact: 7200 },
  conversion: { currentRate: 24, baselineRate: 31, affectedCalls: 18, estimatedImpact: 5500 },
  retention: { strongerSource: 'YouTube', weakerSource: 'Meta', retainedRevenueLift: 22, comparableLeads: 34, estimatedImpact: 4000 },
}

export function detectLeaks(snapshot: DemoSnapshot): Leak[] {
  const detected: Leak[] = []

  const unbookedLeads = Math.max(0, snapshot.optInBooking.optedIn - snapshot.optInBooking.booked)
  const bookingRate = snapshot.optInBooking.optedIn ? Math.round(snapshot.optInBooking.booked / snapshot.optInBooking.optedIn * 100) : 0
  if (unbookedLeads > 0) detected.push({
    id: 6, type: 'Booking gap', title: `${unbookedLeads} opted-in leads have not booked`,
    description: `${snapshot.optInBooking.booked} of ${snapshot.optInBooking.optedIn} new leads booked within ${snapshot.optInBooking.bookingWindowHours} hours—a ${bookingRate}% opt-in-to-booking rate.`,
    impact: snapshot.optInBooking.estimatedImpact, severity: 'critical', owner: 'Setter / SDR',
    count: unbookedLeads, action: 'Review unbooked leads', periodLabel: 'This month',
    evidence: [`${snapshot.optInBooking.optedIn} leads opted in`, `${snapshot.optInBooking.booked} booked within ${snapshot.optInBooking.bookingWindowHours} hours`, `${unbookedLeads} reached the end of the booking window without an appointment`],
    suggestedActions: [`Work the ${unbookedLeads}-lead unbooked queue within 24 hours, starting with the newest high-intent opt-ins`, 'Run a three-touch booking recovery sequence across phone, SMS and email over the next 48 hours', 'Record recovered bookings against this case and compare the 7-day booking rate by source'],
    breakdown: [{ label: 'All opt-ins', current: `${bookingRate}%`, baseline: '70%', signal: `${bookingRate - 70} pts` }],
    relatedRecords: [
      { id: 'lead-demo-101', name: 'Sofia Bennett', email: 'sofia.bennett@example.com', source: 'Meta Campaign B', owner: 'Ava Brooks', status: '48h booking window passed', createdAt: '2026-06-20T09:14:00Z' },
      { id: 'lead-demo-102', name: 'Marcus Reed', email: 'marcus.reed@example.com', source: 'YouTube Organic', owner: 'Noah Carter', status: 'SMS sent · no response', createdAt: '2026-06-20T08:42:00Z' },
      { id: 'lead-demo-103', name: 'Elena Woods', email: 'elena.woods@example.com', source: 'Webinar', owner: 'Ava Brooks', status: 'Booking page viewed', createdAt: '2026-06-19T18:05:00Z' },
      { id: 'lead-demo-104', name: 'Daniel Price', email: 'daniel.price@example.com', source: 'Meta Campaign B', owner: 'Noah Carter', status: 'Call attempt due', createdAt: '2026-06-19T16:28:00Z' },
      { id: 'lead-demo-105', name: 'Naomi Clarke', email: 'naomi.clarke@example.com', source: 'Referral', owner: 'Ava Brooks', status: 'Email opened twice', createdAt: '2026-06-19T13:37:00Z' },
      { id: 'lead-demo-106', name: 'Isaac Morgan', email: 'isaac.morgan@example.com', source: 'YouTube Organic', owner: 'Noah Carter', status: 'No booking activity', createdAt: '2026-06-18T20:11:00Z' },
      { id: 'lead-demo-107', name: 'Maya Collins', email: 'maya.collins@example.com', source: 'Meta Campaign B', owner: 'Ava Brooks', status: 'Reminder sequence queued', createdAt: '2026-06-18T17:46:00Z' },
      { id: 'lead-demo-108', name: 'Owen Hall', email: 'owen.hall@example.com', source: 'Webinar', owner: 'Noah Carter', status: 'Setter follow-up overdue', createdAt: '2026-06-18T12:22:00Z' },
    ],
  })

  if (snapshot.followUps.inactiveQualified > 0) detected.push({
    id: 1, type: 'Follow-up', title: 'High-value opportunities have no next action',
    description: `${snapshot.followUps.inactiveQualified} qualified opportunities have been inactive for 3+ days. ${snapshot.followUps.promisedDecisionDates} mentioned a specific decision date.`,
    impact: snapshot.followUps.estimatedImpact, severity: 'critical', owner: 'Sales team',
    count: snapshot.followUps.inactiveQualified, action: 'Open recovery queue', periodLabel: 'This month',
    evidence: ['12 qualified opportunities have had no activity for at least 3 days', '4 prospects stated a specific decision date', 'Combined open opportunity value is $47,000'],
    suggestedActions: ['Assign every opportunity an owner, dated next step and decision deadline before the next sales stand-up', 'Contact the four prospects whose decision date has passed and record the outcome of every attempt', 'Review the queue after 7 days and record pipeline value recovered, lost or still blocked'],
  })

  if (snapshot.attendance.campaignShowRate < snapshot.attendance.teamShowRate - 15) detected.push({
    id: 2, type: 'Attendance', title: `${snapshot.attendance.campaign} is generating costly no-shows`,
    description: `This month, ${snapshot.attendance.campaignShowRate}% of calls booked through ${snapshot.attendance.campaign} were attended, compared with the team baseline of ${snapshot.attendance.teamShowRate}% across all existing campaigns. Most Campaign B bookings are 5+ days ahead.`,
    impact: snapshot.attendance.estimatedImpact, severity: 'critical', owner: 'Growth',
    count: snapshot.attendance.longWaitBookings, action: 'Inspect campaign', periodLabel: 'This month',
    evidence: ['25 of 52 Campaign B bookings attended', '318 of 437 bookings attended across all campaigns', '29 Campaign B calls were booked 5 or more days ahead'],
    suggestedActions: ['Launch a same-day rebooking sequence for Campaign B no-shows and assign every record to a setter', 'Test a shorter booking window plus a 24-hour confirmation step for the next 7 days', 'Record recovered appointments and compare show-rate movement against the current baseline'],
    breakdown: [{ label: 'Meta Campaign B', current: '48%', baseline: '73%', signal: '−25 pts' }, { label: 'YouTube Organic', current: '81%', baseline: '73%', signal: '+8 pts' }, { label: 'Referral', current: '79%', baseline: '73%', signal: '+6 pts' }],
  })

  if (snapshot.collections.overdueInstalments > 0) detected.push({
    id: 3, type: 'Collection', title: `${snapshot.collections.overdueInstalments} instalments are overdue`,
    description: `Payments are ${snapshot.collections.minDaysLate}–${snapshot.collections.maxDaysLate} days overdue. ${snapshot.collections.unrecoveredAccounts} accounts have no recorded recovery attempt.`,
    impact: snapshot.collections.estimatedImpact, severity: 'warning', owner: 'Finance',
    count: snapshot.collections.overdueInstalments, action: 'Review payments', periodLabel: 'This month',
    evidence: ['4 instalments are between 2 and 11 days overdue', '2 accounts have no recovery attempt logged', '$7,200 remains contractually due'],
    suggestedActions: ['Retry every eligible failed payment today and assign the untouched accounts to a named owner', 'Contact unresolved accounts within one business day with a payment link or approved plan option', 'Record cash recovered, balances rescheduled and write-offs before closing the case'],
  })

  if (snapshot.conversion.currentRate < snapshot.conversion.baselineRate - 5) detected.push({
    id: 4, type: 'Conversion', title: 'Qualified-call conversion dropped this week',
    description: `Team close rate fell from ${snapshot.conversion.baselineRate}% to ${snapshot.conversion.currentRate}%. Pricing objections increased across two closers.`,
    impact: snapshot.conversion.estimatedImpact, severity: 'warning', owner: 'Maya Chen',
    count: snapshot.conversion.affectedCalls, action: 'View call pattern', periodLabel: 'This week',
    evidence: ['18 qualified calls were reviewed', 'Jordan Lee and Theo Grant had the largest declines', 'Pricing objections appeared in 16 calls, up from 8 last week'],
    suggestedActions: ['Review the seven strongest pricing-objection examples', 'Coach Jordan and Theo using successful calls from Alex', 'Recheck performance after 10 additional qualified calls'],
    breakdown: [{ label: 'Jordan Lee', current: '24%', baseline: '32%', signal: '−8 pts' }, { label: 'Theo Grant', current: '18%', baseline: '27%', signal: '−9 pts' }, { label: 'Team', current: '24%', baseline: '31%', signal: '−7 pts' }],
  })

  if (snapshot.retention.retainedRevenueLift >= 15) detected.push({
    id: 5, type: 'Retention', title: `${snapshot.retention.strongerSource} leads retain more revenue`,
    description: `${snapshot.retention.strongerSource} leads produce ${snapshot.retention.retainedRevenueLift}% higher 60-day retained revenue than ${snapshot.retention.weakerSource} leads at a similar acquisition cost.`,
    impact: snapshot.retention.estimatedImpact, severity: 'opportunity', owner: 'Growth',
    count: snapshot.retention.comparableLeads, action: 'Compare sources', periodLabel: 'Trailing 60 days',
    evidence: ['34 mature customers were compared', 'Acquisition cost was within 4% between sources', 'YouTube produced fewer refunds and payment defaults'],
    suggestedActions: ['Review the highest-retaining YouTube messages', 'Test reallocating 10% of paid budget toward YouTube', 'Monitor the result using a 60-day maturity window'],
  })

  return detected.sort((a, b) => b.impact - a.impact)
}
