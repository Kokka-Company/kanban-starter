import { useCallback, useEffect, useRef, useState } from 'react'

export type PomodoroMode = 'focus' | 'break' | 'long'

export const MODE_LABELS: Record<PomodoroMode, string> = { focus: 'Focus', break: 'Short break', long: 'Long break' }

interface TimerState {
  mode: PomodoroMode
  cardId: string | null
  /** Set while running: when the session ends (epoch ms). */
  endsAt: number | null
  /** While paused: time left. */
  remainingMs: number
  /** Focus sessions finished in this cycle, for the long break. */
  sessions: number
}

interface Settings {
  focusMinutes: number
  breakMinutes: number
  longBreakMinutes: number
  longBreakEvery: number
}

const minutesOf = (mode: PomodoroMode, s: Settings) => (mode === 'focus' ? s.focusMinutes : mode === 'long' ? s.longBreakMinutes : s.breakMinutes)

function read(key: string): TimerState | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as TimerState) : null
  } catch {
    return null
  }
}

function write(key: string, state: TimerState) {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Storage blocked: the timer still works, it just won't survive a reload.
  }
}

/** Three soft beeps, made on the spot (no audio file to load). */
function chime() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC()
    ;[0, 0.28, 0.56].forEach((at, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = i === 2 ? 1046 : 784
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.25)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + at)
      osc.stop(ctx.currentTime + at + 0.3)
    })
    setTimeout(() => void ctx.close(), 1500)
  } catch {
    // No audio: the on-screen timer and the tab title still show it.
  }
}

function notify(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/favicon.ico' })
  } catch {
    // Some browsers only allow notifications from a service worker; skip.
  }
}

export function formatTimer(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * A pomodoro timer that keeps time by its end moment (not by counting ticks), so it
 * stays right in a background tab and survives a reload or a trip to another page.
 * Focus ends → chime, `onFocusDone(cardId)`, and the break starts by itself; a break
 * ends → chime and the next focus waits for you to press start.
 */
export function usePomodoro({
  storageKey,
  settings,
  nextCardId,
  onFocusDone,
  describe,
}: {
  storageKey: string
  settings: Settings
  /** The task the next focus session is for when none is chosen. */
  nextCardId: string | null
  onFocusDone: (cardId: string | null) => void
  describe: (cardId: string | null) => string
}) {
  const fresh = (mode: PomodoroMode, cardId: string | null, sessions: number): TimerState => ({
    mode,
    cardId,
    endsAt: null,
    remainingMs: minutesOf(mode, settings) * 60_000,
    sessions,
  })
  const [state, setState] = useState<TimerState>(() => read(storageKey) ?? fresh('focus', null, 0))
  const [now, setNow] = useState(() => Date.now())
  const done = useRef(onFocusDone)
  done.current = onFocusDone
  const label = useRef(describe)
  label.current = describe

  useEffect(() => write(storageKey, state), [storageKey, state])

  useEffect(() => {
    if (!state.endsAt) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [state.endsAt])

  const total = minutesOf(state.mode, settings) * 60_000
  const remaining = state.endsAt ? Math.max(0, state.endsAt - now) : Math.min(state.remainingMs, total)
  const running = Boolean(state.endsAt)
  const idle = !running && state.remainingMs >= total
  const cardId = state.mode === 'focus' && idle && !state.cardId ? nextCardId : state.cardId

  // Session over (also catches one that ended while the tab was closed).
  useEffect(() => {
    if (!state.endsAt || state.endsAt > now) return
    chime()
    if (state.mode === 'focus') {
      const sessions = state.sessions + 1
      const mode: PomodoroMode = sessions % settings.longBreakEvery === 0 ? 'long' : 'break'
      done.current(state.cardId)
      notify('Pomodoro done', `${label.current(state.cardId)} — time for a ${mode === 'long' ? 'long ' : ''}break.`)
      setState({ ...fresh(mode, null, sessions), endsAt: Date.now() + minutesOf(mode, settings) * 60_000 })
    } else {
      notify('Break over', 'Ready for the next pomodoro?')
      setState(fresh('focus', null, state.mode === 'long' ? 0 : state.sessions))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, state.endsAt])

  // While running, the tab title shows the countdown.
  useEffect(() => {
    if (!running) return
    const before = document.title
    document.title = `${formatTimer(remaining)} · ${MODE_LABELS[state.mode]}`
    return () => {
      document.title = before
    }
  }, [running, remaining, state.mode])

  const askPermission = () => {
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    } catch {
      // ignore
    }
  }

  /** Start (or resume). Passing a task starts a fresh focus session on it. */
  const start = useCallback(
    (forCard?: string) => {
      askPermission()
      setNow(Date.now())
      setState((s) => {
        if (forCard !== undefined) return { ...fresh('focus', forCard, s.sessions), endsAt: Date.now() + settings.focusMinutes * 60_000 }
        const card = s.mode === 'focus' && !s.cardId ? nextCardId : s.cardId
        return { ...s, cardId: card, endsAt: Date.now() + Math.min(s.remainingMs, minutesOf(s.mode, settings) * 60_000) }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, nextCardId],
  )

  const pause = () => setState((s) => (s.endsAt ? { ...s, endsAt: null, remainingMs: Math.max(0, s.endsAt - Date.now()) } : s))
  const reset = () => setState((s) => fresh(s.mode, s.mode === 'focus' ? s.cardId : null, s.sessions))
  /** Jump to the next phase without counting the current one. */
  const skip = () =>
    setState((s) => {
      if (s.mode !== 'focus') return fresh('focus', null, s.mode === 'long' ? 0 : s.sessions)
      return fresh((s.sessions + 1) % settings.longBreakEvery === 0 ? 'long' : 'break', null, s.sessions + 1)
    })

  return { mode: state.mode, cardId, running, idle, remaining, total, start, pause, reset, skip }
}
