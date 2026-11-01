import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import python from 'shiki/langs/python.mjs'

// Fine-grained imports, loaded on demand, because the full Shiki bundle would dwarf the rest of the app.

const THEME: ThemeRegistration = {
  name: 'observatory',
  type: 'dark',
  colors: { 'editor.background': '#00000000', 'editor.foreground': '#d8d5ca' },
  settings: [
    { settings: { foreground: '#d8d5ca' } },
    { scope: ['comment', 'string.quoted.docstring'], settings: { foreground: '#767c94', fontStyle: 'italic' } },
    { scope: ['string'], settings: { foreground: '#a9d5b5' } },
    { scope: ['keyword', 'storage'], settings: { foreground: '#f2c46d' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#9cc4ff' } },
    { scope: ['entity.name.class', 'entity.name.type', 'support.type'], settings: { foreground: '#f1dfae' } },
    { scope: ['constant', 'support.constant', 'variable.language'], settings: { foreground: '#f0a56c' } },
  ],
}

let highlighter: Promise<HighlighterCore> | null = null

function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [THEME],
    langs: [python],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighter
}

export interface CodeToken {
  text: string
  colour?: string
  italic: boolean
}

// One array of coloured tokens per line, so a file can be cut into blocks without losing its colouring.
export async function highlightLines(code: string): Promise<CodeToken[][]> {
  const shiki = await getHighlighter()
  const { tokens } = shiki.codeToTokens(code, { lang: 'python', theme: 'observatory' })
  return tokens.map((line) =>
    line.map((token) => ({ text: token.content, colour: token.color, italic: ((token.fontStyle ?? 0) & 1) === 1 })),
  )
}

export interface LineMarks {
  rangeStart: number
  rangeEnd: number
  quoted: Set<number>
}

export async function highlightPython(code: string, marks: LineMarks): Promise<string> {
  const shiki = await getHighlighter()
  return shiki.codeToHtml(code, {
    lang: 'python',
    theme: 'observatory',
    transformers: [
      {
        line(node, line) {
          node.properties['data-line'] = line
          if (line >= marks.rangeStart && line <= marks.rangeEnd) this.addClassToHast(node, 'in-range')
          if (marks.quoted.has(line)) this.addClassToHast(node, 'quoted')
        },
      },
    ],
  })
}
