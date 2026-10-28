// Dependency-free SemVer ordering shared by the server and the standalone
// Runner bundle. Returns > 0 when left is newer than right.
export function compareDaemonVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value))
    if (!match) return null
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4]?.split('.') || [],
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i++) {
    const av = a.prerelease[i]
    const bv = b.prerelease[i]
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1
    if (av === bv) continue
    const an = /^\d+$/.test(av)
    const bn = /^\d+$/.test(bv)
    if (an && bn) return Number(av) - Number(bv)
    if (an !== bn) return an ? -1 : 1
    return av < bv ? -1 : 1
  }
  return 0
}
