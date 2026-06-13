'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'

// FIND-FE-04: a styled, app-consistent confirmation modal that replaces the
// native window.confirm() (which is spoofable, unstyled, and auto-dismissable).
// Promise-based so callers keep a one-line `if (!(await confirm(...))) return`.

export interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(async () => false)

export const useConfirm = (): ConfirmFn => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((input) => {
    const o = typeof input === 'string' ? { message: input } : input
    setOpts(o)
    return new Promise<boolean>((resolve) => { resolver.current = resolve })
  }, [])

  const close = (value: boolean) => {
    setOpts(null)
    resolver.current?.(value)
    resolver.current = null
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={() => close(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {opts.title && (
              <h3 className="text-lg font-bold text-slate-900 mb-2">{opts.title}</h3>
            )}
            <p className="text-sm text-slate-600 mb-6 leading-relaxed">{opts.message}</p>
            <div className="flex gap-3">
              <button
                onClick={() => close(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 font-semibold text-sm hover:bg-slate-50 transition"
              >
                {opts.cancelText || 'Cancel'}
              </button>
              <button
                onClick={() => close(true)}
                className={`flex-1 py-2.5 rounded-xl text-white font-semibold text-sm transition ${
                  opts.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {opts.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}