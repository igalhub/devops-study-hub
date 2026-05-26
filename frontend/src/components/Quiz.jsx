import { useState, useEffect } from 'react'
import { fetchQuiz, logAttempt } from '../store/curriculumStore'

export default function Quiz({ lessonSlug, onXpEarned }) {
  const [questions, setQuestions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState('idle') // idle | active | results
  const [current, setCurrent] = useState(0)
  const [selected, setSelected] = useState(null)
  const [revealed, setRevealed] = useState(false)
  const [score, setScore] = useState(0)
  const [xpEarned, setXpEarned] = useState(0)

  useEffect(() => {
    setPhase('idle')
    setQuestions(null)
    setError(null)
  }, [lessonSlug])

  const start = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchQuiz(lessonSlug)
      setQuestions(data)
      setCurrent(0)
      setSelected(null)
      setRevealed(false)
      setScore(0)
      setXpEarned(0)
      setPhase('active')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSelect = async (idx) => {
    if (revealed) return
    setSelected(idx)
    setRevealed(true)

    const q = questions[current]
    const correct = idx === q.correct_index
    if (correct) setScore(s => s + 1)

    try {
      const result = await logAttempt(q.id, correct)
      if (result.xp_earned > 0) {
        setXpEarned(x => x + result.xp_earned)
        onXpEarned?.(result.xp_total)
      }
    } catch { /* silent */ }
  }

  const next = () => {
    if (current + 1 >= questions.length) {
      setPhase('results')
    } else {
      setCurrent(c => c + 1)
      setSelected(null)
      setRevealed(false)
    }
  }

  const retake = () => {
    setCurrent(0)
    setSelected(null)
    setRevealed(false)
    setScore(0)
    setXpEarned(0)
    setPhase('active')
  }

  if (phase === 'idle') {
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-4 text-center gap-4">
        <div>
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-1">Lesson Quiz</div>
          <div className="text-xs text-gray-400 dark:text-gray-500">5 questions · AI-generated from lesson content</div>
        </div>
        {error && <div className="text-xs text-red-500 max-w-[220px]">{error}</div>}
        <button
          onClick={start}
          disabled={loading}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? 'Generating…' : 'Start Quiz'}
        </button>
      </div>
    )
  }

  if (phase === 'results') {
    const pct = Math.round((score / questions.length) * 100)
    const color = pct >= 80 ? 'text-emerald-500' : pct >= 60 ? 'text-amber-500' : 'text-red-500'
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-4 text-center gap-3">
        <div className={`text-5xl font-bold ${color}`}>{pct}%</div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {score} / {questions.length} correct
        </div>
        {xpEarned > 0 && (
          <div className="text-xs font-medium text-amber-600 dark:text-amber-400">+{xpEarned} XP earned</div>
        )}
        <button
          onClick={retake}
          className="mt-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Retake
        </button>
      </div>
    )
  }

  const q = questions[current]
  return (
    <div className="flex flex-col flex-1 min-h-0 px-3 py-3 gap-3">
      {/* Progress dots */}
      <div className="flex items-center justify-between shrink-0">
        <span className="text-xs text-gray-400 dark:text-gray-500">{current + 1} / {questions.length}</span>
        <div className="flex gap-1">
          {questions.map((_, i) => (
            <div
              key={i}
              className={`h-1 w-4 rounded-full ${
                i < current ? 'bg-emerald-500' :
                i === current ? 'bg-gray-400 dark:bg-gray-500' :
                'bg-gray-200 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Question */}
      <div className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug shrink-0">
        {q.question}
      </div>

      {/* Options */}
      <div className="flex flex-col gap-2 flex-1">
        {q.options.map((opt, i) => {
          let cls = 'text-left w-full text-xs px-3 py-2 rounded-lg border transition-colors '
          if (!revealed) {
            cls += 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer'
          } else if (i === q.correct_index) {
            cls += 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
          } else if (i === selected) {
            cls += 'border-red-400 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
          } else {
            cls += 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 opacity-50'
          }
          return (
            <button key={i} className={cls} onClick={() => handleSelect(i)} disabled={revealed}>
              <span className="font-medium mr-1.5">{String.fromCharCode(65 + i)}.</span>{opt}
            </button>
          )
        })}
      </div>

      {/* Explanation + Next */}
      {revealed && (
        <div className="shrink-0 space-y-2">
          <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-2 leading-relaxed">
            {q.explanation}
          </div>
          <button
            onClick={next}
            className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {current + 1 >= questions.length ? 'See Results' : 'Next →'}
          </button>
        </div>
      )}
    </div>
  )
}
