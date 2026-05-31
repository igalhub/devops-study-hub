import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { fetchWeakAreaQuestions, logAttempt } from '../store/curriculumStore'

export default function Drill({ onXpEarned }) {
  const [questions, setQuestions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [phase, setPhase] = useState('idle') // idle | active | done
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [selected, setSelected] = useState(null)
  const [score, setScore] = useState(0)
  const [xpEarned, setXpEarned] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchWeakAreaQuestions()
      .then(data => setQuestions(data))
      .catch(() => setQuestions([]))
      .finally(() => setLoading(false))
  }, [])

  const start = () => {
    setIndex(0)
    setRevealed(false)
    setSelected(null)
    setScore(0)
    setXpEarned(0)
    setPhase('active')
  }

  const handleSelect = async (idx) => {
    if (selected !== null) return
    setSelected(idx)
    setRevealed(true)
    setSubmitting(true)
    const card = questions[index]
    const correct = idx === card.correct_index
    if (correct) setScore(s => s + 1)
    try {
      const result = await logAttempt(card.id, correct)
      if (result.xp_earned > 0) {
        setXpEarned(x => x + result.xp_earned)
        onXpEarned?.(result.xp_total)
      }
    } catch { /* silent */ }
    setSubmitting(false)
  }

  const next = () => {
    if (index + 1 >= questions.length) {
      setPhase('done')
    } else {
      setIndex(i => i + 1)
      setRevealed(false)
      setSelected(null)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-sm">Loading…</div>
  )

  if (phase === 'idle') {
    if (!questions || questions.length === 0) return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
        <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">No weak areas yet</div>
        <div className="text-xs text-gray-400 dark:text-gray-500 max-w-xs">
          Complete quizzes on a few lessons — any topics below 70% accuracy (≥ 3 attempts) will appear here.
        </div>
        <Link to="/stats" className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline mt-2">← Back to Stats</Link>
      </div>
    )
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 px-8 text-center">
        <div>
          <div className="text-4xl font-bold text-gray-800 dark:text-gray-100 mb-2">{questions.length}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">questions from your weakest lessons</div>
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Topics below 70% accuracy</div>
        </div>
        <button
          onClick={start}
          className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Start Drill
        </button>
        <Link to="/stats" className="text-xs text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">← Back to Stats</Link>
      </div>
    )
  }

  if (phase === 'done') {
    const pct = Math.round((score / questions.length) * 100)
    const color = pct >= 80 ? 'text-emerald-500' : pct >= 60 ? 'text-amber-500' : 'text-red-500'
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
        <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">Drill complete</div>
        <div className={`text-5xl font-bold ${color}`}>{pct}%</div>
        <div className="text-sm text-gray-500 dark:text-gray-400">{score} / {questions.length} correct</div>
        {xpEarned > 0 && (
          <div className="text-xs font-medium text-amber-600 dark:text-amber-400">+{xpEarned} XP earned</div>
        )}
        <div className="flex gap-3 mt-2">
          <button
            onClick={start}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Drill again
          </button>
          <Link
            to="/stats"
            className="px-5 py-2 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 text-sm font-medium rounded-lg hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
          >
            Back to Stats
          </Link>
        </div>
      </div>
    )
  }

  const card = questions[index]
  return (
    <div className="flex flex-col h-full px-8 py-8 gap-6 max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
        <span>{index + 1} / {questions.length}</span>
        <div className="flex gap-1">
          {questions.map((_, i) => (
            <div
              key={i}
              className={`h-1 w-5 rounded-full ${
                i < index ? 'bg-emerald-500' :
                i === index ? 'bg-gray-400 dark:bg-gray-500' :
                'bg-gray-200 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-400 dark:text-gray-500">
        {card.module_title} · {card.lesson_title}
      </div>

      <div className="text-lg font-medium text-gray-800 dark:text-gray-100 leading-snug">
        {card.question}
      </div>

      {!revealed ? (
        <button
          onClick={() => setRevealed(true)}
          className="self-start px-5 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
        >
          Reveal Answer
        </button>
      ) : (
        <div className="flex flex-col gap-2">
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
      )}

      {selected !== null && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg px-4 py-3 leading-relaxed">
            {card.explanation}
          </div>
          <button
            onClick={next}
            disabled={submitting}
            className="self-end px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {index + 1 >= questions.length ? 'Finish' : 'Next →'}
          </button>
        </div>
      )}
    </div>
  )
}
