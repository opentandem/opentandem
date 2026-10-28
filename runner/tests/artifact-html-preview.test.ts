import { describe, it, expect } from 'vitest'
import { prepareArtifactHtml, artifactLocalReference, rewriteArtifactReferences } from '../core/artifact-html-preview.mjs'

const file = '/Users/person/output/book.html'
const image = Buffer.alloc(70 * 1024, 7)
const data = 'data:image/png;base64,' + image.toString('base64')
const url = (id: string) => `book.html?ot-inline=${id}`

describe('HTML preview representations', () => {
  it('sends a small document before embedded images and deduplicates identical bytes', () => {
    const input = `<!doctype html><html><head><title>Book</title></head><body><h1>Book</h1><img src="${data}"><img srcset="${data} 2x"><div style="background:url('${data}')"></div><p>End</p></body></html>`
    const result = prepareArtifactHtml(input, file, url)
    expect(result.html.startsWith('<!doctype html>')).toBe(true)
    expect(result.html.length).toBeLessThan(2000)
    expect(result.html).toContain('<p>End</p>')
    expect(result.html).toContain('decoding="async"')
    expect(result.html).not.toContain('data:image')
    expect(result.images.size).toBe(1)
    expect([...result.images.values()][0].bytes).toEqual(image)
    expect(result.html).not.toContain('<script')
  })
  it('handles a 61.7 MB document in memory without sending inline image bytes in the HTML', () => {
    const large = Buffer.alloc(Math.floor(61.7 * 1024 * 1024 * 3 / 4), 2)
    const result = prepareArtifactHtml(`<h1>Book</h1><img src="data:image/png;base64,${large.toString('base64')}"><p>End</p>`, file, url)
    expect(Buffer.byteLength(result.html)).toBeLessThan(1024)
    expect([...result.images.values()][0].bytes.equals(large)).toBe(true)
  })
  it('converts local file URLs, absolute paths and srcset while preserving remote/data URLs and suffixes', () => {
    const html = '<img src="file:///Users/person/output/image%201.png"><img src=/Users/person/output/next.png><img srcset="a.png 1x, b.png 2x"><img src="https://cdn.example/a.png"><img src="data:image/png;base64,AAAA"><img src="book.html?ot-inline=abc&amp;x=1#image">'
    const result = rewriteArtifactReferences(html, file, (p: string) => p.split('/').pop()!)
    expect(result).toContain('src="image 1.png"')
    expect(result).toContain('src="next.png"')
    expect(result).toContain('srcset="a.png 1x, b.png 2x"')
    expect(result).toContain('https://cdn.example/a.png')
    expect(result).toContain('data:image/png;base64,AAAA')
    expect(result).toContain('book.html?ot-inline=abc&amp;x=1#image')
  })
  it('rewrites Windows file URLs and CSS imports without introducing HTML into CSS', () => {
    expect(artifactLocalReference('file:///C:/work/image%201.png', 'C:\\work\\book.html')).toBe('C:\\work\\image 1.png')
    expect(artifactLocalReference('file://other-host/shared/image.png', file)).toBeNull()
    const css = prepareArtifactHtml(`@import "file:///Users/person/output/theme.css";main{background:url('${data}')}`, '/Users/person/output/style.css', (id: string) => `style.css?ot-inline=${id}`, (p: string) => p.split('/').pop()!)
    expect(css.html).toContain('@import "theme.css"')
    expect(css.html).toContain('style.css?ot-inline=')
    expect(css.html).not.toContain('<style>')
  })
})
