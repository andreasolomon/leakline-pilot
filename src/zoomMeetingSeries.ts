export type ZoomMeetingSeries = { meetingId: string; label: string }

function meetingIdFrom(value: string) {
  const linkMatch = value.match(/zoom\.us\/j\/(\d{9,12})/i)
  if (linkMatch) return linkMatch[1]
  const numberMatch = value.match(/(?:^|\D)((?:\d[ -]?){9,12})(?:\D|$)/)
  return numberMatch?.[1].replace(/\D/g, '') ?? ''
}

export function parseZoomMeetingSeries(value: string): ZoomMeetingSeries[] {
  return value.split('\n').map((line, index) => {
    const trimmed = line.trim()
    const separator = trimmed.indexOf('|')
    const label = separator >= 0 ? trimmed.slice(0, separator).trim() : `Coaching call ${index + 1}`
    const meetingValue = separator >= 0 ? trimmed.slice(separator + 1).trim() : trimmed
    return { label, meetingId: meetingIdFrom(meetingValue) }
  }).filter((series) => series.label && series.meetingId)
}

export function formatZoomMeetingSeries(series: ZoomMeetingSeries[]) {
  return series.map((item) => `${item.label} | ${item.meetingId}`).join('\n')
}
