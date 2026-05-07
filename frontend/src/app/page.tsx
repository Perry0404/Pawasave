'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/hooks/use-data'
import AuthScreen from '@/components/auth-screen'
import AppShell from '@/components/app-shell'
import Logo from '@/components/logo'
import { Loader2 } from 'lucide-react'

/** Reads ?join=groupId and redirects after auth. Must be inside <Suspense>. */
function JoinRedirectHandler() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (user && !loading) {
      const joinId = searchParams.get('join')
      if (joinId) {
        router.replace(`/join/${joinId}`)
      }
    }
  }, [user, loading, searchParams, router])

  return null
}

export default function Page() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <Logo size={48} className="mx-auto mb-4" />
          <Loader2 className="w-5 h-5 animate-spin text-emerald-600 mx-auto" />
        </div>
      </div>
    )
  }

  if (!user) return <AuthScreen />

  return (
    <>
      <Suspense fallback={null}>
        <JoinRedirectHandler />
      </Suspense>
      <AppShell />
    </>
  )
}

