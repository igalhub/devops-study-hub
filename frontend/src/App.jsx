import { BrowserRouter, Routes, Route, Navigate, useMatch } from 'react-router-dom'
import { useState, useEffect, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import SearchModal from './components/SearchModal'
import ThemeToggle from './components/ThemeToggle'
import RecentDropdown from './components/RecentDropdown'
import AiTutor from './components/AiTutor'
import Quiz from './components/Quiz'
import Notes from './components/Notes'
import Roadmap from './pages/Roadmap'
import ModuleView from './pages/ModuleView'
import ModuleQuiz from './pages/ModuleQuiz'
import InterviewPrep from './pages/InterviewPrep'
import Review from './pages/Review'
import { useTheme } from './store/themeStore'
import { fetchModules, fetchProgress, fetchXp, fetchStreak, fetchReviewQueue } from './store/curriculumStore'

const LessonViewer = lazy(() => import('./pages/LessonViewer'))

function AppLayout({ modules, progress, loadData, loading, xp, streak, reviewDue, onXpEarned }) {
  const { dark, toggle } = useTheme()
  const lessonMatch = useMatch('/module/:moduleSlug/lesson/:lessonSlug')
  const [rightTab, setRightTab] = useState('tutor')
  const [searchOpen, setSearchOpen] = useState(false)

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
      <div className="flex items-center justify-center h-screen bg-stone-100 dark:bg-gray-900 text-gray-500">
        Loading…
      </div>
    </div>
  )

  return (
    <div className={dark ? 'dark' : ''}>
      {searchOpen && <SearchModal modules={modules} progress={progress} onClose={() => setSearchOpen(false)} />}
      <div className="flex h-screen overflow-hidden bg-stone-100 dark:bg-gray-900">
        <Sidebar modules={modules} progress={progress} reviewDue={reviewDue} />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <div className="text-xs text-gray-600 dark:text-gray-500">DevOps Study Hub</div>
              <button
                onClick={() => setSearchOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-xs text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
              >
                <span>⌕</span>
                <span>Search</span>
              </button>
              <RecentDropdown />
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
            </div>
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
                <Route path="/module/:moduleSlug/quiz" element={
                  <ModuleQuiz modules={modules} />
                } />
                <Route path="/interview" element={<InterviewPrep modules={modules} progress={progress} />} />
                <Route path="/interview/:moduleSlug" element={<InterviewPrep modules={modules} progress={progress} />} />
                <Route path="/review" element={<Review onXpEarned={onXpEarned} onComplete={loadData} />} />
                <Route path="/module/:moduleSlug/lesson/:lessonSlug" element={
                  <Suspense fallback={<div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>}>
                    <LessonViewer modules={modules} progress={progress} onProgressUpdate={loadData} />
                  </Suspense>
                } />
              </Routes>
            </main>
            {lessonMatch && (
              <aside className="w-[440px] shrink-0 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-stone-200 dark:bg-gray-900">
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
                {rightTab === 'tutor'
                  ? <AiTutor lessonSlug={lessonMatch.params.lessonSlug} />
                  : rightTab === 'quiz'
                  ? <Quiz lessonSlug={lessonMatch.params.lessonSlug} onXpEarned={onXpEarned} />
                  : <Notes lessonSlug={lessonMatch.params.lessonSlug} />
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
  const [streak, setStreak] = useState({ current: 0, longest: 0, today_done: false })
  const [reviewDue, setReviewDue] = useState(0)

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
        streak={streak}
        reviewDue={reviewDue}
        onXpEarned={handleXpEarned}
      />
    </BrowserRouter>
  )
}
