// Aliases avoid colliding with preview-ticket verification when both
// dependency-free modules are inlined into the standalone daemon bundle.
import { createPublicKey as controlCreatePublicKey, verify as controlVerify } from 'node:crypto'

function controlBytes(payload) {
  return Buffer.from(JSON.stringify({
    v: payload.v,
    action: payload.action,
    server: payload.server,
    machine_id: payload.machine_id,
    install_id: payload.install_id,
    nonce: payload.nonce,
    exp: payload.exp,
    jti: payload.jti,
  }), 'utf8')
}

function controlPublicKeyFromBase64(value) {
  return controlCreatePublicKey({ key: Buffer.from(String(value), 'base64'), format: 'der', type: 'spki' })
}

/** Verification has no network fallback and never accepts a response-supplied key. */
export function verifyUninstallDirective(directive, pinnedPublicKeyBase64, expected) {
  if (!directive || typeof directive !== 'object' || !pinnedPublicKeyBase64 || !expected) return null
  const payload = {
    v: directive.v,
    action: directive.action,
    server: directive.server,
    machine_id: directive.machine_id,
    install_id: directive.install_id,
    nonce: directive.nonce,
    exp: directive.exp,
    jti: directive.jti,
  }
  if (payload.v !== 1 || payload.action !== 'uninstall') return null
  if (typeof payload.server !== 'string' || payload.server !== expected.server) return null
  if (typeof payload.machine_id !== 'string' || payload.machine_id !== expected.machine_id) return null
  if (typeof payload.install_id !== 'string' || payload.install_id !== expected.install_id) return null
  if (typeof payload.nonce !== 'string' || payload.nonce !== expected.nonce) return null
  if (!Number.isFinite(payload.exp) || payload.exp <= expected.now) return null
  if (typeof payload.jti !== 'string' || !/^[a-f0-9]{32}$/i.test(payload.jti)) return null
  if (typeof directive.signature !== 'string') return null
  try {
    const signature = Buffer.from(directive.signature, 'base64url')
    return controlVerify(null, controlBytes(payload), controlPublicKeyFromBase64(pinnedPublicKeyBase64), signature) ? payload : null
  } catch {
    return null
  }
}
