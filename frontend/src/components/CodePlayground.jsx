import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { checkExercise } from '../store/curriculumStore'

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

function HintBox({ hints }) {
  const [hintCount, setHintCount] = useState(0)
  if (!hints || hints.length === 0) return null
  return (
    <div className="px-3 pt-2 pb-1 space-y-2 bg-white dark:bg-gray-900">
      {hints.slice(0, hintCount).map((hint, i) => (
        <div key={i} className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
          <span className="font-semibold">Hint {i + 1}:</span> {hint}
        </div>
      ))}
      <button
        onClick={() => setHintCount(c => Math.min(c + 1, hints.length))}
        disabled={hintCount >= hints.length}
        className="text-xs text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-700 px-2.5 py-1 rounded-md hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {hintCount === 0 ? 'Hint' : hintCount >= hints.length ? 'No more hints' : 'Next hint'}
      </button>
    </div>
  )
}

export default function CodePlayground({ initialCode, initialLanguage, expectedOutput, exerciseSlug, exerciseIndex, hints }) {
  const dark = useDarkMode()
  const [language, setLanguage] = useState(initialLanguage ?? 'bash')
  const [code, setCode] = useState(initialCode ?? STARTER[initialLanguage ?? 'bash'])
  const [output, setOutput] = useState(null)
  const [running, setRunning] = useState(false)
  const [checkResult, setCheckResult] = useState(null)
  const [checking, setChecking] = useState(false)

  const switchLanguage = (lang) => {
    setLanguage(lang)
    setCode(STARTER[lang])
    setOutput(null)
    setCheckResult(null)
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

  const check = async () => {
    if (checking || !expectedOutput) return
    setChecking(true)
    setCheckResult(null)
    try {
      const result = await checkExercise(exerciseSlug, exerciseIndex, code, language, expectedOutput)
      setCheckResult(result)
    } catch (e) {
      setCheckResult({ passed: false, error: e.message })
    } finally {
      setChecking(false)
    }
  }

  const handleKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run()
  }

  const hasCheck = Boolean(expectedOutput)

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
        <div className="flex items-center gap-2">
          {hasCheck && (
            <button
              onClick={check}
              disabled={checking}
              className="text-xs px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-medium rounded-full transition-colors flex items-center gap-1.5"
            >
              <span>{checking ? '…' : '✓'}</span>
              <span>{checking ? 'Checking' : 'Check'}</span>
            </button>
          )}
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
      </div>

      {/* Hints */}
      {hints && hints.length > 0 && <HintBox hints={hints} />}

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

      {/* Run output */}
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

      {/* Check result */}
      {checkResult !== null && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          {checkResult.error ? (
            <div className="px-4 py-3 bg-red-950 text-red-300 text-sm">
              Check failed: {checkResult.error}
            </div>
          ) : checkResult.passed ? (
            <div className="px-4 py-3 bg-emerald-950 border-b border-emerald-800 flex items-center gap-3">
              <span className="text-emerald-400 font-medium text-sm">✅ Correct!</span>
              {checkResult.xp_earned > 0 && (
                <span className="text-xs text-emerald-300 bg-emerald-900 px-2 py-0.5 rounded-full">
                  +{checkResult.xp_earned} XP
                </span>
              )}
            </div>
          ) : (
            <div>
              <div className="px-4 py-3 bg-red-950 border-b border-red-800">
                <span className="text-red-400 font-medium text-sm">❌ Not quite — here's the diff:</span>
                {checkResult.stderr && (
                  <pre className="mt-2 text-xs text-red-300 font-mono whitespace-pre-wrap">{checkResult.stderr}</pre>
                )}
              </div>
              <div className="grid grid-cols-2 divide-x divide-gray-700 bg-gray-900">
                <div className="px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Expected</div>
                  <pre className="text-sm font-mono text-emerald-300 whitespace-pre-wrap">{checkResult.expected}</pre>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Got</div>
                  <pre className="text-sm font-mono text-red-300 whitespace-pre-wrap">{checkResult.actual !== '' ? checkResult.actual : <span className="text-gray-500">(no output)</span>}</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
