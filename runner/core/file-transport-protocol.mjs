// Data channel protocol for peer-to-peer file transfer: shared by the browser and the Runner, so neither side keeps its own copy of the constants.
// This file is bundled into the single-file Runner (runner/build/bundle.mjs): imports go at the top of the file only, and only relative-path modules or node: built-ins may be imported; exports use only export function / export const. Each module has its own scope, so top-level names no longer collide with machine-daemon.
// The browser imports this file directly as well, so it imports nothing.
//
// One reliable, ordered data channel `ot-file`. Control frames are JSON text; file bytes are binary frames:
//   [4-byte big-endian request id][up to P2P_CHUNK_SIZE bytes of content]
// The frame order of one request is fixed:
//   C→R hello{ticket}                       R→C hello_ok{...} | err{code:'auth'} then close
//   C→R stat{id,path}                       R→C stat_ok{id,size,mtime_ms,mime} | err{id,code}
//   C→R get{id,path,offset,length}          R→C meta{id,size,mime,offset,length} + binary frames… + end{id} | err{id,code}
//   C→R put{id,name,size,mime,sha256}       C→R binary frames… + put_end{id}
//                                           R→C put_ok{id,path,size} | err{id,code}
//   C→R cancel{id}                          cancel one request
//   C→R ping{n}                             R→C pong{n}
// Request ids are assigned by the browser; a single connection carries at most P2P_MAX_INFLIGHT requests at a time.

export const P2P_PROTOCOL_VERSION = 1
export const P2P_CHANNEL_LABEL = 'ot-file'
/** 16 KB: a message size that is safe across browsers and libdatachannel. */
export const P2P_CHUNK_SIZE = 16 * 1024
export const P2P_MAX_INFLIGHT = 4
/** How many reads one session may have in flight on the Runner side; announced in hello_ok so the relay's HTTP entry can
 *  run that many at once (browser channels keep P2P_MAX_INFLIGHT). All bytes still share one connection with backpressure. */
export const P2P_RUNNER_MAX_INFLIGHT = 16
/** Stop and wait for bufferedamountlow (backpressure) once the send buffer exceeds this value. */
export const P2P_HIGH_WATER = 1024 * 1024
export const P2P_LOW_WATER = 256 * 1024
/** Per-file limit for uploads from the browser to the machine over the channel; follows the existing MAX_FORCE_UPLOAD_BYTES limit. */
export const P2P_MAX_FILE_BYTES = 200 * 1024 * 1024
/**
 * Per-file limit for the browser reading a file from the machine over the WSS relay or peer-to-peer (set by the maintainer on 2026-10-25).
 *  The cloud fallback (OSS) still only accepts files up to MAX_FORCE_UPLOAD_BYTES (200MB); above this limit a file can only be opened on the machine itself.
 */
export const P2P_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024

export const P2P_ERR = {
  AUTH: 'auth',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  TOO_LARGE: 'too_large',
  BAD_REQUEST: 'bad_request',
  BUSY: 'busy',
  HASH_MISMATCH: 'hash_mismatch',
  IO: 'io',
  DISABLED: 'disabled',
}

/** Join a request id and content into one binary frame. */
export function p2pPackChunk(id, bytes) {
  const out = new Uint8Array(4 + bytes.byteLength)
  new DataView(out.buffer).setUint32(0, id >>> 0, false)
  out.set(bytes, 4)
  return out
}

/** Split a binary frame; returns null if the frame is too short. */
export function p2pUnpackChunk(frame) {
  const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (u8.byteLength < 4) return null
  const id = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, false)
  return { id, bytes: u8.subarray(4) }
}

/** The connection counts as relayed if either end of the selected candidate pair is a relay. Candidate types come from getStats / getSelectedCandidatePair. */
export function p2pTransportOf(localType, remoteType) {
  return localType === 'relay' || remoteType === 'relay' ? 'p2p_relay' : 'p2p_direct'
}

/** A 32 MiB HTTP body encoded as base64, plus the JSON overhead of the headers and so on. */
export const P2P_PREVIEW_MAX_BYTES = 44 * 1024 * 1024
export const P2P_PREVIEW_OPS = ['http', 'http_poll', 'http_close', 'ws_open', 'ws_send', 'ws_poll', 'ws_close']

export function p2pPreviewEncode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (bytes.byteLength > P2P_PREVIEW_MAX_BYTES) throw Object.assign(new Error('too_large'), { code: 'too_large' })
  return bytes
}

/** Parse JSON bytes into a preview response object; gzip-decompressed data also comes through here. */
export function p2pPreviewParse(bytes) {
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw Object.assign(new Error('bad_request'), { code: 'bad_request' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('bad_request'), { code: 'bad_request' })
  return value
}

/** Thresholds for compressing preview requests and for the display version of images: anything smaller is not worth processing. */
export const P2P_PREVIEW_GZIP_MIN = 2048
export const P2P_DISPLAY_IMAGE_MIN = 1024 * 1024
export const P2P_DISPLAY_VIEW = 'display'

/** The length must be declared first; each chunk, the total length and the final JSON are each validated independently. */
export function p2pPreviewCollector(length) {
  const invalid = (code) => { throw Object.assign(new Error(code), { code }) }
  if (!Number.isSafeInteger(length) || length < 2) invalid('bad_request')
  if (length > P2P_PREVIEW_MAX_BYTES) invalid('too_large')
  let parts = [], got = 0
  return {
    push(bytes) {
      if (bytes.byteLength > P2P_CHUNK_SIZE || got + bytes.byteLength > length) invalid('too_large')
      got += bytes.byteLength
      parts.push(bytes.slice())
    },
    /** Only concatenates bytes without parsing them: gzip frames must be decompressed first. */
    finishBytes() {
      if (got !== length) invalid('short_read')
      const bytes = new Uint8Array(length)
      let at = 0
      for (const part of parts) { bytes.set(part, at); at += part.byteLength }
      parts = []
      return bytes
    },
    finish() { return p2pPreviewParse(this.finishBytes()) },
    clear() { parts = []; got = 0 },
  }
}
