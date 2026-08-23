'use client'

/**
 * PawaSave TalkBack — Nigerian-flavoured voice feedback using the Web Speech API.
 * All calls are best-effort; any error is silently swallowed.
 *
 * Robustness notes (why the earlier version was silent on desktop):
 *  • It hard-set lang='en-NG'. Most desktop/Windows browsers ship NO Nigerian-English
 *    voice, so the utterance matched nothing and never spoke. We now PICK an actual
 *    available voice (en-NG → en-GB → any en → default) and set lang from it.
 *  • getVoices() is often empty on first call until 'voiceschanged' fires — we cache
 *    voices and refresh on that event.
 *  • Chrome can leave the queue paused; we resume() before speaking.
 *  • Some browsers need a prior user gesture — we prime on the first pointer/keydown.
 */

let cachedVoices: SpeechSynthesisVoice[] = []
let primed = false

function loadVoices(): SpeechSynthesisVoice[] {
  try {
    const v = window.speechSynthesis?.getVoices() || []
    if (v.length) cachedVoices = v
  } catch { /* ignore */ }
  return cachedVoices
}

function pickVoice(): SpeechSynthesisVoice | null {
  const v = loadVoices()
  if (!v.length) return null
  return (
    v.find((x) => /en[-_]?NG/i.test(x.lang)) ||
    v.find((x) => /en[-_]?GB/i.test(x.lang)) ||
    v.find((x) => /^en/i.test(x.lang)) ||
    v[0]
  )
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  loadVoices()
  try { window.speechSynthesis.onvoiceschanged = () => loadVoices() } catch { /* ignore */ }
  // Prime speech on the first user interaction (unlocks it where a gesture is required).
  const prime = () => {
    if (primed) return
    primed = true
    try { window.speechSynthesis.resume(); loadVoices() } catch { /* ignore */ }
    window.removeEventListener('pointerdown', prime)
    window.removeEventListener('keydown', prime)
  }
  window.addEventListener('pointerdown', prime, { once: true })
  window.addEventListener('keydown', prime, { once: true })
}

export function speak(message: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const utt = new SpeechSynthesisUtterance(message)
    const voice = pickVoice()
    if (voice) {
      utt.voice = voice
      utt.lang = voice.lang
    } else {
      utt.lang = 'en-US' // safe default that virtually every engine can speak
    }
    utt.rate = 0.98
    utt.pitch = 1.05
    utt.volume = 1
    // Chrome sometimes parks the queue in a paused state; nudge it before speaking.
    try { synth.resume() } catch { /* ignore */ }
    synth.speak(utt)
  } catch {
    // voice is optional — never crash the app
  }
}

function firstName(name: string): string {
  return name?.split(' ')[0]?.trim() || 'Chief'
}

export function talkback(
  type:
    | 'deposit_init'
    | 'withdrawal_done'
    | 'save_to_vault'
    | 'vault_withdraw'
    | 'esusu_contribute'
    | 'esusu_payout'
    | 'welcome'
    | 'kyc_done'
    | 'error',
  displayName: string,
  amount?: string,
): void {
  const name = firstName(displayName)
  let msg = ''

  switch (type) {
    case 'deposit_init':
      msg = `Oga ${name}! Your deposit of ${amount} don dey process. E go enter your wallet soon. E dey!`
      break
    case 'withdrawal_done':
      msg = `${name}! We don submit your withdrawal of ${amount}. Your bank go receive am shortly. Thank you for using Pawa Save!`
      break
    case 'save_to_vault':
      msg = `Correct, ${name}! You don save ${amount} inside your vault. Your money dey work for you!`
      break
    case 'vault_withdraw':
      msg = `${name}, your ${amount} don comot from vault to your wallet. Spend am well well!`
      break
    case 'esusu_contribute':
      msg = `${name}! Your esusu contribution of ${amount} don land. The circle dey move!`
      break
    case 'esusu_payout':
      msg = `${name}! E don reach your turn! Your esusu payout of ${amount} don enter your wallet. Enjoy am!`
      break
    case 'welcome':
      msg = `Welcome back ${name}! Your money dey safe with Pawa Save. Make we go!`
      break
    case 'kyc_done':
      msg = `${name}, your verification don complete! You fit now do everything on Pawa Save. Well done!`
      break
    case 'error':
      msg = `Omo ${name}, something go wrong o. Make you try again abeg.`
      break
  }

  if (msg) speak(msg)
}