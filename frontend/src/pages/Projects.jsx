import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

const DIFFICULTY_STYLES = {
  beginner: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  intermediate: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  advanced: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API}/projects`)
      .then(r => r.json())
      .then(data => { setProjects(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">Projects</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Multi-step hands-on projects mixing skills across modules — built for interview readiness.
      </p>
      <div className="grid gap-4">
        {projects.map(p => {
          const pct = p.steps_total ? Math.round((p.steps_done / p.steps_total) * 100) : 0
          const done = pct === 100
          return (
            <Link
              key={p.slug}
              to={`/projects/${p.slug}`}
              className="block p-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-emerald-400 dark:hover:border-emerald-500 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{p.title}</h2>
                    {done && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 font-medium">
                        Done
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{p.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {p.modules.map(m => (
                      <span
                        key={m}
                        className="text-xs px-2 py-0.5 rounded-full bg-stone-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${DIFFICULTY_STYLES[p.difficulty] || DIFFICULTY_STYLES.intermediate}`}>
                    {p.difficulty}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">{p.steps_done}/{p.steps_total} steps</span>
                  {pct > 0 && !done && (
                    <div className="w-16 h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
