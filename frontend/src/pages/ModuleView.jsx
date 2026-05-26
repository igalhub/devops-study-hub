import { useParams, Link } from 'react-router-dom'
import { markLessonComplete } from '../store/curriculumStore'

export default function ModuleView({ modules, progress, onProgressUpdate }) {
  const { moduleSlug } = useParams()
  const mod = modules.find(m => m.slug === moduleSlug)

  if (!mod) return (
    <div className="p-6 text-gray-500 dark:text-gray-400">Module not found.</div>
  )

  const lessons = mod.lessons || []

  const handleComplete = async (lessonId) => {
    await markLessonComplete(lessonId)
    onProgressUpdate()
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">{mod.title}</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{lessons.length} lessons</p>

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
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">✓ Done</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
