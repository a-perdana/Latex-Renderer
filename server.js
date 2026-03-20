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

  // Already a full document
  if (trimmed.startsWith('\\documentclass')) return trimmed

  // Extract tikzpicture block
  const blockMatch = trimmed.match(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/)
  const tikzBlock = blockMatch ? blockMatch[0] : `\\begin{tikzpicture}\n${trimmed}\n\\end{tikzpicture}`

  // Extract \usetikzlibrary calls
  const libMatches = [...trimmed.matchAll(/\\usetikzlibrary\{([^}]+)\}/g)]
  const libs = [...new Set(libMatches.flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean)))]
  const defaultLibs = ['calc', 'arrows.meta', 'angles', 'quotes', 'patterns', 'positioning']
  const allLibs = [...new Set([...defaultLibs, ...libs])]

  return `\\documentclass[tikz,border=6mm]{standalone}
\\usepackage{tikz}
\\usepackage{amsmath}
\\usetikzlibrary{${allLibs.join(',')}}
\\begin{document}
${tikzBlock}
\\end{document}`
}

app.post('/render', async (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'Missing code' })

  const fullDoc = buildDocument(code)
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
