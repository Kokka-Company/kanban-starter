import { useEffect, useRef } from 'react'

/**
 * Re-run `refresh` every `ms` while the tab is visible, and right away when the
 * person comes back to the tab — so changes other people make show up without a
 * reload. Paused in background tabs to save database requests.
 */
export function useAutoRefresh(refresh: () => void | Promise<void>, ms = 15_000) {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void latest.current()
    }
    const id = window.setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [ms])
}
