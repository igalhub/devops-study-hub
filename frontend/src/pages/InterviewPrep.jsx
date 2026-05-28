import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { fetchInterviewQuestions, evaluateAnswerWithSrs, fetchInterviewReviewQueue } from '../store/curriculumStore'

const SCORE_STYLE = {
  Strong: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950 border-emerald-300 dark:border-emerald-700',
  Adequate: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-700',
  Weak: 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700',
}

export default function InterviewPrep({ modules, progress, onXpEarned, onInterviewDueChange, interviewQueue: queueProp = null }) {
  const { moduleSlug: urlSlug } = useParams()

  const studiedModules = modules.filter(
    m => (m.lessons || []).some(l => progress[String(l.id)])
  )
  const availableModules = studiedModules.length ? studiedModules : modules

  const initialSlug = urlSlug && modules.find(m => m.slug === urlSlug)
    ? urlSlug
    : availableModules.length
      ? availableModules[Math.floor(Math.random() * availableModules.length)].slug
      : ''

  // Main session state
  const [selectedSlug, setSelectedSlug] = useState(initialSlug)
  const [phase, setPhase] = useState('idle') // idle | loading | active | evaluating | reviewed | done
  const [questions, setQuestions] = useState([])
  const [qIndex, setQIndex] = useState(0)
  const [answer, setAnswer] = useState('')
  const [evaluation, setEvaluation] = useState(null)
  const [results, setResults] = useState([])
  const [modelOpen, setModelOpen] = useState(false)
  const [error, setError] = useState(null)

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
  useEffect(() => () => { isMounted.current = false }, [])

  // Sync when App's isolated fetch completes (queueProp transitions null → loaded)
  useEffect(() => {
    if (reviewQueue === null && queueProp !== null) setReviewQueue(queueProp)
  }, [queueProp])

  useEffect(() => {
    if ((phase === 'reviewed' || reviewPhase === 'reviewed_card') && topRef.current) {
      const main = topRef.current.closest('main')
      if (main) main.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [phase, reviewPhase])

  // ---- Main session handlers -----------------------------------------------

  const start = async () => {
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
    } catch {
      if (!isMounted.current) return
      setError('Evaluation failed. Try again.')
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
    setPhase('idle')
    setQuestions([])
    setQIndex(0)
    setAnswer('')
    setEvaluation(null)
    setResults([])
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
    } catch {
      if (!isMounted.current) return
      setError('Evaluation failed. Try again.')
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
      .then(q => { setReviewQueue(q); if (onInterviewDueChange) onInterviewDueChange(q.length) })
      .catch(() => { setReviewQueue([]); if (onInterviewDueChange) onInterviewDueChange(0) })
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

        <p className="text-gray-800 dark:text-gray-100 text-base leading-relaxed mb-5">{card.question}</p>

        {(reviewPhase === 'active' || reviewPhase === 'submitting') && (
          <>
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

      {availableModules.length === 0 ? (
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
              {availableModules.map(m => (
                <option key={m.slug} value={m.slug}>{m.title}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-red-500 mb-3">{error}</p>}
          <button
            onClick={start}
            disabled={!selectedSlug || phase === 'loading'}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {phase === 'loading' ? 'Generating questions…' : 'Start Session'}
          </button>
        </>
      )}
    </div>
  )

  if (phase === 'done') {
    const counts = { Strong: 0, Adequate: 0, Weak: 0 }
    results.forEach(r => { if (r.score in counts) counts[r.score]++ })
    return (
      <div className="p-6 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">Session Complete</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{selectedModule?.title}</p>
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
          {results.map((r, i) => (
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
          onClick={reset}
          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          New Session
        </button>
      </div>
    )
  }

  // Active / Evaluating / Reviewed ------------------------------------------
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

      {phase === 'reviewed' && evaluation && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${SCORE_STYLE[evaluation.score]}`}>
              {evaluation.score}
            </div>
            {evaluation.xp_earned > 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">+{evaluation.xp_earned} XP</span>
            )}
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
