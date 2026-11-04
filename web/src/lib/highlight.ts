import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import python from 'shiki/langs/python.mjs'

// Fine-grained imports, loaded on demand, because the full Shiki bundle would dwarf the rest of the app.

const THEME: ThemeRegistration = {
  name: 'observatory',
  type: 'dark',
  colors: { 'editor.background': '#00000000', 'editor.foreground': '#e6e8eb' },
  settings: [
    { settings: { foreground: '#e6e8eb' } },
    { scope: ['comment', 'string.quoted.docstring'], settings: { foreground: '#7d8590', fontStyle: 'italic' } },
    { scope: ['string'], settings: { foreground: '#a5d6ff' } },
    { scope: ['keyword', 'storage'], settings: { foreground: '#ff7b72' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#d2a8ff' } },
    { scope: ['entity.name.class', 'entity.name.type', 'support.type'], settings: { foreground: '#ffa657' } },
    { scope: ['constant', 'support.constant', 'variable.language'], settings: { foreground: '#79c0ff' } },
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
