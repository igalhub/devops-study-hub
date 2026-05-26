import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ThemeToggle from './components/ThemeToggle'
import Roadmap from './pages/Roadmap'
import ModuleView from './pages/ModuleView'
import LessonViewer from './pages/LessonViewer'
import { useTheme } from './store/themeStore'
import { fetchModules, fetchProgress } from './store/curriculumStore'

export default function App() {
  const { dark, toggle } = useTheme()
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

  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900 text-gray-500">
      Loading...
    </div>
  )

  return (
    <BrowserRouter>
      <div className={dark ? 'dark' : ''}>
        <div className="flex min-h-screen bg-white dark:bg-gray-900">
          <Sidebar modules={modules} progress={progress} />
          <div className="flex-1 flex flex-col min-w-0">
            <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="text-xs text-gray-400 dark:text-gray-500">DevOps Study Hub</div>
              <ThemeToggle dark={dark} toggle={toggle} />
            </header>
            <main className="flex-1 overflow-y-auto">
              <Routes>
                <Route path="/" element={<Navigate to="/roadmap" replace />} />
                <Route path="/roadmap" element={<Roadmap modules={modules} progress={progress} />} />
                <Route path="/module/:moduleSlug" element={
                  <ModuleView modules={modules} progress={progress} onProgressUpdate={loadData} />
                } />
                <Route path="/module/:moduleSlug/lesson/:lessonSlug" element={
                  <LessonViewer progress={progress} onProgressUpdate={loadData} />
                } />
              </Routes>
            </main>
          </div>
        </div>
      </div>
    </BrowserRouter>
  )
}
