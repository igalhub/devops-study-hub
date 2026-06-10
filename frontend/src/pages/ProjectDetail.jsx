import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import Editor from '@monaco-editor/react'
import { useTheme } from '../store/themeStore'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

const DIFFICULTY_STYLES = {
  beginner: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  intermediate: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  advanced: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

const SCORE_STYLES = {
  Strong: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  Adequate: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  Weak: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

function HintBox({ hints }) {
  const [hintCount, setHintCount] = useState(0)
  if (!hints || hints.length === 0) return null
  return (
    <div className="space-y-2">
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

function SandboxStep({ step, projectSlug, onComplete, onXpEarned }) {
  const { dark } = useTheme()
  const [code, setCode] = useState(step.answer || '')
  const [result, setResult] = useState(null)
  const [running, setRunning] = useState(false)
  const [checking, setChecking] = useState(false)

  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      const r = await fetch(`${API}/sandbox/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: step.language }),
      })
      const data = await r.json()
      setResult({ kind: 'run', ...data })
    } finally {
      setRunning(false)
    }
  }

  const check = async () => {
    setChecking(true)
    try {
      const r = await fetch(`${API}/projects/${projectSlug}/steps/${step.id}/sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: step.language }),
      })
      const data = await r.json()
      setResult({ kind: 'check', ...data })
      if (data.passed) {
        onComplete(step.id, 'passed')
        if (data.xp_earned > 0) onXpEarned(data.xp_total)
      }
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-3">
      <HintBox hints={step.hints} />
      <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
        <Editor
          height="160px"
          language={step.language === 'bash' ? 'shell' : step.language}
          value={code}
          onChange={v => setCode(v || '')}
          theme={dark ? 'vs-dark' : 'light'}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'off',
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={run}
          disabled={running || !code.trim()}
          className="px-4 py-1.5 rounded-md text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
        >
          {running ? 'Running…' : 'Run'}
        </button>
        <button
          onClick={check}
          disabled={checking || !code.trim()}
          className="px-4 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors"
        >
          {checking ? 'Checking…' : 'Check'}
        </button>
      </div>
      {result && (
        <div className="text-sm rounded-lg p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 space-y-2 font-mono">
          {result.kind === 'check' && (
            <div className={`font-sans font-medium ${result.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {result.passed ? '✓ Passed' : '✗ Failed'}
              {result.passed && result.xp_earned > 0 && (
                <span className="ml-2 text-amber-500">+{result.xp_earned} XP</span>
              )}
            </div>
          )}
          {result.kind === 'run' && result.stdout && (
            <div>
              <div className="text-xs text-gray-400 font-sans mb-1">Output</div>
              <pre className="text-xs text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{result.stdout}</pre>
            </div>
          )}
          {result.kind === 'check' && !result.passed && (
            <div className="space-y-2">
              <div>
                <div className="text-xs text-gray-400 font-sans">Got</div>
                <pre className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">{result.actual || '(empty)'}</pre>
              </div>
              <div>
                <div className="text-xs text-gray-400 font-sans">Expected</div>
                <pre className="text-xs text-emerald-600 dark:text-emerald-400 whitespace-pre-wrap">{result.expected}</pre>
              </div>
            </div>
          )}
          {result.stderr && (
            <div>
              <div className="text-xs text-gray-400 font-sans mb-1">Stderr</div>
              <pre className="text-xs text-red-500 whitespace-pre-wrap">{result.stderr}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AiStep({ step, projectSlug, onComplete, onXpEarned }) {
  const [answer, setAnswer] = useState(step.answer || '')
  const [result, setResult] = useState(null)
  const [grading, setGrading] = useState(false)
  const [showModel, setShowModel] = useState(false)

  const grade = async () => {
    setGrading(true)
    try {
      const r = await fetch(`${API}/projects/${projectSlug}/steps/${step.id}/ai-grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      const data = await r.json()
      setResult(data)
      onComplete(step.id, 'graded', data.score)
      if (data.xp_earned > 0) onXpEarned(data.xp_total)
    } finally {
      setGrading(false)
    }
  }

  return (
    <div className="space-y-3">
      <HintBox hints={step.hints} />
      <textarea
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        placeholder="Write your answer here — YAML, HCL, config blocks, explanations…"
        rows={10}
        className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 p-3 font-mono resize-y focus:outline-none focus:border-emerald-500 dark:focus:border-emerald-500"
      />
      <button
        onClick={grade}
        disabled={grading || !answer.trim()}
        className="px-4 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors"
      >
        {grading ? 'Grading…' : 'Submit for AI Review'}
      </button>
      {result && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SCORE_STYLES[result.score]}`}>
              {result.score}
            </span>
            {result.xp_earned > 0 && (
              <span className="text-xs text-amber-500 font-medium">+{result.xp_earned} XP</span>
            )}
          </div>
          <div className="p-4 space-y-3 text-sm">
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Feedback</div>
              <p className="text-gray-700 dark:text-gray-300">{result.feedback}</p>
            </div>
            <div>
              <button
                onClick={() => setShowModel(v => !v)}
                className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                {showModel ? 'Hide model answer' : 'Show model answer'}
              </button>
              {showModel && (
                <pre className="mt-2 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  {result.model_answer}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ProjectDetail({ onXpEarned }) {
  const { projectSlug } = useParams()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [stepStatus, setStepStatus] = useState({})

  useEffect(() => {
    setLoading(true)
    fetch(`${API}/projects/${projectSlug}`)
      .then(r => r.json())
      .then(data => {
        setProject(data)
        const status = {}
        data.steps.forEach(s => { status[s.id] = { status: s.status, score: s.score } })
        setStepStatus(status)
        const first = data.steps.find(s => !['passed', 'graded'].includes(s.status))
        setExpanded((first ?? data.steps[0])?.id ?? null)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [projectSlug])

  const handleStepComplete = (stepId, status, score) => {
    setStepStatus(prev => ({ ...prev, [stepId]: { status, score } }))
  }

  if (loading) return <div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>
  if (!project) return <div className="p-6 text-red-500">Project not found.</div>

  const totalDone = Object.values(stepStatus).filter(s => ['passed', 'graded'].includes(s.status)).length
  const allDone = project.steps.length > 0 && totalDone === project.steps.length
  const pct = project.steps.length ? Math.round((totalDone / project.steps.length) * 100) : 0

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{project.title}</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${DIFFICULTY_STYLES[project.difficulty] || DIFFICULTY_STYLES.intermediate}`}>
            {project.difficulty}
          </span>
          {allDone && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 font-medium">
              Complete
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{project.description}</p>
        <div className="flex flex-wrap gap-1.5 mb-4">
          {project.modules.map(m => (
            <span key={m} className="text-xs px-2 py-0.5 rounded-full bg-stone-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {m}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{totalDone}/{project.steps.length} steps</span>
        </div>
      </div>

      <div className="space-y-3">
        {project.steps.map((step, idx) => {
          const prog = stepStatus[step.id] || { status: 'not_started' }
          const isDone = ['passed', 'graded'].includes(prog.status)
          const isOpen = expanded === step.id

          return (
            <div
              key={step.id}
              className={`rounded-xl border transition-colors ${
                isDone
                  ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
              }`}
            >
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left"
                onClick={() => setExpanded(isOpen ? null : step.id)}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  isDone
                    ? 'bg-emerald-500 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                }`}>
                  {isDone ? '✓' : idx + 1}
                </span>
                <span className={`flex-1 text-sm font-medium truncate ${
                  isDone ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-800 dark:text-gray-200'
                }`}>
                  {step.title}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    step.type === 'sandbox'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                      : 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'
                  }`}>
                    {step.type === 'sandbox' ? 'Sandbox' : 'AI Review'}
                  </span>
                  {prog.score && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SCORE_STYLES[prog.score]}`}>
                      {prog.score}
                    </span>
                  )}
                  <span className="text-gray-400 dark:text-gray-600 text-xs">{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 pt-3 border-t border-gray-200 dark:border-gray-700">
                  <div className="text-sm text-gray-700 dark:text-gray-300 mb-4 whitespace-pre-wrap leading-relaxed break-words">
                    {step.prompt}
                  </div>
                  {step.type === 'sandbox' ? (
                    <SandboxStep
                      step={step}
                      projectSlug={project.slug}
                      onComplete={handleStepComplete}
                      onXpEarned={onXpEarned}
                    />
                  ) : (
                    <AiStep
                      step={step}
                      projectSlug={project.slug}
                      onComplete={handleStepComplete}
                      onXpEarned={onXpEarned}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {allDone && (
        <div className="mt-6 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-center">
          <div className="text-emerald-700 dark:text-emerald-300 font-semibold">Project complete!</div>
          <div className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">+75 XP bonus awarded</div>
        </div>
      )}
    </div>
  )
}
