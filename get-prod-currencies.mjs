import crypto from 'crypto';
import fs from 'fs';

const merchantId = '7e353cdfab93ec17978f87de6d938cc5';
const apiKey = 'parole';
const privateKey = fs.readFileSync('private_key.pem', 'utf8');
const baseUrl = 'https://api-solid.xend.africa';

const nonce = crypto.randomBytes(16).toString('hex');
const timestamp = Date.now().toString();
const toSign = `${nonce}${timestamp}${merchantId}`;
const sig = crypto.createSign('SHA256').update(toSign).sign(privateKey, 'base64');

const res = await fetch(`${baseUrl}/api/Public/currencies`, {
  headers: {
    'Authorization': `Bearer ${merchantId}`,
    'x-api-key': apiKey,
    'x-rsa-signature': sig,
    'x-request-timestamp': timestamp,
    'x-nonce-string': nonce,
    'x-country-code': 'NG',
  }
});

const d = await res.json();
const list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : []);

if (list.length === 0) {
  console.log('Full response:', JSON.stringify(d).slice(0, 800));
} else {
  list.forEach(c => {
    const sym = c.symbol || c.currency || c.code || c.name || '';
    const id = c._id || c.id || c.currencyId || '';
    console.log(`${sym}: ${id}`);
  });
}
