import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import AuthGate from './AuthGate'
import './styles.css'
import './design-lab.css'
import './theme-b.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>{({ user, onLogout }) => <App user={user} onLogout={onLogout} />}</AuthGate>
  </StrictMode>,
)
