'use client'

import { useState } from 'react'
import { notFound } from 'next/navigation'
import { House, Vault, UsersThree, TrendUp, HandCoins, User, PiggyBank } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import Logo from '@/components/logo'

/**
 * Dev-only review harness for the `.ps` design system.
 *
 * The app needs a real login to reach `.ps`, so without this there's no way to
 * eyeball tokens locally. Flip the theme here rather than in OS settings.
 * Blocked in production — see the notFound() below.
 */

const TYPE = [
  ['--t-3xl', '36px', 'Hero balance'],
  ['--t-2xl', '28px', 'Section figure'],
  ['--t-xl', '20px', 'Screen heading'],
  ['--t-lg', '16px', 'Emphasis / list title'],
  ['--t-md', '14px', 'Primary body'],
  ['--t-sm', '13px', 'Secondary body'],
  ['--t-xs', '12px', 'Caption / helper'],
  ['--t-2xs', '11px', 'Nav label / metadata'],
] as const

const WEIGHT = [
  ['--w-normal', 400, 'Body. New default'],
  ['--w-medium', 500, 'UNUSED — the open question'],
  ['--w-semi', 600, 'List names, buttons (30 uses)'],
  ['--w-bold', 700, 'Headings, display (12 uses)'],
] as const

const COLOUR = [
  '--bg', '--surface', '--surface-2',
  '--ink', '--muted', '--faint',
  '--line', '--line-2',
  '--green', '--green-soft', '--pos', '--neg', '--amber',
  '--card-a', '--card-b',
] as const

const RADIUS = [['--r-sm', 8], ['--r-md', 12], ['--r-lg', 16], ['--r-xl', 22]] as const
const ELEVATION = ['--e-1', '--e-2', '--e-3'] as const
const ICON = [['--i-sm', 16], ['--i-md', 20], ['--i-lg', 24], ['--i-xl', 32], ['--i-hero', 56]] as const

const NAV: [string, Icon][] = [
  ['Home', House], ['Save', Vault], ['Ajo', UsersThree],
  ['Invest', TrendUp], ['Borrow', HandCoins], ['You', User],
]

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: 'var(--t-xl)', fontWeight: 'var(--w-bold)', color: 'var(--ink)' }}>{title}</h2>
      {note && <p style={{ fontSize: 'var(--t-sm)', color: 'var(--muted)', margin: '4px 0 16px', maxWidth: 620 }}>{note}</p>}
      {children}
    </section>
  )
}

