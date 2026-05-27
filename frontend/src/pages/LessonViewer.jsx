import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { fetchLesson, markLessonComplete, resetLessonProgress, addRecentLesson, addBookmark, removeBookmark, isBookmarked } from '../store/curriculumStore'
import CodePlayground from '../components/CodePlayground'

const slugify = (text) =>
  text.toLowerCase().trim().replace(/[`*_[\]#]/g, '').replace(/\s+/g, '-').replace(/[^\w-]/g, '')

function extractHeadings(content) {
  if (!content) return []
  return content.split('\n').reduce((acc, line) => {
    const m = line.match(/^## (.+)/)
    if (m) acc.push({ text: m[1].trim(), id: slugify(m[1].trim()) })
    return acc
  }, [])
}

const DIFFICULTY_COLOR = {
  beginner: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  intermediate: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  advanced: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

const toId = (children) => {
  const text = Array.isArray(children)
    ? children.map(c => (typeof c === 'string' ? c : c?.props?.children || '')).join('')
    : String(children || '')
  return slugify(text)
}

const mdComponents = {
  h2({ children }) { return <h2 id={toId(children)}>{children}</h2> },
  pre({ children }) {
    return <>{children}</>
  },
  code({ children, className, node, ...rest }) {
    const match = /language-(\w+)/.exec(className || '')
    if (match) {
      return (
        <SyntaxHighlighter language={match[1]} style={oneDark} PreTag="div" customStyle={{ overflowX: 'auto' }}>
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      )
    }
    return (
      <code
        className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-sm font-mono text-gray-800 dark:text-gray-200"
        {...rest}
      >
        {children}
      </code>
    )
  },
}

export default function LessonViewer({ modules, progress, onProgressUpdate }) {
  const { moduleSlug, lessonSlug } = useParams()
  const navigate = useNavigate()

  const mod = modules?.find(m => m.slug === moduleSlug)
  const lessons = mod?.lessons || []
  const currentIdx = lessons.findIndex(l => l.slug === lessonSlug)
  const prevLesson = currentIdx > 0 ? lessons[currentIdx - 1] : null
  const nextLesson = currentIdx < lessons.length - 1 ? lessons[currentIdx + 1] : null
  const [lesson, setLesson] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeExercise, setActiveExercise] = useState(null)
  const [bookmarked, setBookmarked] = useState(false)
  const [moduleBanner, setModuleBanner] = useState(false)
  const currentSlugRef = useRef(lessonSlug)
  useLayoutEffect(() => { currentSlugRef.current = lessonSlug }, [lessonSlug])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setActiveExercise(null)
    setModuleBanner(false)
    setBookmarked(isBookmarked(lessonSlug))
    fetchLesson(lessonSlug)
      .then(data => {
        if (cancelled) return
        setLesson(data)
        addRecentLesson({
          moduleSlug,
          moduleTitle: data.module_title,
          lessonSlug,
          lessonTitle: data.title,
        })
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [lessonSlug])

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === ']' && nextLesson) navigate(`/module/${moduleSlug}/lesson/${nextLesson.slug}`)
      if (e.key === '[' && prevLesson) navigate(`/module/${moduleSlug}/lesson/${prevLesson.slug}`)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [nextLesson, prevLesson, moduleSlug, navigate])

  const YAML_MODULES = new Set(['kubernetes', 'ansible', 'terraform', 'helm', 'cicd', 'gcp', 'aws'])
  const exerciseLang = lesson?.module_slug === 'python' ? 'python'
    : YAML_MODULES.has(lesson?.module_slug) ? 'yaml'
    : 'bash'

  const makeStarter = (text, lang) => {
    if (lang === 'yaml') return `# ${text}\n---\n`
    const shebang = lang === 'python' ? '#!/usr/bin/env python3\n' : '#!/bin/bash\n'
    return `${shebang}# ${text}\n\n`
  }

  const toggleExercise = (idx) => setActiveExercise(prev => prev === idx ? null : idx)

  if (loading) return <div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>
  if (error || !lesson) {
    const notFound = !error || error.includes('404')
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <Link
          to={`/module/${moduleSlug}`}
          className="text-sm text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
        >
          ← Back to module
        </Link>
        <p className="mt-4 text-sm text-red-500">
          {notFound ? 'Lesson not found.' : `Error: ${error}`}
        </p>
      </div>
    )
  }

  const done = progress[String(lesson.id)] === 'complete'
  const headings = extractHeadings(lesson.content)

  const toggleBookmark = () => {
    if (bookmarked) {
      removeBookmark(lessonSlug)
      setBookmarked(false)
    } else {
      addBookmark({ moduleSlug, moduleTitle: lesson.module_title, lessonSlug, lessonTitle: lesson.title })
      setBookmarked(true)
    }
  }

  const handleComplete = async () => {
    const slug = lessonSlug
    try {
      const result = await markLessonComplete(lesson.id)
      onProgressUpdate()
      if (currentSlugRef.current === slug && result.module_completed) setModuleBanner(true)
    } catch (e) {
      console.error('Failed to mark lesson complete:', e)
    }
  }

  const handleReset = async () => {
    try {
      await resetLessonProgress(lesson.id)
      onProgressUpdate()
    } catch (e) {
      console.error('Failed to reset lesson:', e)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <div className="mb-4">
        <Link
          to={`/module/${moduleSlug}`}
          className="text-sm text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
        >
          ← {lesson.module_title}
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {lesson.title}
        </h1>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${DIFFICULTY_COLOR[lesson.difficulty] ?? DIFFICULTY_COLOR.beginner}`}>
            {lesson.difficulty}
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500">{lesson.duration_min} min</span>
          {done && <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">✓ Complete</span>}
          <button
            onClick={toggleBookmark}
            title={bookmarked ? 'Remove bookmark' : 'Bookmark this lesson'}
            className={`ml-auto text-base leading-none transition-colors ${bookmarked ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600 hover:text-amber-400 dark:hover:text-amber-400'}`}
          >
            {bookmarked ? '★' : '☆'}
          </button>
        </div>
      </div>

      {headings.length >= 3 && (
        <nav className="mb-6 px-4 py-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2">Contents</div>
          <ol className="space-y-1">
            {headings.map((h, i) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                >
                  {i + 1}. {h.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {lesson.content ? (
        <div className="prose prose-gray dark:prose-invert max-w-none
          prose-headings:font-semibold
          prose-code:before:content-none prose-code:after:content-none
          prose-table:text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {lesson.content}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-sm text-gray-400 dark:text-gray-500">
          Content for this lesson is coming soon.
        </div>
      )}

      {lesson.exercises?.length > 0 ? (
        <div className="mt-10">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-4">Exercises</h2>
          <div className="space-y-3">
            {lesson.exercises.map((ex, i) => (
              <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="flex items-start justify-between gap-4 px-4 py-3 bg-white dark:bg-gray-800">
                  <div className="flex gap-3 min-w-0">
                    <span className="shrink-0 text-sm font-medium text-emerald-600 dark:text-emerald-400 mt-0.5">
                      {i + 1}.
                    </span>
                    <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{ex}</p>
                  </div>
                  <button
                    onClick={() => toggleExercise(i)}
                    className={`shrink-0 text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
                      activeExercise === i
                        ? 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700'
                    }`}
                  >
                    {activeExercise === i ? 'Close' : '▶ Try it'}
                  </button>
                </div>
                {activeExercise === i && (
                  <CodePlayground
                    key={i}
                    initialLanguage={exerciseLang}
                    initialCode={makeStarter(ex, exerciseLang)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <CodePlayground key={lessonSlug} />
      )}

      <div className="mt-10 pt-6 border-t border-gray-200 dark:border-gray-700 space-y-4">
        {moduleBanner && (
          <div className="flex items-start justify-between gap-4 px-4 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-950 border border-emerald-300 dark:border-emerald-800">
            <div>
              <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Module complete!</div>
              <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">+50 XP module bonus earned.</div>
            </div>
            <button
              onClick={() => setModuleBanner(false)}
              className="text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 text-sm leading-none"
            >
              ✕
            </button>
          </div>
        )}
        {done ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">✓ Lesson complete</span>
            <button
              onClick={handleReset}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              Reset
            </button>
          </div>
        ) : (
          <button
            onClick={handleComplete}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Mark as complete
          </button>
        )}

        <div className="flex items-center justify-between pt-2">
          {prevLesson ? (
            <Link
              to={`/module/${moduleSlug}/lesson/${prevLesson.slug}`}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
            >
              ← {prevLesson.title}
            </Link>
          ) : <div />}
          {nextLesson ? (
            <Link
              to={`/module/${moduleSlug}/lesson/${nextLesson.slug}`}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
            >
              {nextLesson.title} →
            </Link>
          ) : <div />}
        </div>
      </div>
    </div>
  )
}
