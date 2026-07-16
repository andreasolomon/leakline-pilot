export const publicContactEmail = String(import.meta.env.VITE_PUBLIC_CONTACT_EMAIL ?? '').trim()

export const contactHref = publicContactEmail ? `mailto:${publicContactEmail}` : '/#apply'
