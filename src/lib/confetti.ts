/**
 * A one-shot confetti burst on a full-screen canvas, no library. Two cannons fire
 * from the bottom corners; the canvas removes itself when the last piece falls.
 * People who ask for reduced motion get a short, gentle sprinkle instead.
 */
const COLORS = ['#34D399', '#86DB9D', '#81CCFB', '#FBBF24', '#FF9933', '#A78BFA', '#F472B6', '#ffffff']

interface Piece {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  color: string
  spin: number
  angle: number
  wobble: number
  shape: 'rect' | 'circle'
}

export function confetti() {
  if (typeof document === 'undefined') return
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '100' })
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    canvas.remove()
    return
  }
  const dpr = window.devicePixelRatio || 1
  const resize = () => {
    canvas.width = window.innerWidth * dpr
    canvas.height = window.innerHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  const w = window.innerWidth
  const h = window.innerHeight
  const pieces: Piece[] = []
  const make = (x: number, y: number, dir: number, n: number, power: number) => {
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (dir ? dir * (0.25 + Math.random() * 0.55) : (Math.random() - 0.5) * 1.1)
      const speed = power * (0.55 + Math.random() * 0.6)
      pieces.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 6 + Math.random() * 7,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        spin: (Math.random() - 0.5) * 0.35,
        angle: Math.random() * Math.PI,
        wobble: Math.random() * Math.PI * 2,
        shape: Math.random() < 0.7 ? 'rect' : 'circle',
      })
    }
  }
  if (reduced) {
    for (let i = 0; i < 60; i++) make(Math.random() * w, -20, 0, 1, 0)
  } else {
    const power = Math.min(28, Math.max(18, h / 38))
    make(0, h, 1, 140, power)
    make(w, h, -1, 140, power)
    setTimeout(() => make(w / 2, h, 0, 90, power * 1.05), 250)
  }

  const gravity = reduced ? 0.06 : 0.42
  const drag = 0.985
  const start = performance.now()
  const frame = (t: number) => {
    ctx.clearRect(0, 0, w, h)
    let alive = 0
    for (const p of pieces) {
      p.vx *= drag
      p.vy = p.vy * drag + gravity
      p.wobble += 0.12
      p.x += p.vx + Math.sin(p.wobble) * 0.8
      p.y += p.vy
      p.angle += p.spin
      if (p.y > h + 40) continue
      alive++
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.angle)
      ctx.fillStyle = p.color
      if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.6 + Math.abs(Math.cos(p.wobble))))
      else {
        ctx.beginPath()
        ctx.arc(0, 0, p.size / 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
    if ((alive || t - start < 400) && t - start < 7000) requestAnimationFrame(frame)
    else {
      window.removeEventListener('resize', resize)
      canvas.remove()
    }
  }
  requestAnimationFrame(frame)
}
