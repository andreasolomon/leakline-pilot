const normaliseWorkspaceName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

export function isRenewalPilotClient(name: string, clientName: string) {
  return [name, clientName].some((value) => normaliseWorkspaceName(value) === 'launchwebinars')
}
