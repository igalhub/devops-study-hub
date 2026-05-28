import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { fetchStats } from '../store/curriculumStore'

function XpBar({ xp, max, day }) {
  const pct = max > 0 ? Math.round((xp / max) * 100) : 0
  return (
    <div className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${xp} XP`}>
      <div
        className="bg-emerald-500 dark:bg-emerald-600 rounded-t-sm w-full transition-all"
        style={{ height: `${pct}%`, minHeight: xp > 0 ? 2 : 0 }}
      />
    </div>
  )
}

export default function Stats() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats().then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-6 text-sm text-gray-400 dark:text-gray-500">Loading…</div>
  if (!data) return <div className="p-6 text-sm text-red-500">Failed to load stats.</div>

  const { summary, xp_by_day, quiz_by_module } = data
  const quiz_weak_lessons = data.quiz_weak_lessons ?? []
  const maxXp = Math.max(...xp_by_day.map(d => d.xp), 1)
  const quizAccuracy = summary.quiz_attempts > 0
    ? Math.round((summary.quiz_correct / summary.quiz_attempts) * 100)
    : null

  const summaryCards = [
    { label: 'Total XP', value: `${summary.total_xp} XP` },
    { label: 'Lessons done', value: summary.lessons_done },
    { label: 'Quiz accuracy', value: quizAccuracy !== null ? `${quizAccuracy}%` : '—' },
    { label: 'Current streak', value: summary.streak > 0 ? `${summary.streak} day${summary.streak > 1 ? 's' : ''}` : '—' },
  ]

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Stats</h1>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {summaryCards.map(({ label, value }) => (
          <div key={label} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3">
            <div className="text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-1">{label}</div>
            <div className="text-xl font-semibold text-gray-800 dark:text-gray-100">{value}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-3">XP — last 30 days</div>
        <div className="h-24 flex items-end gap-px bg-gray-50 dark:bg-gray-800/50 rounded-lg p-2">
          {xp_by_day.map(({ day, xp }) => (
            <XpBar key={day} xp={xp} max={maxXp} day={day} />
          ))}
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-gray-400 dark:text-gray-500 px-2">
          <span>{xp_by_day[0]?.day.slice(5)}</span>
          <span>today</span>
        </div>
      </div>

      {quiz_by_module.length > 0 ? (
        <div>
          <div className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-3">Quiz accuracy by module</div>
          <div className="space-y-2.5">
            {quiz_by_module.map(({ module_title, module_slug, total, correct }) => {
              const pct = total > 0 ? Math.round((correct / total) * 100) : 0
              const barColor = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400'
              return (
                <div key={module_slug} className="flex items-center gap-3">
                  <div className="w-36 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate">{module_title}</div>
                  <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div className={`h-full ${barColor} rounded-full`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 w-16 text-right shrink-0">
                    {pct}% <span className="text-gray-400 dark:text-gray-600">({total})</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-400 dark:text-gray-500">
          No quiz attempts yet — complete some quizzes to see accuracy here.
        </p>
      )}

      {summary.quiz_attempts > 0 && (
        <div>
          <div className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Quiz Weak Areas</div>
          {/* Threshold 70 must match WHERE accuracy < 70 in backend/routes/stats.py */}
          <div className="text-xs text-gray-400 dark:text-gray-500 mb-3">
            Lessons below 70% accuracy — sorted weakest first
          </div>
          {quiz_weak_lessons.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">
              No lessons below 70% accuracy — keep it up!
            </p>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left px-4 py-2 text-gray-400 dark:text-gray-500 font-medium w-6">#</th>
                    <th className="text-left px-4 py-2 text-gray-400 dark:text-gray-500 font-medium">Lesson</th>
                    <th className="text-left px-4 py-2 text-gray-400 dark:text-gray-500 font-medium">Module</th>
                    <th className="px-4 py-2 text-gray-400 dark:text-gray-500 font-medium">Accuracy</th>
                    <th className="text-right px-4 py-2 text-gray-400 dark:text-gray-500 font-medium">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {quiz_weak_lessons.map(({ lesson_slug, lesson_title, module_slug, module_title, accuracy, attempt_count }, idx) => {
                    const barColor = accuracy >= 60 ? 'bg-amber-400' : 'bg-red-400'
                    const textColor = accuracy >= 60 ? 'text-amber-500 dark:text-amber-400' : 'text-red-500 dark:text-red-400'
                    return (
                      <tr key={`${module_slug}/${lesson_slug}`} className="border-b border-gray-100 dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-4 py-2.5 text-gray-400 dark:text-gray-600">{idx + 1}</td>
                        <td className="px-4 py-2.5">
                          <Link
                            to={`/module/${module_slug}/lesson/${lesson_slug}`}
                            className="text-gray-700 dark:text-gray-300 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                          >
                            {lesson_title}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{module_title}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div className={`h-full ${barColor} rounded-full`} style={{ width: `${accuracy}%` }} />
                            </div>
                            <span className={`${textColor} font-medium w-8 text-right`}>{accuracy}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-500 dark:text-gray-400">{attempt_count}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
