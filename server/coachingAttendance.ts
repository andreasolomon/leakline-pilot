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

export function coachingAttendanceReport(workspace: WorkspaceRecord) {
  const sessions = matchCoachingParticipants(workspace, workspace.coachingAttendance.sessions)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
  const minimumMinutes = workspace.coachingAttendance.settings.minimumMinutes
  const clients = workspace.renewalClients.map((client) => {
    const eligibleSessions = sessions.filter((session) => withinClientProgramme(client, session.startedAt))
    const attendedSessions = eligibleSessions.filter((session) => session.participants
      .filter((participant) => participant.matchedClientId === client.id)
      .reduce((sum, participant) => sum + participant.durationMinutes, 0) >= minimumMinutes)
    const lastAttendedAt = attendedSessions[0]?.startedAt
    let consecutiveMisses = 0
    for (const session of eligibleSessions) {
      if (attendedSessions.some((attended) => attended.id === session.id)) break
      consecutiveMisses += 1
    }
    return {
      clientId: client.id,
      name: client.name,
      email: client.email,
      owner: client.owner,
      sessionsAvailable: eligibleSessions.length,
      attended: attendedSessions.length,
      missed: Math.max(0, eligibleSessions.length - attendedSessions.length),
      attendanceRate: eligibleSessions.length ? Math.round((attendedSessions.length / eligibleSessions.length) * 1000) / 10 : 0,
      lastAttendedAt,
      consecutiveMisses,
    }
  }).sort((left, right) => right.consecutiveMisses - left.consecutiveMisses || left.name.localeCompare(right.name))

  const unmatched = sessions.flatMap((session) => session.participants
    .filter((participant) => participant.matchType === 'unmatched')
    .map((participant) => ({ sessionId: session.id, sessionStartedAt: session.startedAt, ...participant })))

  return {
    connected: Boolean(workspace.credentials.zoom),
    settings: workspace.coachingAttendance.settings,
    sessions,
    clients,
    unmatched,
  }
}
