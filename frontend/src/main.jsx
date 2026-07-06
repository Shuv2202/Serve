import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Kitchen from './Kitchen.jsx'

// Simple client-side routing check
const isKitchen = window.location.pathname === '/kitchen' || new URLSearchParams(window.location.search).get('view') === 'kitchen';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isKitchen ? <Kitchen /> : <App />}
  </StrictMode>,
)
