import { createRoot } from 'react-dom/client'
import { WatchdogConsole } from './console.tsx'
import css from './console.css?raw'

const style = document.createElement('style'); style.textContent = css; document.head.append(style)
const container = document.getElementById('watchdog-root')
if (container) createRoot(container).render(<WatchdogConsole />)
