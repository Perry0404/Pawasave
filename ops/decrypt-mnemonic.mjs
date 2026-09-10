#!/usr/bin/env node
// Decrypt the blob from /api/admin/export-mnemonic LOCALLY. No dependencies.
//
//   node ops/decrypt-mnemonic.mjs blob.json
//   (or)  cat blob.json | node ops/decrypt-mnemonic.mjs
//
// It asks for the same passphrase you used when calling the endpoint, then prints
// the mnemonic to YOUR terminal only. Nothing leaves your machine.
import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'

function readInput() {
  const arg = process.argv[2]
  if (arg) return fs.readFileSync(arg, 'utf8')
  return fs.readFileSync(0, 'utf8') // stdin
}

function askPassphrase() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question('Passphrase: ', (a) => { rl.close(); resolve(a) })
  })
}

const blob = JSON.parse(readInput())
const passphrase = await askPassphrase()

const salt = Buffer.from(blob.salt, 'base64')
const iv = Buffer.from(blob.iv, 'base64')
const tag = Buffer.from(blob.tag, 'base64')
const ct = Buffer.from(blob.ct, 'base64')

const key = crypto.scryptSync(passphrase, salt, 32)
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
decipher.setAuthTag(tag)

try {
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  process.stderr.write('\n----- DEPOSIT_MNEMONIC_KEY (copy to your password manager) -----\n')
  process.stdout.write(pt + '\n')
  process.stderr.write('----------------------------------------------------------------\n')
} catch {
  process.stderr.write('\nDecryption failed — wrong passphrase or corrupted blob.\n')
  process.exit(1)
}
