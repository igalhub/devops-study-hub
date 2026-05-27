import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { markLessonComplete, resetLessonProgress } from '../store/curriculumStore'

export default function ModuleView({ modules, progress, onProgressUpdate }) {
  const { moduleSlug } = useParams()
  const navigate = useNavigate()
  const [completedBanner, setCompletedBanner] = useState(false)
  const mod = modules.find(m => m.slug === moduleSlug)

  if (!mod) return (
    <div className="p-6 text-gray-500 dark:text-gray-400">Module not found.</div>
  )

  const lessons = mod.lessons || []

  const handleComplete = async (lessonId) => {
    try {
      const result = await markLessonComplete(lessonId)
      onProgressUpdate()
      if (result.module_completed) setCompletedBanner(true)
    } catch (e) {
      console.error('Failed to mark lesson complete:', e)
    }
  }

  const handleReset = async (lessonId) => {
    try {
      await resetLessonProgress(lessonId)
      onProgressUpdate()
    } catch (e) {
      console.error('Failed to reset lesson:', e)
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">{mod.title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{lessons.length} lessons</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => navigate(`/module/${moduleSlug}/quiz`)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
          >
            Module Quiz
          </button>
          <button
            onClick={() => navigate(`/interview/${moduleSlug}`)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
          >
            Practice Interview
          </button>
        </div>
      </div>

      {completedBanner && (
        <div className="mb-6 flex items-start justify-between gap-4 px-4 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-950 border border-emerald-300 dark:border-emerald-800">
          <div>
            <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Module complete!</div>
            <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">+50 XP module bonus earned.</div>
          </div>
          <button
            onClick={() => setCompletedBanner(false)}
            className="text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 text-sm leading-none"
          >
            ✕
          </button>
        </div>
      )}

      <div className="space-y-2">
        {lessons.map(lesson => {
          const status = progress[String(lesson.id)] || 'not_started'
          const done = status === 'complete'
          return (
            <div
              key={lesson.id}
              className={`flex items-center justify-between p-3 rounded-lg border transition-colors
                ${done
                  ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950 dark:border-emerald-800'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                }`}
            >
              <div>
                <Link
                  to={`/module/${moduleSlug}/lesson/${lesson.slug}`}
                  className="text-sm font-medium text-gray-800 dark:text-gray-100 hover:text-emerald-600 dark:hover:text-emerald-400"
                >
                  {lesson.title}
                </Link>
                <div className="text-xs text-gray-400 mt-0.5">
                  {lesson.duration_min} min · {lesson.difficulty}
                </div>
              </div>
              {!done && (
                <button
                  onClick={() => handleComplete(lesson.id)}
                  className="text-xs px-3 py-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                >
                  Mark done
                </button>
              )}
              {done && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">✓ Done</span>
                  <button
                    onClick={() => handleReset(lesson.id)}
                    className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                  >
                    Reset
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
