import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
import { ensureAimyDesktopBridge } from './lib/tauriBridge'
import { App } from './App'
import { MeetingPromptWindow } from './components/MeetingPrompt'

ensureAimyDesktopBridge()

const isPromptRoute = window.location.hash.includes('meeting-prompt')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPromptRoute ? <MeetingPromptWindow /> : <App />}
  </React.StrictMode>
)
