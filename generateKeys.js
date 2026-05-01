const { generateKeyPair } = require('crypto')
const fs = require('fs')

generateKeyPair(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  },
  (err, publicKey, privateKey) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }

    fs.writeFileSync('public_key.pem', publicKey)
    fs.writeFileSync('private_key.pem', privateKey)
    console.log('Public and private key files generated!')
  },
)