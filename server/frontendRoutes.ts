export type FrontendEntry = 'index.html' | 'app/index.html'

export function frontendEntryForPath(path: string): FrontendEntry | null {
  if (/^\/(?:app(?:\/.*)?|invite\/.*)$/.test(path)) return 'app/index.html'
  if (path === '/' || path === '/landing' || path === '/privacy' || path === '/terms') return 'index.html'
  return null
}
