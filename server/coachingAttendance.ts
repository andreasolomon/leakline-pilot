import type { CoachingParticipantRecord, CoachingSessionRecord, RenewalClientRecord, WorkspaceRecord } from './types.js'

const normaliseEmail = (value?: string) => value?.trim().toLowerCase() ?? ''
const normaliseName = (value?: string) => value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ') ?? ''

export function matchCoachingParticipants(workspace: WorkspaceRecord, sessions: CoachingSessionRecord[]) {
  const clientsByEmail = new Map(workspace.renewalClients.filter((client) => client.email).map((client) => [normaliseEmail(client.email), client]))
  const clientsByName = new Map<string, RenewalClientRecord[]>()
  for (const client of workspace.renewalClients) {
    const key = normaliseName(client.name)
    if (!key) continue
    clientsByName.set(key, [...(clientsByName.get(key) ?? []), client])
  }
  const teamEmails = new Set(workspace.coachingAttendance.settings.teamEmails.map(normaliseEmail).filter(Boolean))

  return sessions.map((session) => ({
    ...session,
    participants: session.participants.map((participant): CoachingParticipantRecord => {
      const email = normaliseEmail(participant.email)
      if (email && teamEmails.has(email)) return { ...participant, matchedClientId: undefined, matchType: 'team' }
      const emailMatch = email ? clientsByEmail.get(email) : undefined
      if (emailMatch) return { ...participant, matchedClientId: emailMatch.id, matchType: 'email' }
      const nameMatches = clientsByName.get(normaliseName(participant.name)) ?? []
      if (nameMatches.length === 1) return { ...participant, matchedClientId: nameMatches[0].id, matchType: 'name' }
      return { ...participant, matchedClientId: undefined, matchType: 'unmatched' }
    }),
  }))
}

function clientProgrammeStart(client: RenewalClientRecord) {
  return client.enrolledAt ?? client.firstWebinarAt
}

function withinClientProgramme(client: RenewalClientRecord, startedAt: string) {
  const start = clientProgrammeStart(client)
  if (!start) return false
  const startTime = Date.parse(start)
  const sessionTime = Date.parse(startedAt)
  if (!Number.isFinite(startTime) || !Number.isFinite(sessionTime) || sessionTime < startTime) return false
  return sessionTime <= startTime + 90 * 86_400_000
}

function weekStart(startedAt: string) {
  const date = new Date(startedAt)
  if (!Number.isFinite(date.getTime())) return ''
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  return date.toISOString().slice(0, 10)
}

function participantMinutesForClient(session: CoachingSessionRecord, clientId: string) {
  return session.participants
    .filter((participant) => participant.matchedClientId === clientId)
    .reduce((sum, participant) => sum + participant.durationMinutes, 0)
}

export function coachingAttendanceReport(workspace: WorkspaceRecord) {
  const sessions = matchCoachingParticipants(workspace, workspace.coachingAttendance.sessions)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
  const minimumMinutes = workspace.coachingAttendance.settings.minimumMinutes
  const requiredSessionsPerWeek = workspace.coachingAttendance.settings.requiredSessionsPerWeek
  const currentWeekStartedAt = weekStart(new Date().toISOString())
  const clients = workspace.renewalClients.map((client) => {
    const eligibleSessions = sessions.filter((session) => withinClientProgramme(client, session.startedAt))
    const weeks = new Map<string, CoachingSessionRecord[]>()
    for (const session of eligibleSessions) {
      const key = weekStart(session.startedAt)
      if (key) weeks.set(key, [...(weeks.get(key) ?? []), session])
    }
    const weeklyAttendance = [...weeks.entries()]
      .map(([weekStartedAt, weekSessions]) => {
        const attendedSessions = weekSessions.filter((session) => participantMinutesForClient(session, client.id) >= minimumMinutes)
        return { weekStartedAt, attended: attendedSessions.length >= requiredSessionsPerWeek, complete: weekStartedAt < currentWeekStartedAt, attendedSessions }
      })
      .sort((left, right) => right.weekStartedAt.localeCompare(left.weekStartedAt))
    const scoredWeeks = weeklyAttendance.filter((week) => week.complete || week.attended)
    const attendedWeeks = scoredWeeks.filter((week) => week.attended)
    const attendedSessions = attendedWeeks.flatMap((week) => week.attendedSessions)
    const lastAttendedAt = attendedSessions[0]?.startedAt
    let consecutiveMisses = 0
    for (const week of scoredWeeks) {
      if (week.attended) break
      consecutiveMisses += 1
    }
    return {
      clientId: client.id,
      name: client.name,
      email: client.email,
      owner: client.owner,
      sessionsAvailable: scoredWeeks.length,
      weeksAvailable: scoredWeeks.length,
      attended: attendedWeeks.length,
      missed: Math.max(0, scoredWeeks.length - attendedWeeks.length),
      attendanceRate: scoredWeeks.length ? Math.round((attendedWeeks.length / scoredWeeks.length) * 1000) / 10 : 0,
      lastAttendedAt,
      consecutiveMisses,
      weeklyAttendance: weeklyAttendance.map(({ attendedSessions: _sessions, ...week }) => week),
    }
  }).sort((left, right) => right.consecutiveMisses - left.consecutiveMisses || left.name.localeCompare(right.name))

  const unmatched = sessions.flatMap((session) => session.participants
    .filter((participant) => participant.matchType === 'unmatched')
    .map((participant) => ({ sessionId: session.id, sessionStartedAt: session.startedAt, ...participant })))

  return {
    connected: Boolean(workspace.credentials.zoom),
    settings: workspace.coachingAttendance.settings,
    attendanceRule: `${requiredSessionsPerWeek} qualifying coaching call${requiredSessionsPerWeek === 1 ? '' : 's'} per week`,
    sessions,
    clients,
    unmatched,
  }
}
