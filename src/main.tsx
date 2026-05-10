import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  let refreshing = false
  const hadController = Boolean(navigator.serviceWorker.controller)

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return
    if (refreshing) return
    refreshing = true
    window.location.reload()
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        const activateWaitingWorker = () => {
          if (!registration.waiting) return
          registration.waiting.postMessage({ type: 'TERRAIN_SKIP_WAITING' })
        }

        registration.addEventListener('updatefound', () => {
          const worker = registration.installing
          if (!worker) return

          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              activateWaitingWorker()
            }
          })
        })

        activateWaitingWorker()

        const checkForUpdate = () => {
          if (navigator.onLine) registration.update().catch(() => undefined)
        }

        checkForUpdate()
        window.addEventListener('online', checkForUpdate)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate()
        })
      })
      .catch(() => undefined)
  })
}
