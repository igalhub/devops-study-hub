import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { fetchModuleQuiz, logAttempt } from '../store/curriculumStore'

export default function ModuleQuiz({ modules }) {
  const { moduleSlug } = useParams()
  const mod = modules.find(m => m.slug === moduleSlug)

  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState('idle') // idle | active | done
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState(null)
  const [revealed, setRevealed] = useState(false)
  const [score, setScore] = useState(0)
  const [xpEarned, setXpEarned] = useState(0)

  useEffect(() => {
    fetchModuleQuiz(moduleSlug)
      .then(data => { setQuestions(data); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [moduleSlug])

  const start = () => {
    setIndex(0); setSelected(null); setRevealed(false)
    setScore(0); setXpEarned(0); setPhase('active')
  }

  const handleSelect = async (idx) => {
    if (selected !== null) return
    setSelected(idx)
    setRevealed(true)
    const card = questions[index]
    const correct = idx === card.correct_index
    if (correct) setScore(s => s + 1)
    try {
      const result = await logAttempt(card.id, correct)
      if (result.xp_earned > 0) setXpEarned(x => x + result.xp_earned)
    } catch { /* silent */ }
  }

  const next = () => {
    if (index + 1 >= questions.length) {
      setPhase('done')
    } else {
      setIndex(i => i + 1)
      setSelected(null)
      setRevealed(false)
    }
  }

  if (loading) return (
    <div className="p-6 text-gray-400 dark:text-gray-500 text-sm">Loading questions…</div>
  )

  if (error) return (
    <div className="p-6">
      <Link to={`/module/${moduleSlug}`} className="text-sm text-gray-400 hover:text-emerald-600 transition-colors">← Back</Link>
      <p className="mt-4 text-sm text-red-500">{error}</p>
    </div>
  )

  if (questions.length === 0) return (
    <div className="p-6 max-w-xl">
      <Link to={`/module/${moduleSlug}`} className="text-sm text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">← {mod?.title}</Link>
      <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
        No quiz questions yet — open individual lessons to generate them first.
      </p>
    </div>
  )

  if (phase === 'idle') return (
    <div className="p-6 max-w-xl">
      <Link to={`/module/${moduleSlug}`} className="text-sm text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">← {mod?.title}</Link>
      <div className="mt-6">
        <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">Module Quiz</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {questions.length} questions across all lessons in {mod?.title}.
        </p>
        <button
          onClick={start}
          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Start Quiz
        </button>
      </div>
    </div>
  )

  if (phase === 'done') {
    const pct = Math.round((score / questions.length) * 100)
    const color = pct >= 80 ? 'text-emerald-500' : pct >= 60 ? 'text-amber-500' : 'text-red-500'
    return (
      <div className="p-6 max-w-xl">
        <Link to={`/module/${moduleSlug}`} className="text-sm text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">← {mod?.title}</Link>
        <div className="mt-6 flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Quiz Complete</h1>
          <div className={`text-5xl font-bold ${color}`}>{pct}%</div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{score} / {questions.length} correct</p>
          {xpEarned > 0 && (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">+{xpEarned} XP earned</p>
          )}
          <div className="flex gap-3 pt-2">
            <button
              onClick={start}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Retake
            </button>
            <Link
              to={`/module/${moduleSlug}`}
              className="px-5 py-2 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 text-sm font-medium rounded-lg transition-colors"
            >
              Back to module
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const card = questions[index]
  return (
    <div className="p-6 max-w-xl">
      <div className="flex items-center justify-between mb-6">
        <Link to={`/module/${moduleSlug}`} className="text-sm text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">← {mod?.title}</Link>
        <span className="text-xs text-gray-400 dark:text-gray-500">{index + 1} / {questions.length}</span>
      </div>

      <div className="mb-1 text-xs text-gray-400 dark:text-gray-500">{card.lesson_title}</div>
      <p className="text-base font-medium text-gray-800 dark:text-gray-100 leading-snug mb-6">{card.question}</p>

      <div className="flex flex-col gap-2 mb-6">
        {card.options.map((opt, i) => {
          let cls = 'text-left w-full text-sm px-4 py-2.5 rounded-lg border transition-colors '
          if (selected === null) {
            cls += 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer'
          } else if (i === card.correct_index) {
            cls += 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
          } else if (i === selected) {
            cls += 'border-red-400 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
          } else {
            cls += 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 opacity-50'
          }
          return (
            <button key={i} className={cls} onClick={() => handleSelect(i)} disabled={selected !== null}>
              <span className="font-medium mr-2">{String.fromCharCode(65 + i)}.</span>{opt}
            </button>
          )
        })}
      </div>

      {revealed && selected !== null && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg px-4 py-3 leading-relaxed">
            {card.explanation}
          </div>
          <button
            onClick={next}
            className="self-end px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {index + 1 >= questions.length ? 'Finish' : 'Next →'}
          </button>
        </div>
      )}
    </div>
  )
}
