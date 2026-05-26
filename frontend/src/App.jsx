import { BrowserRouter, Routes, Route, Navigate, useMatch } from 'react-router-dom'
import { useState, useEffect, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import ThemeToggle from './components/ThemeToggle'
import AiTutor from './components/AiTutor'
import Roadmap from './pages/Roadmap'
import ModuleView from './pages/ModuleView'
import { useTheme } from './store/themeStore'
import { fetchModules, fetchProgress } from './store/curriculumStore'

const LessonViewer = lazy(() => import('./pages/LessonViewer'))

function AppLayout({ modules, progress, loadData, loading }) {
  const { dark, toggle } = useTheme()
  const lessonMatch = useMatch('/module/:moduleSlug/lesson/:lessonSlug')

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
              <AiTutor lessonSlug={lessonMatch.params.lessonSlug} />
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

  const loadData = async () => {
    try {
      const [mods, prog] = await Promise.all([fetchModules(), fetchProgress()])
      setModules(mods)
      setProgress(prog)
    } catch (e) {
      console.error('Failed to load data:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppLayout modules={modules} progress={progress} loadData={loadData} loading={loading} />
    </BrowserRouter>
  )
}
