import type { CallRecord, DatasetImport, IntegrationWorkspace, NormalizedRow, ProviderId, RecordCounts } from './types.js'
import { syncFathom, syncGoogleCalendar, syncHighLevel, syncStripe } from './providers.js'

type SandboxResult = {
  workspace: IntegrationWorkspace
  calls?: CallRecord[]
  accountLabel: string
  recordCounts: RecordCounts
}

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function counts(workspace: IntegrationWorkspace, calls: CallRecord[] = []): RecordCounts {
  const result: RecordCounts = {}
  for (const [kind, dataset] of Object.entries(workspace) as Array<[DatasetImport['kind'], DatasetImport | undefined]>) {
    if (dataset) result[kind] = dataset.rows.length
  }
  if (calls.length) result.calls = calls.length
  return result
}

function relabelSandbox(dataset: DatasetImport | undefined) {
  if (!dataset) return dataset
  return { ...dataset, fileName: dataset.fileName.replace('live sync', 'sandbox sync') }
}

export async function sandboxSync(provider: ProviderId): Promise<SandboxResult> {
  if (provider === 'stripe') {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/charges')) return reply({ has_more: false, data: [
        { id: 'ch_sbx_paid_1', amount: 420000, amount_refunded: 0, currency: 'usd', created: 1_781_308_800, paid: true, status: 'succeeded', payment_intent: 'pi_sbx_1', billing_details: { name: 'Maya Brown' }, metadata: { deal_id: 'D-SBX-1' } },
        { id: 'ch_sbx_refund_1', amount: 300000, amount_refunded: 75000, currency: 'usd', created: 1_781_395_200, paid: true, status: 'succeeded', payment_intent: 'pi_sbx_2', billing_details: { email: 'owen@example.com' }, metadata: { deal_id: 'D-SBX-2' } },
        { id: 'ch_sbx_failed_1', amount: 240000, amount_refunded: 0, currency: 'usd', created: 1_781_481_600, paid: false, status: 'failed', failure_message: 'Card declined', billing_details: { name: 'Nina Patel' }, metadata: { deal_id: 'D-SBX-3' } },
      ] })
      if (url.includes('/invoices')) return reply({ has_more: false, data: [
        { id: 'in_sbx_overdue_1', status: 'open', amount_remaining: 180000, currency: 'usd', due_date: 1_781_049_600, customer_name: 'Leo Carter', metadata: { deal_id: 'D-SBX-4' } },
      ] })
      return reply({})
    }
    const payments = relabelSandbox(await syncStripe({ secretKey: 'sk_test_sandbox' }, fetcher as typeof fetch))
    const workspace = { payments }
    return { workspace, accountLabel: 'Stripe sandbox data', recordCounts: counts(workspace) }
  }

  if (provider === 'highlevel') {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/contacts/')) return reply({ contacts: [
        { id: 'L-SBX-1', contactName: 'Maya Brown', email: 'maya@example.com', source: 'Meta', assignedTo: 'U-SBX-1', type: 'opt-in', dateAdded: '2026-06-01T09:00:00Z', dateUpdated: '2026-06-01T10:00:00Z' },
        { id: 'L-SBX-2', contactName: 'Owen Price', email: 'owen@example.com', source: 'Webinar', assignedTo: 'U-SBX-2', type: 'opt-in', dateAdded: '2026-06-03T11:00:00Z', dateUpdated: '2026-06-03T11:30:00Z' },
        { id: 'L-SBX-3', contactName: 'Nina Patel', email: 'nina@example.com', source: 'Referral', assignedTo: 'U-SBX-1', type: 'new', dateAdded: '2026-06-05T13:00:00Z', dateUpdated: '2026-06-05T13:00:00Z' },
      ] })
      if (url.includes('/opportunities/search')) return reply({ opportunities: [
        { id: 'D-SBX-1', contactId: 'L-SBX-1', name: 'Maya Coaching Deal', status: 'won', monetaryValue: 12000, assignedTo: 'U-SBX-1', updatedAt: '2026-06-08T12:00:00Z' },
        { id: 'D-SBX-2', contactId: 'L-SBX-2', name: 'Owen Consulting Deal', status: 'lost', monetaryValue: 9000, assignedTo: 'U-SBX-2', updatedAt: '2026-06-09T12:00:00Z' },
        { id: 'D-SBX-3', contactId: 'L-SBX-3', name: 'Nina Accelerator Deal', status: 'open', monetaryValue: 6500, assignedTo: 'U-SBX-1', pipelineStageId: 'stage-booked', updatedAt: '2026-06-10T12:00:00Z' },
      ] })
      if (url.includes('/opportunities/pipelines')) return reply({ pipelines: [{ stages: [{ id: 'stage-booked', name: 'Booked call' }] }] })
      if (url.includes('/users/')) return reply({ users: [
        { id: 'U-SBX-1', name: 'Alex Morgan', email: 'alex@example.com' },
        { id: 'U-SBX-2', name: 'Sam Rivera', email: 'sam@example.com' },
      ] })
      return reply({})
    }
    const result = await syncHighLevel({ accessToken: 'sandbox-token', locationId: 'sandbox-location' }, fetcher as typeof fetch)
    const workspace = { leads: relabelSandbox(result.leads), deals: relabelSandbox(result.deals), closers: relabelSandbox(result.closers) }
    return { workspace, accountLabel: 'GoHighLevel sandbox data', recordCounts: counts(workspace) }
  }

  if (provider === 'google-calendar') {
    const fetcher = async () => reply({ items: [
      { id: 'A-SBX-1', status: 'confirmed', start: { dateTime: '2026-06-07T10:00:00Z' }, attendees: [{ email: 'maya@example.com' }], organizer: { displayName: 'Alex Morgan' }, extendedProperties: { private: { lead_id: 'L-SBX-1', attendance_status: 'attended' } } },
      { id: 'A-SBX-2', status: 'confirmed', start: { dateTime: '2026-06-08T14:00:00Z' }, attendees: [{ email: 'owen@example.com' }], organizer: { displayName: 'Sam Rivera' }, extendedProperties: { private: { lead_id: 'L-SBX-2', attendance_status: 'no-show' } } },
      { id: 'A-SBX-3', status: 'confirmed', start: { dateTime: '2026-06-09T15:30:00Z' }, attendees: [{ email: 'nina@example.com' }], organizer: { displayName: 'Alex Morgan' }, extendedProperties: { private: { lead_id: 'L-SBX-3', attendance_status: 'booked' } } },
    ] })
    const result = await syncGoogleCalendar({ accessToken: 'sandbox-access', expiresAt: Date.now() + 3600000 }, 'sandbox-client', 'sandbox-secret', fetcher as typeof fetch)
    const workspace = { appointments: relabelSandbox(result.appointments) }
    return { workspace, accountLabel: 'Google Calendar sandbox data', recordCounts: counts(workspace) }
  }

  const fetcher = async () => reply({ items: [
    { recording_id: 'R-SBX-1', title: 'Maya sales call', recording_start_time: '2026-06-07T10:00:00Z', recorded_by: { name: 'Alex Morgan' }, calendar_invitees: [{ email: 'maya@example.com' }], transcript: [{ speaker: { display_name: 'Lead' }, text: 'The price feels high, but I can see the value.' }, { speaker: { display_name: 'Closer' }, text: 'Let us compare the payment plan with the expected return.' }], default_summary: { markdown_formatted: 'Price objection handled with ROI framing.' }, share_url: 'https://fathom.video/share/R-SBX-1' },
    { recording_id: 'R-SBX-2', title: 'Owen follow-up call', recording_start_time: '2026-06-08T14:00:00Z', recorded_by: { name: 'Sam Rivera' }, calendar_invitees: [{ email: 'owen@example.com' }], transcript: [{ speaker: { display_name: 'Lead' }, text: 'I need to talk to my partner before deciding.' }], default_summary: { markdown_formatted: 'Decision-maker objection unresolved.' }, share_url: 'https://fathom.video/share/R-SBX-2' },
  ] })
  const calls = await syncFathom({ apiKey: 'sandbox-fathom-key' }, fetcher as typeof fetch)
  return { workspace: {}, calls, accountLabel: 'Fathom sandbox data', recordCounts: counts({}, calls) }
}
