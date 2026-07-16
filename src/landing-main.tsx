import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import LandingPage from './LandingPage'
import LegalPage from './LegalPage'
import './styles.css'
import './theme-b.css'

const path = window.location.pathname
const content = path === '/privacy' ? <LegalPage page="privacy" /> : path === '/terms' ? <LegalPage page="terms" /> : <LandingPage />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {content}
  </StrictMode>,
)
