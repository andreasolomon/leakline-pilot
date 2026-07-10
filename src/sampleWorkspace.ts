import appointmentsCsv from '../sample-data/appointments.csv?raw'
import closersCsv from '../sample-data/closers.csv?raw'
import dealsCsv from '../sample-data/deals.csv?raw'
import leadsCsv from '../sample-data/leads.csv?raw'
import paymentsCsv from '../sample-data/payments.csv?raw'
import { normaliseCsv, type ImportWorkspace } from './csvEngine'

export function buildSampleWorkspace(): ImportWorkspace {
  return {
    leads: normaliseCsv('leads', 'leads.csv', leadsCsv),
    appointments: normaliseCsv('appointments', 'appointments.csv', appointmentsCsv),
    deals: normaliseCsv('deals', 'deals.csv', dealsCsv),
    payments: normaliseCsv('payments', 'payments.csv', paymentsCsv),
    closers: normaliseCsv('closers', 'closers.csv', closersCsv),
  }
}
