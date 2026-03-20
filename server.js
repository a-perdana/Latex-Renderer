const express = require('express')
const cors = require('cors')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_, res) => res.json({ ok: true }))

app.post('/render', async (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'Missing code' })

  // Build full standalone document if not already
  const fullDoc = code.trim().startsWith('\\documentclass')
    ? code
    : `\\documentclass[tikz,border=6mm]{standalone}
\\usepackage{tikz}
\\usetikzlibrary{calc,arrows.meta,angles,quotes,patterns,positioning}
\\begin{document}
${code.trim().startsWith('\\begin{tikzpicture}') ? code.trim() : `\\begin{tikzpicture}\n${code.trim()}\n\\end{tikzpicture}`}
\\end{document}`

  const id = crypto.randomBytes(8).toString('hex')
  const dir = path.join(os.tmpdir(), `latex-${id}`)
  fs.mkdirSync(dir)

  const texFile = path.join(dir, 'doc.tex')
  const pdfFile = path.join(dir, 'doc.pdf')
  const pngFile = path.join(dir, 'doc.png')

  try {
    fs.writeFileSync(texFile, fullDoc)

    execSync(`pdflatex -interaction=nonstopmode -output-directory="${dir}" "${texFile}"`, {
      timeout: 30000,
      stdio: 'pipe',
    })

    // PDF to PNG using pdftoppm (from poppler-utils)
    execSync(`pdftoppm -r 150 -png -singlefile "${pdfFile}" "${path.join(dir, 'doc')}"`, {
      timeout: 10000,
      stdio: 'pipe',
    })

    const pngData = fs.readFileSync(pngFile)
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(pngData)
  } catch (err) {
    // Try to return LaTeX log for debugging
    let log = ''
    try { log = fs.readFileSync(path.join(dir, 'doc.log'), 'utf8').slice(-1000) } catch {}
    res.status(502).json({ error: String(err), log })
  } finally {
    try { fs.rmSync(dir, { recursive: true }) } catch {}
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`LaTeX renderer running on port ${PORT}`))