export default function DesignSystemPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  return (
    <div className="ps" data-theme={theme} style={{ minHeight: '100dvh', padding: '24px 20px 80px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>

        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 'var(--t-2xl)', fontWeight: 'var(--w-bold)', color: 'var(--ink)', letterSpacing: '-.02em' }}>
              Design system
            </h1>
            <p style={{ fontSize: 'var(--t-sm)', color: 'var(--muted)', marginTop: 2 }}>
              Phase 1 review · tasks 1–4 + logo
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['light', 'dark'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                style={{
                  padding: '9px 16px', borderRadius: 'var(--r-md)', fontSize: 'var(--t-sm)',
                  fontWeight: 'var(--w-semi)', cursor: 'pointer', fontFamily: 'inherit',
                  textTransform: 'capitalize',
                  border: theme === t ? '1.5px solid var(--green)' : '1px solid var(--line)',
                  background: theme === t ? 'var(--green-soft)' : 'var(--surface)',
                  color: theme === t ? 'var(--green)' : 'var(--ink)',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </header>

        <Section
          title="Font"
          note="Should read __Inter_xxxxxx. If it says Roboto, SF, or ui-sans-serif, task 1 has regressed. Inspect this line in devtools."
        >
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: 16 }}>
            <p id="font-probe" style={{ fontSize: 'var(--t-lg)', color: 'var(--ink)' }}>
              The quick brown fox jumps over the lazy dog — ₦1,234,567.89
            </p>
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--faint)', marginTop: 8 }}>
              Inspect <code>#font-probe</code> → Computed → font-family
            </p>
          </div>
        </Section>

        <Section title="Logo" note="Gradient sits on the tile, not the letterform. Check the sheen still reads at 24px and that the counters show the gradient through.">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
            {[24, 32, 48, 64, 112].map((s) => (
              <div key={s} style={{ textAlign: 'center' }}>
                <Logo size={s} />
                <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', marginTop: 6 }}>{s}px</div>
              </div>
            ))}
            <div style={{ textAlign: 'center' }}>
              <Logo size={64} rounded={false} />
              <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', marginTop: 6 }}>square</div>
            </div>
          </div>
        </Section>

        <Section title="Type scale" note="19 sizes reduced to 8. No fractional steps, 11px floor.">
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
            {TYPE.map(([token, px, use], i) => (
              <div key={token} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '12px 16px', borderTop: i ? '1px solid var(--line-2)' : 'none' }}>
                <code style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', width: 74, flex: 'none' }}>{token}</code>
                <span style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', width: 34, flex: 'none' }}>{px}</span>
                <span style={{ fontSize: `var(${token})`, color: 'var(--ink)', flex: 1, minWidth: 0 }}>{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Weight scale"
          note="Body dropped 600 → 400 now that regular is reachable. --w-medium is defined but unused; the block below is the call to make."
        >
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
            {WEIGHT.map(([token, w, use], i) => (
              <div key={token} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '12px 16px', borderTop: i ? '1px solid var(--line-2)' : 'none' }}>
                <code style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', width: 86, flex: 'none' }}>{token}</code>
                <span style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', width: 26, flex: 'none' }}>{w}</span>
                <span style={{ fontSize: 'var(--t-md)', fontWeight: w, color: 'var(--ink)', flex: 1 }}>
                  Send ₦5,000 to Kemi Adeyemi
                </span>
                <span style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', flex: 'none' }}>{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="The --w-medium question"
          note="These labels used to inherit the global 600 and are now 400. Left column is what shipped; right column is 500. Which reads better?"
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {([400, 500] as const).map((w) => (
              <div key={w} style={{ background: 'var(--surface)', border: w === 500 ? '1.5px solid var(--green)' : '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: 16 }}>
                <div style={{ fontSize: 'var(--t-2xs)', color: w === 500 ? 'var(--green)' : 'var(--faint)', fontWeight: 'var(--w-semi)', marginBottom: 12 }}>
                  {w === 400 ? 'AS SHIPPED · 400' : 'ALTERNATIVE · 500'}
                </div>
                <div style={{ fontWeight: w }}>
                  <div style={{ fontSize: 'var(--t-xs)', color: 'var(--muted)' }}>Available balance</div>
                  <div className="num" style={{ fontSize: 'var(--t-2xl)', fontWeight: 'var(--w-bold)', color: 'var(--ink)', margin: '2px 0 10px' }}>₦128,400</div>
                  <div style={{ fontSize: 'var(--t-xs)', color: 'var(--muted)' }}>Account number</div>
                  <div style={{ fontSize: 'var(--t-sm)', color: 'var(--ink)', fontWeight: 'var(--w-semi)' }}>8102554417</div>
                  <div style={{ fontSize: 'var(--t-xs)', color: 'var(--muted)', marginTop: 10 }}>
                    Transfer only from an account in your own name.
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Focus ring" note="Tab through these. Before task 4 there was no focus indicator anywhere in the app. Click should NOT show a ring; keyboard should.">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="cta" style={{ width: 'auto', padding: '13px 22px', marginTop: 0 }}>Primary</button>
            <input className="field" style={{ width: 220 }} placeholder="Focus me" aria-label="Focus ring demo input" />
            <a href="#top" style={{ fontSize: 'var(--t-sm)', color: 'var(--green)', fontWeight: 'var(--w-semi)' }}>A link</a>
          </div>
        </Section>

        <Section title="Colour tokens">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(132px,1fr))', gap: 10 }}>
            {COLOUR.map((token) => (
              <div key={token} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface)' }}>
                <div style={{ height: 46, background: `var(${token})`, borderBottom: '1px solid var(--line)' }} />
                <code style={{ display: 'block', fontSize: 'var(--t-2xs)', color: 'var(--muted)', padding: '7px 9px' }}>{token}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radius, elevation, icon sizes">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
            {RADIUS.map(([token, px]) => (
              <div key={token} style={{ textAlign: 'center' }}>
                <div style={{ width: 72, height: 72, background: 'var(--green-soft)', border: '1px solid var(--line)', borderRadius: `var(${token})` }} />
                <code style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', display: 'block', marginTop: 6 }}>{token} · {px}</code>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 18 }}>
            {ELEVATION.map((token) => (
              <div key={token} style={{ textAlign: 'center' }}>
                <div style={{ width: 100, height: 62, background: 'var(--surface)', borderRadius: 'var(--r-lg)', boxShadow: `var(${token})` }} />
                <code style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', display: 'block', marginTop: 10 }}>{token}</code>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {ICON.map(([token, px]) => (
              <div key={token} style={{ textAlign: 'center' }}>
                <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18" />
                </svg>
                <code style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', display: 'block', marginTop: 6 }}>{px}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Icons — Phosphor"
          note="THE CALL TO MAKE: is `regular` legible at 16px on your screen? If not, the fix is `bold` at small sizes, not a different library. Nav row below shows regular vs fill, which is how active state stops depending on colour."
        >
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: 16 }}>
            <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', fontWeight: 'var(--w-semi)', marginBottom: 12 }}>
              SIZE RAMP · weight regular
            </div>
            <div style={{ display: 'flex', gap: 22, alignItems: 'flex-end', flexWrap: 'wrap', color: 'var(--ink)' }}>
              {ICON.map(([token, px]) => (
                <div key={token} style={{ textAlign: 'center' }}>
                  <HandCoins size={px} />
                  <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', marginTop: 6 }}>{px}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', fontWeight: 'var(--w-semi)', margin: '22px 0 12px' }}>
              WEIGHT RAMP · 20px
            </div>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', color: 'var(--ink)' }}>
              {(['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const).map((w) => (
                <div key={w} style={{ textAlign: 'center' }}>
                  <Vault size={20} weight={w} />
                  <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', marginTop: 6 }}>{w}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', fontWeight: 'var(--w-semi)', margin: '22px 0 12px' }}>
              NAV SET · inactive vs active. Borrow was a dollar sign in a naira app
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {NAV.map(([label, Cmp]) => (
                <div key={label} style={{ display: 'flex', gap: 10, alignItems: 'center', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: '8px 12px' }}>
                  <span style={{ color: 'var(--faint)', display: 'grid', placeItems: 'center' }}><Cmp size={20} weight="regular" /></span>
                  <span style={{ color: 'var(--green)', display: 'grid', placeItems: 'center' }}><Cmp size={20} weight="fill" /></span>
                  <span style={{ fontSize: 'var(--t-2xs)', color: 'var(--muted)', fontWeight: 'var(--w-medium)' }}>{label}</span>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--faint)', fontWeight: 'var(--w-semi)', margin: '22px 0 12px' }}>
              DUOTONE AT HERO SIZE · for empty states, instead of an illustration dependency
            </div>
            <div style={{ display: 'flex', gap: 20, color: 'var(--green)' }}>
              <PiggyBank size={56} weight="duotone" />
              <UsersThree size={56} weight="duotone" />
              <TrendUp size={56} weight="duotone" />
            </div>
          </div>
        </Section>

        <Section title="Live primitives" note="Real .ps classes. The hero card below is still the OLD gradient — task 8 replaces it with a solid neutral.">
          <div className="acct">
            <div className="acct-top">
              <span className="acct-lab">Total balance</span>
              <span className="acct-chip">cNGN</span>
            </div>
            <div className="acct-bal num">₦128,400</div>
            <div className="acct-earn">↑ ₦2,140 earned in savings</div>
            <div className="acct-sub">
              <div><div className="l">Available</div><div className="v num">₦96,200</div></div>
              <div><div className="l">Savings</div><div className="v num">₦32,200</div></div>
            </div>
            <div className="acct-actions">
              <button className="ab">Send</button>
              <button className="ab solid">Receive</button>
            </div>
          </div>

          <div className="sect"><span className="h">Activity</span><button className="m">Statement</button></div>
          <div className="feedcard">
            <div className="daylab">Today</div>
            <div className="tx inn">
              <span className="ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 7l10 10M17 7v10H7" /></svg>
              </span>
              <div className="mid"><div className="nm">Received from Kemi Adeyemi</div><div className="sub">Credit</div></div>
              <div className="rt"><div className="amt num pos">+₦5,000</div><div className="st">2h ago</div></div>
            </div>
            <div className="tx">
              <span className="ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 17L7 7M7 17V7h10" /></svg>
              </span>
              <div className="mid"><div className="nm">Sent to GTBank ····4417</div><div className="sub">Debit</div></div>
              <div className="rt"><div className="amt num">−₦12,500</div><div className="st pend">Processing</div></div>
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <label className="lab">Amount (₦)</label>
            <input className="field" placeholder="e.g. 5000" aria-label="Amount" />
            <div className="flash ok">Sent. The recipient will receive NGN shortly.</div>
            <div className="flash err">Minimum deposit is ₦2,000</div>
            <div className="note">Only send cNGN on Base to this address. Any other token or network will be lost.</div>
            <div className="info" style={{ marginTop: 14 }}>
              <div className="l">Your cNGN address (Base)</div>
              <div className="code">0x7a2F91cE04bB8d3A6f01De55c9A7Bb2e4413aC80</div>
            </div>
            <button className="cta">Continue</button>
            <div className="empty" style={{ marginTop: 18 }}>
              <div className="eh">No activity yet</div>
              <div className="es">Add money with Receive to get started</div>
            </div>
          </div>
        </Section>

      </div>
    </div>
  )
}
