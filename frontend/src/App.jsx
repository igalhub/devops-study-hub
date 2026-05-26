import { BrowserRouter, Routes, Route, Navigate, useMatch } from 'react-router-dom'
import { useState, useEffect, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import ThemeToggle from './components/ThemeToggle'
import AiTutor from './components/AiTutor'
import Quiz from './components/Quiz'
import Roadmap from './pages/Roadmap'
import ModuleView from './pages/ModuleView'
import { useTheme } from './store/themeStore'
import { fetchModules, fetchProgress, fetchXp } from './store/curriculumStore'

const LessonViewer = lazy(() => import('./pages/LessonViewer'))

function AppLayout({ modules, progress, loadData, loading, xp, onXpEarned }) {
  const { dark, toggle } = useTheme()
  const lessonMatch = useMatch('/module/:moduleSlug/lesson/:lessonSlug')
  const [rightTab, setRightTab] = useState('tutor')

  if (loading) return (
    <div className={dark ? 'dark' : ''}>
      <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900 text-gray-500">
        Loading…
      </div>
    </div>
  )

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="flex h-screen overflow-hidden bg-white dark:bg-gray-900">
        <Sidebar modules={modules} progress={progress} />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-700">
            <div className="text-xs text-gray-400 dark:text-gray-500">DevOps Study Hub</div>
            {xp > 0 && (
              <div className="text-xs font-medium text-amber-600 dark:text-amber-400">⚡ {xp} XP</div>
            )}
            <ThemeToggle dark={dark} toggle={toggle} />
          </header>
          <div className="flex-1 flex overflow-hidden">
            <main className="flex-1 overflow-y-auto">
              <Routes>
                <Route path="/" element={<Navigate to="/roadmap" replace />} />
                <Route path="/roadmap" element={<Roadmap modules={modules} progress={progress} />} />
                <Route path="/module/:moduleSlug" element={
                  <ModuleView modules={modules} progress={progress} onProgressUpdate={loadData} />
                } />
                <Route path="/module/:moduleSlug/lesson/:lessonSlug" element={
                  <Suspense fallback={<div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>}>
                    <LessonViewer modules={modules} progress={progress} onProgressUpdate={loadData} />
                  </Suspense>
                } />
              </Routes>
            </main>
            {lessonMatch && (
              <aside className="w-[280px] shrink-0 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-gray-50 dark:bg-gray-900">
                <div className="flex shrink-0 border-b border-gray-200 dark:border-gray-700">
                  {['tutor', 'quiz'].map(tab => (
                    <button
                      key={tab}
                      onClick={() => setRightTab(tab)}
                      className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                        rightTab === tab
                          ? 'text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-600 dark:border-emerald-400'
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                      }`}
                    >
                      {tab === 'tutor' ? 'Tutor' : 'Quiz'}
                    </button>
                  ))}
                </div>
                {rightTab === 'tutor'
                  ? <AiTutor lessonSlug={lessonMatch.params.lessonSlug} />
                  : <Quiz lessonSlug={lessonMatch.params.lessonSlug} onXpEarned={onXpEarned} />
                }
              </aside>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [modules, setModules] = useState([])
  const [progress, setProgress] = useState({})
  const [loading, setLoading] = useState(true)
  const [xp, setXp] = useState(0)

  const loadData = async () => {
    try {
      const [mods, prog, xpData] = await Promise.all([fetchModules(), fetchProgress(), fetchXp()])
      setModules(mods)
      setProgress(prog)
      setXp(xpData.xp_total)
    } catch (e) {
      console.error('Failed to load data:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleXpEarned = (total) => setXp(total)

  useEffect(() => { loadData() }, [])

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppLayout
        modules={modules}
        progress={progress}
        loadData={loadData}
        loading={loading}
        xp={xp}
        onXpEarned={handleXpEarned}
      />
    </BrowserRouter>
  )
}
