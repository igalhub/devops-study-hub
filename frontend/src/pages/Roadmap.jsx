const GROUP_ORDER = ['Foundations', 'Containers & Infra', 'CI/CD & Cloud', 'Security & APIs', 'Observability']

function ModuleCard({ mod, progress }) {
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
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{pct}%</div>
    </div>
  )
}

export default function Roadmap({ modules, progress }) {
  const grouped = GROUP_ORDER.map(group => ({
    group,
    modules: modules.filter(m => m.group === group),
  }))

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-6">Roadmap</h1>
      {grouped.map(({ group, modules: mods }) => (
        <div key={group} className="mb-8">
          <h2 className="text-xs font-semibold tracking-widest uppercase text-gray-400 dark:text-gray-500 mb-3">{group}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {mods.map(mod => (
              <ModuleCard key={mod.slug} mod={mod} progress={progress} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
