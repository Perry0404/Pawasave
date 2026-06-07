import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code       = searchParams.get('code')
  const tokenHash  = searchParams.get('token_hash')
  const type       = searchParams.get('type')          // 'recovery' | 'signup' | 'email' | etc.
  const next       = searchParams.get('next') || '/'

  // Supabase appends ?error=...&error_description=... when a link is expired or
  // already used. Surface that on the right screen instead of a blank failure.
  const errParam   = searchParams.get('error_description') || searchParams.get('error')

  const isRecovery = type === 'recovery'
  // Recovery email always lands on /reset-password regardless of `next`.
  const successDest = isRecovery ? '/reset-password' : next

  if (errParam) {
    const dest = isRecovery ? '/reset-password' : '/'
    const url  = new URL(dest, origin)
    url.searchParams.set('error', errParam)
    return NextResponse.redirect(url)
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )

  // PKCE flow — code exchanged for session
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(successDest, origin))
  }

  // Email OTP / token_hash flow (Supabase recovery & confirmation emails use this)
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any })
    if (!error) return NextResponse.redirect(new URL(successDest, origin))
  }

  // Fragment-based tokens (#access_token=...) can't be read server-side.
  // For recovery links, send the user to reset-password and let the client
  // handle the fragment via supabase.auth.onAuthStateChange('PASSWORD_RECOVERY').
  if (isRecovery) {
    return NextResponse.redirect(new URL('/reset-password', origin))
  }

  return NextResponse.redirect(new URL('/?error=auth_callback_failed', origin))
}
