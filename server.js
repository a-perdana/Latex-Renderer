const express = require('express')
const cors = require('cors')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_, res) => res.json({ ok: true }))

function buildDocument(code) {
  const trimmed = code.trim()
  const defaultLibs = ['calc', 'arrows.meta', 'angles', 'quotes', 'patterns', 'positioning']

  // Already a full document — but still ensure default libs are present
  if (trimmed.startsWith('\\documentclass')) {
    // Extract any existing \usetikzlibrary calls
    const libMatches = [...trimmed.matchAll(/\\usetikzlibrary\{([^}]+)\}/g)]
    const existingLibs = new Set(libMatches.flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean)))
    const missingLibs = defaultLibs.filter(l => !existingLibs.has(l))
    if (missingLibs.length === 0) return trimmed
    // Inject missing libs by merging into first \usetikzlibrary or inserting before \begin{document}
    if (libMatches.length > 0) {
      const allLibs = [...new Set([...existingLibs, ...defaultLibs])]
      // Replace all \usetikzlibrary calls with a single merged one
      const deduped = trimmed.replace(/\\usetikzlibrary\{[^}]+\}/g, '').replace(/\n{3,}/g, '\n\n')
      return deduped.replace('\\begin{document}', `\\usetikzlibrary{${allLibs.join(',')}}\n\\begin{document}`)
    }
    // No \usetikzlibrary at all — inject before \begin{document}
    return trimmed.replace('\\begin{document}', `\\usetikzlibrary{${defaultLibs.join(',')}}\n\\begin{document}`)
  }

  // Extract tikzpicture block
  const blockMatch = trimmed.match(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/)
  const tikzBlock = blockMatch ? blockMatch[0] : `\\begin{tikzpicture}\n${trimmed}\n\\end{tikzpicture}`

  // Extract \usetikzlibrary calls
  const libMatches = [...trimmed.matchAll(/\\usetikzlibrary\{([^}]+)\}/g)]
  const libs = [...new Set(libMatches.flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean)))]
  const allLibs = [...new Set([...defaultLibs, ...libs])]

  return `\\documentclass[tikz,border=6mm]{standalone}
\\usepackage{tikz}
\\usepackage{amsmath}
\\usetikzlibrary{${allLibs.join(',')}}
\\begin{document}
${tikzBlock}
\\end{document}`
}

function fixCode(code) {
  // Fix common AI mistakes: underscore instead of space in TikZ pic keys
  code = code.replace(/\bangle_radius\b/g, 'angle radius')
  code = code.replace(/\bangle_eccentricity\b/g, 'angle eccentricity')

  // Remove comment lines (% ...) — AI sometimes writes long comments that confuse pdflatex
  // Keep the tikzpicture structure intact; only strip comment-only lines
  code = code.replace(/^\s*%.*$/gm, '')

  // Fix \pic angle syntax: calc expressions like $(A)+(1,0)$ are not valid as \pic angle args.
  // Replace \pic{angle = EXPR--B--C} where EXPR contains $ with just the middle coord repeated
  // e.g. angle = $(R)+(1,0)$--R--S  →  strip the bad first arg, keep angle = A--R--S form
  code = code.replace(/\{angle\s*=\s*\$[^$]*\$\s*--\s*([A-Za-z]+)\s*--\s*([A-Za-z]+)\s*\}/g,
    (_, mid, end) => `{angle = ${mid}--${mid}--${end}}`)

  // Remove trailing empty lines left by comment removal
  code = code.replace(/\n{3,}/g, '\n\n')

  // Close unmatched { braces
  let depth = 0
  for (const ch of code) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  if (depth > 0) code = code + '}'.repeat(depth)

  // Ensure \end{tikzpicture} is present
  const hasBegin = /\\begin\{tikzpicture\}/.test(code)
  const hasEnd = /\\end\{tikzpicture\}/.test(code)
  if (hasBegin && !hasEnd) code = code.trimEnd() + '\n\\end{tikzpicture}'

  return code
}

app.post('/render', async (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'Missing code' })

  const fullDoc = buildDocument(fixCode(code))
  const id = crypto.randomBytes(8).toString('hex')
  const dir = path.join(os.tmpdir(), `latex-${id}`)
  fs.mkdirSync(dir)

  const texFile = path.join(dir, 'doc.tex')
  const pdfFile = path.join(dir, 'doc.pdf')
  const pngFile = path.join(dir, 'doc.png')

  try {
    fs.writeFileSync(texFile, fullDoc, 'utf8')

    execSync(`pdflatex -interaction=nonstopmode -output-directory="${dir}" "${texFile}"`, {
      timeout: 30000,
      stdio: 'pipe',
    })

    // PDF to PNG using pdftoppm
    execSync(`pdftoppm -r 150 -png -singlefile "${pdfFile}" "${path.join(dir, 'doc')}"`, {
      timeout: 10000,
      stdio: 'pipe',
    })

    const pngData = fs.readFileSync(pngFile)
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(pngData)
  } catch (err) {
    let log = ''
    try { log = fs.readFileSync(path.join(dir, 'doc.log'), 'utf8').slice(-2000) } catch {}
    res.status(502).json({ error: String(err), log })
  } finally {
    try { fs.rmSync(dir, { recursive: true }) } catch {}
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`LaTeX renderer on port ${PORT}`))
