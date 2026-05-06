'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatNaira } from '@/lib/format'
import { Users, Loader2, CheckCircle2, XCircle, ArrowLeft } from 'lucide-react'
import Logo from '@/components/logo'

const supabase = createClient()

interface GroupInfo {
  id: string
  name: string
  contribution_amount_kobo: number
  cycle_period: string
  max_members: number
  status: 'forming' | 'active' | 'completed'
  current_cycle: number
  member_count: number
}

export default function JoinPage({ params }: { params: { groupId: string } }) {
  const { groupId } = params
  const router = useRouter()

  const [group, setGroup]     = useState<GroupInfo | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [user, setUser]       = useState<any>(null)
  const [busy, setBusy]       = useState(false)
  const [joined, setJoined]   = useState(false)
  const [feedback, setFeedback] = useState('')

  // Fetch group info (unauthenticated API route)
  useEffect(() => {
    fetch(`/api/esusu/group/${groupId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setLoadErr(data.error)
        else setGroup(data)
      })
      .catch(() => setLoadErr('Failed to load circle'))
  }, [groupId])

  // Get current auth user
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const handleJoin = async () => {
    if (!user) {
      // Redirect to auth, store intended destination
      router.push(`/?join=${groupId}`)
      return
    }
    if (!group) return
    setBusy(true)
    const { data, error } = await supabase.rpc('join_esusu_group', {
      p_group_id: groupId,
      p_user_id:  user.id,
    })
    setBusy(false)
    if (error) {
      setFeedback(error.message)
      return
    }
    if (!data?.ok) {
      setFeedback(data?.error || 'Could not join circle')
      return
    }
    setJoined(true)
    // Redirect to app after 2 seconds
    setTimeout(() => router.push('/'), 2000)
  }

  const spotsLeft = group ? group.max_members - group.member_count : 0
  const isFull    = group ? spotsLeft <= 0 : false

  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <Logo size={40} />
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">

          {/* Loading */}
          {!group && !loadErr && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          )}

          {/* Error */}
          {loadErr && (
            <div className="p-6 text-center">
              <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-700">{loadErr}</p>
              <button
                onClick={() => router.push('/')}
                className="mt-4 text-sm text-emerald-600 font-medium flex items-center gap-1 mx-auto"
              >
                <ArrowLeft className="w-4 h-4" /> Back to PawaSave
              </button>
            </div>
          )}

          {/* Success */}
          {joined && (
            <div className="p-6 text-center">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
              <p className="text-base font-bold text-slate-900 mb-1">You&apos;re in!</p>
              <p className="text-sm text-slate-500">Redirecting to your circles…</p>
            </div>
          )}

          {/* Group info */}
          {group && !joined && (
            <>
              <div className="bg-gradient-to-br from-purple-600 to-violet-700 p-6 text-white">
                <p className="text-xs text-purple-200 font-medium mb-1 uppercase tracking-wide">
                  You&apos;re invited to join
                </p>
                <h1 className="text-xl font-bold">{group.name}</h1>
                <p className="text-purple-200 text-sm mt-1 capitalize">{group.cycle_period} contributions</p>
              </div>

              <div className="p-5 space-y-4">
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="bg-slate-50 rounded-xl py-3">
                    <p className="text-base font-bold text-slate-900">{formatNaira(group.contribution_amount_kobo)}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">Per cycle</p>
                  </div>
                  <div className="bg-slate-50 rounded-xl py-3">
                    <p className="text-base font-bold text-slate-900">{group.member_count}/{group.max_members}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">Members</p>
                  </div>
                  <div className={`rounded-xl py-3 ${isFull ? 'bg-red-50' : 'bg-emerald-50'}`}>
                    <p className={`text-base font-bold ${isFull ? 'text-red-600' : 'text-emerald-700'}`}>
                      {isFull ? 'Full' : spotsLeft}
                    </p>
                    <p className={`text-[11px] mt-0.5 ${isFull ? 'text-red-400' : 'text-emerald-500'}`}>
                      {isFull ? 'No spots' : 'Spots left'}
                    </p>
                  </div>
                </div>

                {/* Status */}
                {group.status === 'completed' && (
                  <p className="text-sm text-slate-500 text-center bg-slate-50 rounded-xl py-2">
                    This circle has completed all payouts.
                  </p>
                )}

                {/* Feedback */}
                {feedback && (
                  <p className="text-sm text-red-600 bg-red-50 rounded-xl px-4 py-2.5">{feedback}</p>
                )}

                {/* Join / Sign in */}
                {group.status !== 'completed' && !isFull && (
                  <button
                    onClick={handleJoin}
                    disabled={busy}
                    className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3.5 rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60"
                  >
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Users className="w-4 h-4" />
                    )}
                    {user ? 'Join Circle' : 'Sign in to Join'}
                  </button>
                )}

                <p className="text-[11px] text-slate-400 text-center leading-relaxed">
                  Esusu is a traditional rotating savings system. Each cycle one member receives the full pot.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
