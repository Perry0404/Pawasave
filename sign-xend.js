/**
 * Xend RSA Key Verification Helper
 * 
 * Usage:
 *   node sign-xend.js "path/to/private_key.pem" "canonicalString"
 *
 * Example:
 *   node sign-xend.js "C:/keys/private_key.pem" "companyName=pawasave&nonce=af6b46f895f5b19afec1a7d136553654&timestamp=2026-05-01T01:52..."
 *
 * Then paste the printed signature into the BASE64 SIGNATURE box and click Submit.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [,, keyPath, canonicalString] = process.argv;

if (!keyPath || !canonicalString) {
  console.error('Usage: node sign-xend.js <path-to-private_key.pem> "<canonical-string>"');
  process.exit(1);
}

const absPath = path.resolve(keyPath);
if (!fs.existsSync(absPath)) {
  console.error('Private key file not found:', absPath);
  process.exit(1);
}

const privateKey = fs.readFileSync(absPath, 'utf8');

const signer = crypto.createSign('RSA-SHA256');
signer.update(canonicalString, 'utf8');
const signature = signer.sign(privateKey, 'base64');

console.log('\n=== BASE64 SIGNATURE (paste this into Xend) ===\n');
console.log(signature);
console.log('\n================================================\n');
