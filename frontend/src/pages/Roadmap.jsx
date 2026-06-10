import { Link } from 'react-router-dom'
import { getRecentLessons } from '../store/curriculumStore'
import { readinessColor } from '../utils/readiness'

const GROUP_ORDER = ['Foundations', 'Containers & Infra', 'CI/CD & Cloud', 'Security & APIs', 'Observability']

function ModuleCard({ mod, progress, readiness }) {
  const lessons = mod.lessons || []
  const done = lessons.filter(l => progress[String(l.id)] === 'complete').length
  const pct = lessons.length ? Math.round((done / lessons.length) * 100) : 0
  const status = mod.is_locked ? 'locked' : pct === 100 ? 'complete' : pct > 0 ? 'in_progress' : 'not_started'

  const colors = {
    complete: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950',
    in_progress: 'border-amber-400 bg-amber-50 dark:bg-amber-950',
    not_started: 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800',
    locked: 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800',
  }

  return (
    <div className={`rounded-lg border p-4 ${colors[status]}`}>
      <div className="font-medium text-sm text-gray-800 dark:text-gray-100 mb-1">{mod.title}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">{lessons.length} lessons</div>
      <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <div className="text-xs text-gray-500 dark:text-gray-400">{pct}%</div>
        {readiness && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-400 dark:text-gray-500">progress</span>
            <span className={`text-xs font-semibold ${readinessColor(readiness.readiness)}`}>
              {readiness.readiness}%
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Roadmap({ modules, progress, readiness = {} }) {
  const grouped = GROUP_ORDER.map(group => ({
    group,
    modules: modules.filter(m => m.group === group),
  }))
  const lastLesson = getRecentLessons()[0]

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-6">Roadmap</h1>
      {lastLesson && (
        <Link
          to={`/module/${lastLesson.moduleSlug}/lesson/${lastLesson.lessonSlug}`}
          className="flex items-center justify-between mb-6 px-4 py-3 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/50 hover:border-emerald-400 dark:hover:border-emerald-700 transition-colors group"
        >
          <div>
            <div className="text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400 font-semibold mb-0.5">Resume</div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{lastLesson.lessonTitle}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{lastLesson.moduleTitle}</div>
          </div>
          <span className="text-emerald-500 dark:text-emerald-400 text-lg group-hover:translate-x-0.5 transition-transform">→</span>
        </Link>
      )}
      {grouped.map(({ group, modules: mods }) => (
        <div key={group} className="mb-8">
          <h2 className="text-xs font-semibold tracking-widest uppercase text-gray-400 dark:text-gray-500 mb-3">{group}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {mods.map(mod => (
              <ModuleCard key={mod.slug} mod={mod} progress={progress} readiness={readiness[mod.slug]} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
