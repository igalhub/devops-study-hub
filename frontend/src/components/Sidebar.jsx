import { Link, useMatch, useLocation } from 'react-router-dom'

const GROUP_ORDER = ['Foundations', 'Containers & Infra', 'CI/CD & Cloud', 'Security & APIs', 'Observability']

function Badge({ status, pct }) {
  if (status === 'complete')
    return <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 font-medium">Done</span>
  if (status === 'in_progress')
    return <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 font-medium">{pct}%</span>
  return null
}

export default function Sidebar({ modules, progress, reviewDue = 0 }) {
  const moduleMatch = useMatch('/module/:moduleSlug')
  const lessonMatch = useMatch('/module/:moduleSlug/lesson/:lessonSlug')
  const moduleSlug = (moduleMatch || lessonMatch)?.params?.moduleSlug
  const { pathname } = useLocation()
  const interviewActive = pathname.startsWith('/interview')
  const reviewActive = pathname === '/review'

  const grouped = GROUP_ORDER.map(group => ({
    group,
    modules: modules.filter(m => m.group === group),
  }))

  const getModuleStatus = (mod) => {
    const lessons = mod.lessons || []
    if (!lessons.length) return { status: 'not_started', pct: 0 }
    const done = lessons.filter(l => progress[String(l.id)] === 'complete').length
    const pct = Math.round((done / lessons.length) * 100)
    if (pct === 100) return { status: 'complete', pct: 100 }
    if (pct > 0) return { status: 'in_progress', pct }
    return { status: 'not_started', pct: 0 }
  }

  const totalLessons = modules.flatMap(m => m.lessons || []).length
  const doneLessons = Object.values(progress).filter(s => s === 'complete').length
  const overallPct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0

  const nextLesson = GROUP_ORDER
    .flatMap(group => modules.filter(m => m.group === group))
    .flatMap(m => (m.lessons || []).map(l => ({ ...l, moduleSlug: m.slug })))
    .find(l => progress[String(l.id)] !== 'complete')

  return (
    <aside className="w-[220px] shrink-0 bg-stone-200 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col h-screen sticky top-0 overflow-y-auto">
      <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="text-sm font-semibold tracking-widest uppercase text-gray-800 dark:text-gray-100">
          DevOps <span className="text-emerald-500">Hub</span>
        </div>
        <div className="mt-2 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${overallPct}%` }} />
        </div>
        <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">{overallPct}% complete</div>
        {nextLesson && (
          <Link
            to={`/module/${nextLesson.moduleSlug}/lesson/${nextLesson.slug}`}
            className="mt-2 block text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 truncate transition-colors"
          >
            Continue → {nextLesson.title}
          </Link>
        )}
      </div>

      <nav className="flex-1 py-2">
        {grouped.map(({ group, modules: mods }) => (
          <div key={group} className="mb-1">
            <div className="px-4 py-1 text-[10px] font-semibold tracking-widest uppercase text-gray-500 dark:text-gray-500">
              {group}
            </div>
            {mods.map(mod => {
              const { status, pct } = getModuleStatus(mod)
              const active = mod.slug === moduleSlug
              const baseClass = `flex items-center gap-2 mx-2 px-2 py-1.5 rounded-md text-sm transition-colors`
              const activeClass = 'bg-stone-50 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 font-medium border border-stone-300 dark:border-gray-600'
              const idleClass = 'text-gray-700 dark:text-gray-400 hover:bg-stone-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
              return (
                <Link
                  key={mod.slug}
                  to={`/module/${mod.slug}`}
                  className={`${baseClass} ${active ? activeClass : idleClass}`}
                >
                  <span className="truncate">{mod.title}</span>
                  <Badge status={status} pct={pct} />
                </Link>
              )
            })}
          </div>
        ))}
        <div className="mb-1">
          <div className="px-4 py-1 text-[10px] font-semibold tracking-widest uppercase text-gray-400 dark:text-gray-500">
            Tools
          </div>
          <Link
            to="/review"
            className={`flex items-center gap-2 mx-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
              reviewActive
                ? 'bg-white dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 font-medium border border-gray-200 dark:border-gray-600'
                : 'text-gray-700 dark:text-gray-400 hover:bg-stone-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
            }`}
          >
            <span className="truncate">Spaced Review</span>
            {reviewDue > 0 && (
              <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 font-medium">
                {reviewDue}
              </span>
            )}
          </Link>
          <Link
            to="/interview"
            className={`flex items-center gap-2 mx-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
              interviewActive
                ? 'bg-white dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 font-medium border border-gray-200 dark:border-gray-600'
                : 'text-gray-700 dark:text-gray-400 hover:bg-stone-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
            }`}
          >
            Interview Prep
          </Link>
        </div>
      </nav>
    </aside>
  )
}
