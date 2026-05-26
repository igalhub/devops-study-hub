import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { fetchLesson, markLessonComplete } from '../store/curriculumStore'
import CodePlayground from '../components/CodePlayground'

const DIFFICULTY_COLOR = {
  beginner: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  intermediate: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  advanced: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

const mdComponents = {
  pre({ children }) {
    return <>{children}</>
  },
  code({ children, className, node, ...rest }) {
    const match = /language-(\w+)/.exec(className || '')
    if (match) {
      return (
        <SyntaxHighlighter language={match[1]} style={oneDark} PreTag="div">
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

  const mod = modules?.find(m => m.slug === moduleSlug)
  const lessons = mod?.lessons || []
  const currentIdx = lessons.findIndex(l => l.slug === lessonSlug)
  const prevLesson = currentIdx > 0 ? lessons[currentIdx - 1] : null
  const nextLesson = currentIdx < lessons.length - 1 ? lessons[currentIdx + 1] : null
  const [lesson, setLesson] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchLesson(lessonSlug)
      .then(setLesson)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [lessonSlug])

  if (loading) return <div className="p-6 text-gray-400 dark:text-gray-500">Loading…</div>
  if (error) return <div className="p-6 text-red-500">Error: {error}</div>
  if (!lesson) return null

  const done = progress[String(lesson.id)] === 'complete'

  const handleComplete = async () => {
    await markLessonComplete(lesson.id)
    onProgressUpdate()
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
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
        </div>
      </div>

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

      <CodePlayground key={lessonSlug} />

      <div className="mt-10 pt-6 border-t border-gray-200 dark:border-gray-700 space-y-4">
        {done ? (
          <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">✓ Lesson complete</span>
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
