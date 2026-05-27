import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'

const API = 'http://localhost:8000'

const STARTER = {
  bash: '#!/bin/bash\n# Try the exercises from this lesson\necho "Hello, DevOps!"\n',
  python: '# Try the exercises from this lesson\nprint("Hello, DevOps!")\n',
  yaml: '# Write your YAML here\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\ndata:\n  key: value\n',
}

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark'))
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export default function CodePlayground({ initialCode, initialLanguage }) {
  const dark = useDarkMode()
  const [language, setLanguage] = useState(initialLanguage ?? 'bash')
  const [code, setCode] = useState(initialCode ?? STARTER[initialLanguage ?? 'bash'])
  const [output, setOutput] = useState(null)
  const [running, setRunning] = useState(false)

  const switchLanguage = (lang) => {
    setLanguage(lang)
    setCode(STARTER[lang])
    setOutput(null)
  }

  const run = async () => {
    if (running) return
    setRunning(true)
    try {
      const res = await fetch(`${API}/sandbox/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language }),
      })
      setOutput(await res.json())
    } catch (e) {
      setOutput({ stdout: '', stderr: e.message, exit_code: 1 })
    } finally {
      setRunning(false)
    }
  }

  const handleKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run()
  }

  return (
    <div
      className="mt-10 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
      onKeyDown={handleKey}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-1">
          {['bash', 'python', 'yaml'].map(lang => (
            <button
              key={lang}
              onClick={() => switchLanguage(lang)}
              className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
                language === lang
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {lang === 'bash' ? 'Bash' : lang === 'python' ? 'Python' : 'YAML'}
            </button>
          ))}
        </div>
        <button
          onClick={run}
          disabled={running}
          className="text-xs px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium rounded-full transition-colors flex items-center gap-1.5"
        >
          <span>{running ? '…' : '▶'}</span>
          <span>{running ? (language === 'yaml' ? 'Validating' : 'Running') : (language === 'yaml' ? 'Validate' : 'Run')}</span>
          {!running && <span className="text-emerald-200 text-[10px]">Ctrl+Enter</span>}
        </button>
      </div>

      {/* Editor */}
      <Editor
        height="200px"
        language={language === 'bash' ? 'shell' : language === 'python' ? 'python' : 'yaml'}
        value={code}
        onChange={v => setCode(v ?? '')}
        theme={dark ? 'vs-dark' : 'vs'}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          padding: { top: 8 },
        }}
      />

      {/* Output */}
      {output !== null && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="px-3 py-1.5 bg-gray-800 flex items-center gap-2 border-b border-gray-700">
            <span className="text-xs text-gray-400">Output</span>
            {output.exit_code !== 0 && (
              <span className="text-xs text-red-400">exit {output.exit_code}</span>
            )}
            {output.exit_code === 0 && (
              <span className="text-xs text-emerald-400">✓</span>
            )}
          </div>
          <pre className="px-4 py-3 text-sm font-mono bg-gray-900 text-gray-100 overflow-x-auto whitespace-pre-wrap min-h-[56px] max-h-[240px] overflow-y-auto">
            {output.stdout && <span>{output.stdout}</span>}
            {output.stderr && <span className="text-red-400">{output.stderr}</span>}
            {!output.stdout && !output.stderr && (
              <span className="text-gray-500">(no output)</span>
            )}
          </pre>
        </div>
      )}
    </div>
  )
}
