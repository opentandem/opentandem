/** Shared locale selection for the app and the standalone Runner. */
export function isAppLocale(value) { return value === 'en' || value === 'zh' }
export function browserLocale(header) {
  const languages = (header || '').split(',').map((part, index) => {
    const [tag, ...params] = part.trim().toLowerCase().split(';')
    const quality = params.find(p => p.trim().startsWith('q='))
    const q = quality ? Number(quality.trim().slice(2)) : 1
    return { tag, q: Number.isFinite(q) && q > 0 && q <= 1 ? q : 0, index }
  }).sort((a, b) => b.q - a.q || a.index - b.index)
  for (const { tag, q } of languages) {
    if (!q) continue
    if (/^zh(?:-|$)/.test(tag)) return 'zh'
    if (/^en(?:-|$)/.test(tag)) return 'en'
  }
  return 'en'
}
export function resolveLocale(input) {
  if (isAppLocale(input.explicit)) return input.explicit
  if (isAppLocale(input.account)) return input.account
  if (isAppLocale(input.cookie)) return input.cookie
  return browserLocale(input.acceptLanguage)
}
