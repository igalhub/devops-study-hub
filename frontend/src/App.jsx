import { BrowserRouter, Routes, Route, Navigate, useMatch } from 'react-router-dom'
import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import SearchModal from './components/SearchModal'
import ThemeToggle from './components/ThemeToggle'
import RecentDropdown from './components/RecentDropdown'
import BookmarksDropdown from './components/BookmarksDropdown'
import AiTutor from './components/AiTutor'
import Quiz from './components/Quiz'
import Notes from './components/Notes'
import Roadmap from './pages/Roadmap'
import ModuleView from './pages/ModuleView'
import ModuleQuiz from './pages/ModuleQuiz'
import InterviewPrep from './pages/InterviewPrep'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Review from './pages/Review'
import Drill from './pages/Drill'
import Stats from './pages/Stats'
import Reference from './pages/Reference'
import { useTheme } from './store/themeStore'
import { fetchModules, fetchProgress, fetchXp, fetchStreak, fetchReviewQueue, fetchInterviewReviewQueue, fetchReadiness, fetchExerciseDue } from './store/curriculumStore'

const LessonViewer = lazy(() => import('./pages/LessonViewer'))

function AppLayout({ modules, progress, loadData, loading, xp, streak, reviewDue, exerciseDue, interviewDue, interviewQueue, readiness, onXpEarned, onInterviewDueChange }) {
  const { dark, toggle } = useTheme()
  const lessonMatch = useMatch('/module/:moduleSlug/lesson/:lessonSlug')
  const [rightTab, setRightTab] = useState('tutor')
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [readingMode, setReadingMode] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const s = localStorage.getItem('sidebar-width'); return s ? Math.max(150, Math.min(400, Number(s))) : 220
  })
  const [rightWidth, setRightWidth] = useState(() => {
    const s = localStorage.getItem('right-panel-width'); return s ? Math.max(280, Math.min(700, Number(s))) : 440
  })
  const [resizing, setResizing] = useState(false)

  useEffect(() => { if (!lessonMatch) setReadingMode(false) }, [lessonMatch])

  const startSidebarResize = useCallback((e) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX, startW = sidebarWidth
    const onMove = (ev) => { const w = Math.max(150, Math.min(400, startW + ev.clientX - startX)); setSidebarWidth(w); localStorage.setItem('sidebar-width', w) }
    const onUp = () => { setResizing(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const startRightResize = useCallback((e) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX, startW = rightWidth
    const onMove = (ev) => { const w = Math.max(280, Math.min(700, startW - ev.clientX + startX)); setRightWidth(w); localStorage.setItem('right-panel-width', w) }
    const onUp = () => { setResizing(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [rightWidth])

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (loading) return (
    <div className={dark ? 'dark' : ''}>
      <div className="flex h-screen overflow-hidden bg-stone-100 dark:bg-gray-900 animate-pulse">
        <div className="w-[220px] shrink-0 bg-stone-200 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col p-4">
          <div className="h-5 w-28 bg-gray-300 dark:bg-gray-700 rounded mb-3" />
          <div className="h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mb-2" />
          <div className="h-3 w-16 bg-gray-300 dark:bg-gray-700 rounded mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-7 bg-gray-300 dark:bg-gray-700 rounded-md" />
            ))}
          </div>
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          <div className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-gray-200 dark:border-gray-700">
            <div className="h-4 w-4 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-4 w-32 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-6 w-24 bg-gray-200 dark:bg-gray-700 rounded-full" />
          </div>
          <div className="flex-1 p-6 overflow-hidden">
            <div className="max-w-4xl mx-auto">
              <div className="h-7 w-32 bg-gray-200 dark:bg-gray-700 rounded mb-6" />
              {[5, 5, 3, 2, 3].map((count, gi) => (
                <div key={gi} className="mb-8">
                  <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
                  <div className="grid grid-cols-3 gap-3">
                    {Array.from({ length: count }).map((_, i) => (
                      <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
                        <div className="h-4 w-3/4 bg-gray-200 dark:bg-gray-700 rounded mb-2" />
                        <div className="h-3 w-16 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
                        <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className={dark ? 'dark' : ''}>
      {searchOpen && <SearchModal modules={modules} progress={progress} onClose={() => setSearchOpen(false)} />}
      <div className={`flex h-screen overflow-hidden bg-stone-100 dark:bg-gray-900 ${resizing ? 'select-none' : ''}`}>
        <div className={`shrink-0 overflow-hidden ${resizing ? '' : 'transition-[width] duration-200'}`} style={{ width: sidebarOpen ? sidebarWidth : 0 }}>
          <Sidebar modules={modules} progress={progress} reviewDue={reviewDue} exerciseDue={exerciseDue} interviewDue={interviewDue} />
        </div>
        {sidebarOpen && (
          <div onMouseDown={startSidebarResize} className="w-1 shrink-0 cursor-col-resize hover:bg-emerald-400 dark:hover:bg-emerald-600 bg-transparent transition-colors" title="Drag to resize sidebar" />
        )}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(o => !o)}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors text-base leading-none"
                title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              >
                ☰
              </button>
              <div className="text-xs text-gray-600 dark:text-gray-500">DevOps Study Hub</div>
              <button
                onClick={() => setSearchOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-xs text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
              >
                <span>⌕</span>
                <span>Search</span>
                <span className="text-gray-400 dark:text-gray-600 text-[10px]">Ctrl K</span>
              </button>
              <RecentDropdown />
              <BookmarksDropdown />
            </div>
            <div className="flex items-center gap-3">
              {streak.current > 0 && (
                <div className={`text-xs font-medium ${streak.today_done ? 'text-orange-500 dark:text-orange-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  🔥 {streak.current}
                </div>
              )}
              {xp > 0 && (
                <div className="text-xs font-medium text-amber-600 dark:text-amber-400">⚡ {xp} XP</div>
              )}
              {lessonMatch && (
                <button
                  onClick={() => setReadingMode(r => !r)}
                  className="text-xs px-3 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                >
                  {readingMode ? 'Side panel' : 'Focus'}
                </button>
              )}
              <ThemeToggle dark={dark} toggle={toggle} />
            </div>
          </header>
          <div className="flex-1 flex overflow-hidden">
            <main className="flex-1 overflow-y-auto">
              <Routes>
                <Route path="/" element={<Navigate to="/roadmap" replace />} />
                <Route path="/roadmap" element={<Roadmap modules={modules} progress={progress} readiness={readiness} />} />
                <Route path="/module/:moduleSlug" element={
                  <ModuleView modules={modules} progress={progress} onProgressUpdate={loadData} readiness={readiness} />
                } />
                <Route path="/module/:moduleSlug/quiz" element={
                  <ModuleQuiz modules={modules} />
                } />
                <Route path="/projects" element={<Projects />} />
                <Route path="/projects/:projectSlug" element={<ProjectDetail onXpEarned={onXpEarned} />} />
                <Route path="/interview" element={<InterviewPrep modules={modules} onXpEarned={onXpEarned} onInterviewDueChange={onInterviewDueChange} interviewQueue={interviewQueue} />} />
                <Route path="/interview/:moduleSlug" element={<InterviewPrep modules={modules} onXpEarned={onXpEarned} onInterviewDueChange={onInterviewDueChange} interviewQueue={interviewQueue} />} />
                <Route path="/review" element={<Review onXpEarned={onXpEarned} onComplete={loadData} />} />
                <Route path="/drill" element={<Drill onXpEarned={onXpEarned} />} />
                <Route path="/stats" element={<Stats />} />
                <Route path="/reference/:moduleSlug" element={<Reference />} />
                <Route path="/module/:moduleSlug/lesson/:lessonSlug" element={
                  <Suspense fallback={<div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>}>
                    <LessonViewer modules={modules} progress={progress} onProgressUpdate={loadData} />
                  </Suspense>
                } />
              </Routes>
            </main>
            {lessonMatch && !readingMode && (
              <>
              <div onMouseDown={startRightResize} className="w-1 shrink-0 cursor-col-resize hover:bg-emerald-400 dark:hover:bg-emerald-600 bg-transparent transition-colors" title="Drag to resize panel" />
              <aside className="shrink-0 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-stone-200 dark:bg-gray-900" style={{ width: rightWidth }}>
                <div className="flex shrink-0 border-b border-gray-200 dark:border-gray-700">
                  {['tutor', 'quiz', 'notes'].map(tab => (
                    <button
                      key={tab}
                      onClick={() => setRightTab(tab)}
                      className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                        rightTab === tab
                          ? 'text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-600 dark:border-emerald-400'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                      }`}
                    >
                      {tab === 'tutor' ? 'Tutor' : tab === 'quiz' ? 'Quiz' : 'Notes'}
                    </button>
                  ))}
                </div>
                <div className={`${rightTab === 'tutor' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0`}>
                  <AiTutor lessonSlug={lessonMatch.params.lessonSlug} />
                </div>
                <div className={`${rightTab === 'quiz' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0`}>
                  <Quiz lessonSlug={lessonMatch.params.lessonSlug} onXpEarned={onXpEarned} />
                </div>
                <div className={`${rightTab === 'notes' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0`}>
                  <Notes lessonSlug={lessonMatch.params.lessonSlug} />
                </div>
              </aside>
              </>
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
  const [streak, setStreak] = useState({ current: 0, longest: 0, today_done: false })
  const [reviewDue, setReviewDue] = useState(0)
  const [exerciseDue, setExerciseDue] = useState(0)
  const [interviewDue, setInterviewDue] = useState(0)
  const [interviewQueue, setInterviewQueue] = useState(null)
  const [readiness, setReadiness] = useState({})

  const loadData = async () => {
    try {
      const [mods, prog, xpData, streakData, reviewQueue] = await Promise.all([
        fetchModules(), fetchProgress(), fetchXp(), fetchStreak(), fetchReviewQueue()
      ])
      setModules(mods)
      setProgress(prog)
      setXp(xpData.xp_total)
      setStreak({ current: streakData.current_streak, longest: streakData.longest_streak, today_done: streakData.today_done })
      setReviewDue(reviewQueue.length)
    } catch (e) {
      console.error('Failed to load data:', e)
    } finally {
      setLoading(false)
    }
    // Fetched separately so a failure here does not blank the whole app
    fetchInterviewReviewQueue().then(q => { setInterviewDue(q.length); setInterviewQueue(q) }).catch(() => { setInterviewQueue([]) })
    fetchExerciseDue().then(d => setExerciseDue(d.due_count)).catch(() => {})
    fetchReadiness().then(list => {
      const dict = {}
      list.forEach(r => { dict[r.module_slug] = r })
      setReadiness(dict)
    }).catch(() => {})
  }

  const handleXpEarned = (total) => setXp(total)
  const handleInterviewDueChange = (count) => setInterviewDue(count)

  useEffect(() => { loadData() }, [])

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppLayout
        modules={modules}
        progress={progress}
        loadData={loadData}
        loading={loading}
        xp={xp}
        streak={streak}
        reviewDue={reviewDue}
        exerciseDue={exerciseDue}
        interviewDue={interviewDue}
        interviewQueue={interviewQueue}
        readiness={readiness}
        onXpEarned={handleXpEarned}
        onInterviewDueChange={handleInterviewDueChange}
      />
    </BrowserRouter>
  )
}
