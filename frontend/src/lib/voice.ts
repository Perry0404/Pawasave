'use client'

/**
 * PawaSave TalkBack — Nigerian-flavoured voice feedback using Web Speech API.
 * All calls are best-effort; any error is silently swallowed.
 */

export function speak(message: string): void {
  if (typeof window === 'undefined') return
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    synth.cancel()
    const utt = new SpeechSynthesisUtterance(message)
    utt.lang = 'en-NG'
    utt.rate = 0.95
    utt.pitch = 1.05
    utt.volume = 1
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
