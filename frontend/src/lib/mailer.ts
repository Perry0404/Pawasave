/**
 * mailer.ts — transactional email via SMTP (Zoho, or any SMTP provider).
 *
 * Reuses the same mailbox you configure for Supabase auth emails. Configure:
 *   SMTP_HOST (e.g. smtp.zoho.com), SMTP_PORT (465), SMTP_USER, SMTP_PASS
 *   SMTP_FROM (e.g. "PawaSave <support@pawasave.xyz>")
 * No-ops safely when SMTP isn't configured (dev / not yet set up). Server only.
 */
import nodemailer from 'nodemailer'

let cached: nodemailer.Transporter | null = null

function transport(): nodemailer.Transporter | null {
  if (cached) return cached
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!host || !user || !pass) return null
  const port = Number(process.env.SMTP_PORT || 465)
  cached = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })
  return cached
}

export function mailerConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

export async function sendMail(opts: { to: string; subject: string; html: string; text?: string }): Promise<boolean> {
  const t = transport()
  if (!t) return false
  const from = process.env.SMTP_FROM || `PawaSave <${process.env.SMTP_USER}>`
  try {
    await t.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text })
    return true
  } catch {
    return false
  }
}