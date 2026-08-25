import { describe, expect, it } from 'vitest'
import { parseZoomMeetingSeries } from './zoomMeetingSeries'

describe('Zoom meeting-series input', () => {
  it('extracts the two unique Launch Webinars meeting IDs from labelled links', () => {
    expect(parseZoomMeetingSeries([
      'Fred Monday and Wednesday | https://us06web.zoom.us/j/82769043003',
      'Yonas Friday | https://us05web.zoom.us/j/86912599864',
    ].join('\n'))).toEqual([
      { label: 'Fred Monday and Wednesday', meetingId: '82769043003' },
      { label: 'Yonas Friday', meetingId: '86912599864' },
    ])
  })
})
