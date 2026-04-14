'use client'

import { useAuth } from '@/hooks/use-data'
import AuthScreen from '@/components/auth-screen'
import AppShell from '@/components/app-shell'
import { Loader2 } from 'lucide-react'

export default function Page() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white text-xl font-bold">P</span>
          </div>
          <Loader2 className="w-5 h-5 animate-spin text-emerald-600 mx-auto" />
        </div>
      </div>
    )
  }

  if (!user) return <AuthScreen />

  return <AppShell />
}
