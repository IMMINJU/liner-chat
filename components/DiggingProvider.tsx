'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

type DiggingState = {
  busyTrackId: string | null
  begin: (trackId: string) => void
  end: () => void
}

const Ctx = createContext<DiggingState | null>(null)

export function DiggingProvider({ children }: { children: ReactNode }) {
  const [busyTrackId, setBusyTrackId] = useState<string | null>(null)
  return (
    <Ctx.Provider
      value={{
        busyTrackId,
        begin: (id) => setBusyTrackId(id),
        end: () => setBusyTrackId(null),
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useDigging(): DiggingState {
  const ctx = useContext(Ctx)
  if (!ctx) {
    // Allow the button to render outside a provider (e.g. /settings); fall
    // back to a no-op state that still permits a single click.
    return {
      busyTrackId: null,
      begin: () => {},
      end: () => {},
    }
  }
  return ctx
}
