export class OpenTandemError extends Error {
  /** @param {string} code @param {string} [message] @param {number} [status] */
  constructor(code, message, status) {
    super(message || code)
    this.name = 'OpenTandemError'
    this.code = code
    this.status = status
  }
}
