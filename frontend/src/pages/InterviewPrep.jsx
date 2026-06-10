import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { fetchInterviewQuestions, evaluateAnswerWithSrs, fetchInterviewReviewQueue, selfGradeInterview } from '../store/curriculumStore'

const MOCK_QUESTION_COUNT = 8
const MOCK_DURATION_S = 15 * 60 // 900 seconds

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function HintBox({ hints, resetKey }) {
  const [hintCount, setHintCount] = useState(0)
  // Reset when question changes
  useEffect(() => { setHintCount(0) }, [resetKey])
  if (!hints || hints.length === 0) return null
  return (
    <div className="mb-4 space-y-2">
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

const SCORE_STYLE = {
  Strong: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950 border-emerald-300 dark:border-emerald-700',
  Adequate: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-700',
  Weak: 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700',
}

export default function InterviewPrep({ modules, onXpEarned, interviewQueue: queueProp = null }) {
  const { moduleSlug: urlSlug } = useParams()

  const initialSlug = urlSlug && modules.find(m => m.slug === urlSlug)
    ? urlSlug
    : modules.length
      ? modules[Math.floor(Math.random() * modules.length)].slug
      : ''

  // Main session state
  const [selectedSlug, setSelectedSlug] = useState(initialSlug)
  const [mode, setMode] = useState('ai') // ai | flashcard | mock
  const [phase, setPhase] = useState('idle') // idle | loading | active | evaluating | reviewed | mock_reviewed | done
  const [questions, setQuestions] = useState([])
  const [qIndex, setQIndex] = useState(0)
  const [answer, setAnswer] = useState('')
  const [evaluation, setEvaluation] = useState(null)
  const [results, setResults] = useState([])
  const [modelOpen, setModelOpen] = useState(false)
  const [error, setError] = useState(null)

  // Mock session state
  const [mockSecondsLeft, setMockSecondsLeft] = useState(MOCK_DURATION_S)
  const [mockStartTime, setMockStartTime] = useState(null)
  const [mockModelOpen, setMockModelOpen] = useState(false)

  // Review session state
  const [reviewQueue, setReviewQueue] = useState(queueProp) // null = loading, [] = empty
  const [reviewPhase, setReviewPhase] = useState('idle') // idle | active | submitting | reviewed_card | done
  const [reviewIndex, setReviewIndex] = useState(0)
  const [reviewAnswer, setReviewAnswer] = useState('')
  const [reviewEval, setReviewEval] = useState(null)
  const [reviewModelOpen, setReviewModelOpen] = useState(false)
  const [reviewResults, setReviewResults] = useState([])

  const selectedModule = modules.find(m => m.slug === selectedSlug)
  const topRef = useRef(null)
  const isMounted = useRef(true)
  // Refs for timer auto-submit (avoid stale closures)
  const mockAnswerRef = useRef('')
  const mockQIndexRef = useRef(0)

  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  // Keep refs in sync with state for timer auto-submit
  useEffect(() => { mockAnswerRef.current = answer }, [answer])
  useEffect(() => { mockQIndexRef.current = qIndex }, [qIndex])

  // Sync when App's isolated fetch completes (queueProp transitions null → loaded)
  useEffect(() => {
    if (reviewQueue === null && queueProp !== null) setReviewQueue(queueProp)
  }, [queueProp])

  useEffect(() => {
    if ((phase === 'reviewed' || phase === 'mock_reviewed' || reviewPhase === 'reviewed_card') && topRef.current) {
      const main = topRef.current.closest('main')
      if (main) main.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [phase, reviewPhase])

  // Mock countdown timer — ticks every second, auto-submits at zero.
  // Paused during mock_reviewed so time spent rating doesn't corrupt results.
  useEffect(() => {
    if (mode !== 'mock' || phase !== 'active') return
    if (mockSecondsLeft <= 0) {
      const currentQ = questions[mockQIndexRef.current]
      if (currentQ) {
        setResults(prev => [...prev, {
          question: currentQ.question,
          answer: mockAnswerRef.current,
          model_answer: currentQ.model_answer,
          score: null,
        }])
      }
      setPhase('done')
      return
    }
    const id = setTimeout(() => setMockSecondsLeft(s => s - 1), 1000)
    return () => clearTimeout(id)
  }, [mode, phase, mockSecondsLeft, questions])

  // ---- Main session handlers -----------------------------------------------

  const start = async (startMode = mode) => {
    setMode(startMode)
    setPhase('loading')
    setError(null)
    try {
      const qs = await fetchInterviewQuestions(selectedSlug)
      setQuestions(qs)
      setQIndex(0)
      setAnswer('')
      setEvaluation(null)
      setResults([])
      setPhase('active')
    } catch {
      setError('Failed to load questions. Make sure the backend is running.')
      setPhase('idle')
    }
  }

  const reveal = () => setPhase('reviewed')

  const selfRate = async (score) => {
    try {
      const ev = await selfGradeInterview(selectedSlug, questions[qIndex].id, score)
      if (!isMounted.current) return
      setEvaluation(ev)
      if (ev.xp_earned > 0 && onXpEarned) onXpEarned(ev.xp_total)
    } catch {
      if (!isMounted.current) return
      setError('Failed to record rating. Try again.')
    }
  }

  const submit = async () => {
    if (!answer.trim()) return
    setPhase('evaluating')
    try {
      const ev = await evaluateAnswerWithSrs(selectedSlug, questions[qIndex].id, questions[qIndex].question, answer)
      if (!isMounted.current) return
      setEvaluation(ev)
      setModelOpen(false)
      setPhase('reviewed')
      if (ev.xp_earned > 0 && onXpEarned) onXpEarned(ev.xp_total)
    } catch (err) {
      if (!isMounted.current) return
      setError(err?.message?.includes('504') ? 'Evaluation timed out — please try again.' : 'Evaluation failed. Try again.')
      setPhase('active')
    }
  }

  const advance = () => {
    const newResults = [...results, { question: questions[qIndex].question, answer, ...evaluation }]
    if (qIndex + 1 >= questions.length) {
      setResults(newResults)
      setPhase('done')
    } else {
      setResults(newResults)
      setQIndex(i => i + 1)
      setAnswer('')
      setEvaluation(null)
      setPhase('active')
    }
  }

  const reset = () => {
    setMode('ai')
    setPhase('idle')
    setQuestions([])
    setQIndex(0)
    setAnswer('')
    setEvaluation(null)
    setResults([])
    setError(null)
  }

  // ---- Mock session handlers ------------------------------------------------

  const startMock = async () => {
    setMode('mock')
    setPhase('loading')
    setError(null)
    try {
      const qs = await fetchInterviewQuestions(selectedSlug)
      const shuffled = [...qs].sort(() => Math.random() - 0.5).slice(0, MOCK_QUESTION_COUNT)
      setQuestions(shuffled)
      setQIndex(0)
      setAnswer('')
      setEvaluation(null)
      setResults([])
      setMockSecondsLeft(MOCK_DURATION_S)
      setMockStartTime(Date.now())
      setMockModelOpen(false)
      setPhase('active')
    } catch {
      setError('Failed to load questions. Make sure the backend is running.')
      setPhase('idle')
    }
  }

  const mockReveal = () => {
    setMockModelOpen(false)
    setPhase('mock_reviewed')
  }

  const mockSelfRate = (score) => {
    const q = questions[qIndex]
    const entry = { question: q.question, answer, model_answer: q.model_answer, score }
    const newResults = [...results, entry]
    if (qIndex + 1 >= questions.length) {
      setResults(newResults)
      setPhase('done')
    } else {
      setResults(newResults)
      setQIndex(i => i + 1)
      setAnswer('')
      setMockModelOpen(false)
      setPhase('active')
    }
  }

  const mockReset = () => {
    setMode('ai')
    setPhase('idle')
    setQuestions([])
    setQIndex(0)
    setAnswer('')
    setEvaluation(null)
    setResults([])
    setMockSecondsLeft(MOCK_DURATION_S)
    setMockStartTime(null)
    setMockModelOpen(false)
    setError(null)
  }

  // ---- Review session handlers ---------------------------------------------

  const startReview = () => {
    setReviewIndex(0)
    setReviewAnswer('')
    setReviewEval(null)
    setReviewModelOpen(false)
    setReviewResults([])
    setReviewPhase('active')
  }

  const submitReview = async () => {
    if (!reviewAnswer.trim()) return
    setReviewPhase('submitting')
    const card = reviewQueue[reviewIndex]
    try {
      const ev = await evaluateAnswerWithSrs(card.module_slug, card.id, card.question, reviewAnswer)
      if (!isMounted.current) return
      setReviewEval(ev)
      setReviewModelOpen(false)
      setReviewPhase('reviewed_card')
      if (ev.xp_earned > 0 && onXpEarned) onXpEarned(ev.xp_total)
    } catch (err) {
      if (!isMounted.current) return
      setError(err?.message?.includes('504') ? 'Evaluation timed out — please try again.' : 'Evaluation failed. Try again.')
      setReviewPhase('active')
    }
  }

  const advanceReview = () => {
    const newResults = [...reviewResults, { question: reviewQueue[reviewIndex].question, answer: reviewAnswer, ...reviewEval }]
    if (reviewIndex + 1 >= reviewQueue.length) {
      setReviewResults(newResults)
      setReviewPhase('done')
    } else {
      setReviewResults(newResults)
      setReviewIndex(i => i + 1)
      setReviewAnswer('')
      setReviewEval(null)
      setReviewModelOpen(false)
      setReviewPhase('active')
    }
  }

  const exitReview = () => {
    setReviewPhase('idle')
    setReviewAnswer('')
    setReviewEval(null)
    setReviewResults([])
    setError(null)
    fetchInterviewReviewQueue()
      .then(q => setReviewQueue(q))
      .catch(() => setReviewQueue([]))
  }

  // ---- Review session renders ----------------------------------------------

  if (reviewPhase === 'done') {
    const counts = { Strong: 0, Adequate: 0, Weak: 0 }
    reviewResults.forEach(r => { if (r.score in counts) counts[r.score]++ })
    return (
      <div className="p-6 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">Review Complete</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {reviewQueue.length} question{reviewQueue.length === 1 ? '' : 's'} reviewed
          </p>
        </div>
        <div className="flex gap-3 mb-6">
          {Object.entries(counts).map(([score, n]) => (
            <div key={score} className={`flex-1 text-center py-3 rounded-lg border text-sm font-medium ${SCORE_STYLE[score]}`}>
              <div className="text-2xl font-bold">{n}</div>
              <div>{score}</div>
            </div>
          ))}
        </div>
        <div className="space-y-3 mb-6">
          {reviewResults.map((r, i) => (
            <div key={i} className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">{r.question}</p>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border font-medium ${SCORE_STYLE[r.score]}`}>
                  {r.score}
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">{r.feedback}</p>
            </div>
          ))}
        </div>
        <button
          onClick={exitReview}
          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          Back to Interview Prep
        </button>
      </div>
    )
  }

  if (reviewPhase !== 'idle') {
    const card = reviewQueue[reviewIndex]
    return (
      <div ref={topRef} className="p-6 max-w-2xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{card.module_title} · Due for Review</p>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              Question {reviewIndex + 1} of {reviewQueue.length}
            </h1>
          </div>
          <div className="flex items-center gap-3">
          <button
            onClick={exitReview}
            className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline"
          >
            Exit review
          </button>
          <div className="flex gap-1.5">
            {reviewQueue.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full ${
                  i < reviewResults.length
                    ? 'bg-emerald-500'
                    : i === reviewIndex
                      ? 'bg-gray-400 dark:bg-gray-500'
                      : 'bg-gray-200 dark:bg-gray-700'
                }`}
              />
            ))}
          </div>
          </div>
        </div>

        <p className="text-gray-800 dark:text-gray-100 text-base leading-relaxed mb-5">{card.question}</p>

        {(reviewPhase === 'active' || reviewPhase === 'submitting') && (
          <>
            <HintBox hints={card.hints ?? []} resetKey={reviewIndex} />
            <textarea
              value={reviewAnswer}
              onChange={e => setReviewAnswer(e.target.value)}
              disabled={reviewPhase === 'submitting'}
              placeholder="Type your answer here…"
              rows={6}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-3"
            />
            {error && <p className="text-sm text-red-500 mb-2">{error}</p>}
            <button
              onClick={submitReview}
              disabled={!reviewAnswer.trim() || reviewPhase === 'submitting'}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {reviewPhase === 'submitting' ? 'Evaluating…' : 'Submit Answer'}
            </button>
          </>
        )}

        {reviewPhase === 'reviewed_card' && reviewEval && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${SCORE_STYLE[reviewEval.score]}`}>
                {reviewEval.score}
              </div>
              {reviewEval.xp_earned > 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">+{reviewEval.xp_earned} XP</span>
              )}
            </div>

            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Your answer</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 italic leading-relaxed">{reviewAnswer}</p>
            </div>

            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Feedback</p>
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{reviewEval.feedback}</p>
            </div>

            <div>
              <button
                onClick={() => setReviewModelOpen(o => !o)}
                className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                {reviewModelOpen ? '▼ Hide model answer' : '▶ Show model answer'}
              </button>
              {reviewModelOpen && (
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed border-l-2 border-emerald-400 pl-3">
                  {reviewEval.model_answer}
                </p>
              )}
            </div>

            <button
              onClick={advanceReview}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
            >
              {reviewIndex + 1 >= reviewQueue.length ? 'Finish Review' : 'Next Question'}
            </button>
          </div>
        )}
      </div>
    )
  }

  // ---- Main session renders -----------------------------------------------

  if (phase === 'idle' || phase === 'loading') return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">Interview Prep</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Practice answering real DevOps interview questions. AI grades your answer and shows a model response.
      </p>

      {reviewQueue !== null && reviewQueue.length > 0 && (
        <div className="mb-6 p-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-1">
            {reviewQueue.length} question{reviewQueue.length === 1 ? '' : 's'} due for review
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
            Practice these to keep your SRS schedule on track.
          </p>
          <button
            onClick={startReview}
            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
          >
            Practice Due
          </button>
        </div>
      )}

      {modules.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No modules available yet.</p>
      ) : (
        <>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Module
            </label>
            <select
              value={selectedSlug}
              onChange={e => setSelectedSlug(e.target.value)}
              disabled={phase === 'loading'}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {modules.map(m => (
                <option key={m.slug} value={m.slug}>{m.title}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-red-500 mb-3">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => start('ai')}
              disabled={!selectedSlug || phase === 'loading'}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {phase === 'loading' ? 'Loading…' : 'Start Session'}
            </button>
            <button
              onClick={() => start('flashcard')}
              disabled={!selectedSlug || phase === 'loading'}
              className="px-4 py-2 rounded-lg border border-emerald-600 text-emerald-600 dark:text-emerald-400 dark:border-emerald-500 text-sm font-medium hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-50 transition-colors"
              title="Reveal model answers and self-grade — no AI calls"
            >
              Quick Review
            </button>
            <button
              onClick={startMock}
              disabled={!selectedSlug || phase === 'loading'}
              className="px-4 py-2 rounded-lg border border-indigo-500 text-indigo-600 dark:text-indigo-400 text-sm font-medium hover:bg-indigo-50 dark:hover:bg-indigo-950/30 disabled:opacity-50 transition-colors"
              title={`${MOCK_QUESTION_COUNT} random questions, ${MOCK_DURATION_S / 60}-minute countdown — no backend writes`}
            >
              Mock Interview
            </button>
          </div>
        </>
      )}
    </div>
  )

  if (phase === 'done') {
    const counts = { Strong: 0, Adequate: 0, Weak: 0 }
    results.forEach(r => { if (r.score in counts) counts[r.score]++ })

    const isMock = mode === 'mock'
    const answeredCount = isMock ? results.filter(r => r.score !== null).length : results.length
    const strongCount = counts.Strong
    const adequateCount = counts.Adequate
    const mockAccuracy = answeredCount > 0
      ? Math.round(((strongCount + adequateCount) / answeredCount) * 100)
      : 0
    const elapsedS = isMock && mockStartTime
      ? Math.min(Math.round((Date.now() - mockStartTime) / 1000), MOCK_DURATION_S)
      : 0

    return (
      <div className="p-6 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">
            {isMock ? 'Mock Interview Complete' : mode === 'flashcard' ? 'Flashcard Session Complete' : 'Session Complete'}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{selectedModule?.title}</p>
        </div>

        {isMock && (
          <div className="flex gap-6 mb-5 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Accuracy </span>
              <span className={`font-semibold ${mockAccuracy >= 75 ? 'text-emerald-600 dark:text-emerald-400' : mockAccuracy >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                {mockAccuracy}%
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Time </span>
              <span className="font-semibold text-gray-700 dark:text-gray-300">{formatTime(elapsedS)}</span>
              <span className="text-gray-400 dark:text-gray-500"> / {formatTime(MOCK_DURATION_S)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Answered </span>
              <span className="font-semibold text-gray-700 dark:text-gray-300">{answeredCount}/{results.length}</span>
            </div>
          </div>
        )}

        <div className="flex gap-3 mb-6">
          {Object.entries(counts).map(([score, n]) => (
            <div key={score} className={`flex-1 text-center py-3 rounded-lg border text-sm font-medium ${SCORE_STYLE[score]}`}>
              <div className="text-2xl font-bold">{n}</div>
              <div>{score}</div>
            </div>
          ))}
        </div>

        <div className="space-y-3 mb-6">
          {results.map((r, i) => (
            <div key={i} className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">{r.question}</p>
                {r.score ? (
                  <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border font-medium ${SCORE_STYLE[r.score]}`}>
                    {r.score}
                  </span>
                ) : (
                  <span className="shrink-0 text-xs px-2 py-0.5 rounded-full border font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600">
                    Timed out
                  </span>
                )}
              </div>
              {isMock ? (
                <>
                  {r.answer && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 italic mb-1">{r.answer}</p>
                  )}
                  {r.model_answer && (
                    <p className="text-xs text-emerald-700 dark:text-emerald-400 border-l-2 border-emerald-400 pl-2 mt-1">
                      {r.model_answer}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">{r.feedback}</p>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={isMock ? mockReset : reset}
          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          {isMock ? 'New Mock Interview' : 'New Session'}
        </button>
      </div>
    )
  }

  // Active / Evaluating / Reviewed / Mock-Reviewed ---------------------------
  const q = questions[qIndex]
  return (
    <div ref={topRef} className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{selectedModule?.title}</p>
          <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
            Question {qIndex + 1} of {questions.length}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {mode === 'mock' && (
            <div className={`text-sm font-mono font-semibold px-2.5 py-1 rounded-lg border ${
              mockSecondsLeft <= 60
                ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700'
                : 'text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
            }`}>
              {formatTime(mockSecondsLeft)}
            </div>
          )}
          <button
            onClick={mode === 'mock' ? mockReset : reset}
            className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline"
          >
            Exit session
          </button>
        </div>
        <div className="flex gap-1.5">
          {questions.map((_, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full ${
                i < results.length
                  ? 'bg-emerald-500'
                  : i === qIndex
                    ? 'bg-gray-400 dark:bg-gray-500'
                    : 'bg-gray-200 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>
      </div>

      <p className="text-gray-800 dark:text-gray-100 text-base leading-relaxed mb-5">{q.question}</p>

      {(phase === 'active' || phase === 'evaluating') && (
        <>
          {mode !== 'mock' && <HintBox hints={q.hints ?? []} resetKey={qIndex} />}
          {mode === 'mock' ? (
            <>
              <textarea
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                placeholder="Type your answer here…"
                rows={6}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-3"
              />
              {error && <p className="text-sm text-red-500 mb-2">{error}</p>}
              <button
                onClick={mockReveal}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
              >
                Submit Answer
              </button>
            </>
          ) : mode === 'flashcard' ? (
            <>
              {error && <p className="text-sm text-red-500 mb-2">{error}</p>}
              <button
                onClick={reveal}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
              >
                Reveal Answer
              </button>
            </>
          ) : (
            <>
              <textarea
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                disabled={phase === 'evaluating'}
                placeholder="Type your answer here…"
                rows={6}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-3"
              />
              {error && <p className="text-sm text-red-500 mb-2">{error}</p>}
              <button
                onClick={submit}
                disabled={!answer.trim() || phase === 'evaluating'}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {phase === 'evaluating' ? 'Evaluating…' : 'Submit Answer'}
              </button>
            </>
          )}
        </>
      )}

      {phase === 'mock_reviewed' && (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Your answer</p>
            <p className="text-sm text-gray-600 dark:text-gray-400 italic leading-relaxed">
              {answer || <span className="text-gray-300 dark:text-gray-600">No answer entered</span>}
            </p>
          </div>
          <div>
            <button
              onClick={() => setMockModelOpen(o => !o)}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {mockModelOpen ? '▼ Hide model answer' : '▶ Show model answer'}
            </button>
            {mockModelOpen && (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed border-l-2 border-indigo-400 pl-3">
                {q.model_answer || <span className="italic text-gray-400">No model answer seeded yet</span>}
              </p>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">How well did you know this?</p>
          <div className="flex gap-2">
            {(['Strong', 'Adequate', 'Weak']).map(score => (
              <button
                key={score}
                onClick={() => mockSelfRate(score)}
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${SCORE_STYLE[score]} hover:opacity-80`}
              >
                {score}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === 'reviewed' && mode === 'flashcard' && (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Model Answer</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed border-l-2 border-emerald-400 pl-3">
              {q.model_answer || <span className="italic text-gray-400">No model answer seeded yet — run seed_interview.py --model-answers</span>}
            </p>
          </div>
          {!evaluation ? (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400">How well did you know this?</p>
              {error && <p className="text-sm text-red-500 mb-1">{error}</p>}
              <div className="flex gap-2">
                {(['Strong', 'Adequate', 'Weak']).map(score => (
                  <button
                    key={score}
                    onClick={() => selfRate(score)}
                    className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${SCORE_STYLE[score]} hover:opacity-80`}
                  >
                    {score}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${SCORE_STYLE[evaluation.score]}`}>
                  {evaluation.score}
                </div>
                {evaluation.xp_earned > 0 && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">+{evaluation.xp_earned} XP</span>
                )}
              </div>
              <button
                onClick={advance}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
              >
                {qIndex + 1 >= questions.length ? 'Finish Session' : 'Next Question'}
              </button>
            </>
          )}
        </div>
      )}

      {phase === 'reviewed' && mode === 'ai' && evaluation && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${SCORE_STYLE[evaluation.score]}`}>
              {evaluation.score}
            </div>
            {evaluation.xp_earned > 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">+{evaluation.xp_earned} XP</span>
            )}
            <button
              onClick={() => { setEvaluation(null); setPhase('active') }}
              className="ml-auto text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline"
            >
              Edit answer
            </button>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Your answer</p>
            <p className="text-sm text-gray-600 dark:text-gray-400 italic leading-relaxed">{answer}</p>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Feedback</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{evaluation.feedback}</p>
          </div>

          <div>
            <button
              onClick={() => setModelOpen(o => !o)}
              className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
            >
              {modelOpen ? '▼ Hide model answer' : '▶ Show model answer'}
            </button>
            {modelOpen && (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 leading-relaxed border-l-2 border-emerald-400 pl-3">
                {evaluation.model_answer}
              </p>
            )}
          </div>

          <button
            onClick={advance}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
          >
            {qIndex + 1 >= questions.length ? 'Finish Session' : 'Next Question'}
          </button>
        </div>
      )}
    </div>
  )
}
