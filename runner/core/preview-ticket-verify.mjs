import { createPublicKey, verify } from 'node:crypto'

// Runner half of src/lib/preview-ticket.ts. Verification only — the Runner
// never holds the private key, so it can read tickets but not mint them.
// Kept as .mjs because runner/core/machine-daemon.mjs runs outside the Next build.

function fromB64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64')
}

export function publicKeyFromBase64(spkiBase64) {
  return createPublicKey({ key: Buffer.from(String(spkiBase64), 'base64'), format: 'der', type: 'spki' })
}

/**
 * @param {string} token
 * @param {import('node:crypto').KeyObject} publicKey
 * @param {{ use?: 'enter'|'session', host?: string, now?: number }} [options]
 * @returns {Record<string, unknown> | null} the payload when every check
 * passes, otherwise null. Callers must treat null as 401 without telling the
 * client which check failed — an attacker learning "signature fine but
 * expired" learns the key is right.
 */
export function verifyPreviewTicket(token, publicKey, { use, host, now = Date.now() } = {}) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  let body
  let signature
  try {
    body = fromB64Url(parts[0])
    signature = fromB64Url(parts[1])
  } catch {
    return null
  }
  let ok = false
  try {
    ok = verify(null, body, publicKey, signature)
  } catch {
    return null
  }
  if (!ok) return null

  let payload
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  if (!payload || payload.v !== 1) return null
  if (use && payload.use !== use) return null
  if (host && payload.host !== host) return null
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null
  return payload
}
