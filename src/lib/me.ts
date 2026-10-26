import { createContext, useContext } from 'react'
import type { Me } from './api'

export const MeContext = createContext<{ me: Me; reload: () => Promise<void> } | null>(null)

export function useMe() {
  const ctx = useContext(MeContext)
  if (!ctx) throw new Error('useMe outside MeContext')
  return ctx
}
