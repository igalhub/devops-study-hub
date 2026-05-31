import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const API = 'http://localhost:8000'

export default function Reference() {
  const { moduleSlug } = useParams()
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    setLoading(true)
    setNotFound(false)
    fetch(`${API}/reference/${moduleSlug}`)
      .then(r => { if (r.status === 404) { setNotFound(true); return null } return r.json() })
      .then(d => { if (d) setContent(d.content) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [moduleSlug])

  if (loading) return (
    <div className="p-6 max-w-4xl animate-pulse">
      <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded mb-6" />
      <div className="h-7 w-48 bg-gray-200 dark:bg-gray-700 rounded mb-8" />
      {[32, 28, 36, 24].map((w, i) => (
        <div key={i}>
          <div className={`h-3 w-${w} bg-gray-200 dark:bg-gray-700 rounded mb-3 mt-${i > 0 ? 8 : 0}`} />
          <div className="space-y-2">
            {[1, 2, 3, 4].map(j => (
              <div key={j} className="flex gap-4">
                <div className="h-4 w-28 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-4 flex-1 bg-gray-200 dark:bg-gray-700 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="h-24 bg-gray-200 dark:bg-gray-700 rounded-lg mt-8" />
    </div>
  )

  if (notFound) return (
    <div className="p-6 max-w-2xl">
      <Link to={`/module/${moduleSlug}`} className="text-xs text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 mb-4 inline-block">
        ← Back to module
      </Link>
      <p className="text-sm text-gray-500 dark:text-gray-400">No reference card available for this module yet.</p>
    </div>
  )

  return (
    <div className="p-6 max-w-4xl">
      <Link to={`/module/${moduleSlug}`} className="text-xs text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 mb-4 inline-block transition-colors">
        ← Back to module
      </Link>
      <div className="prose prose-sm dark:prose-invert max-w-none
        prose-h1:text-lg prose-h1:font-semibold prose-h1:text-gray-800 dark:prose-h1:text-gray-100 prose-h1:mb-6
        prose-h2:text-sm prose-h2:font-semibold prose-h2:text-gray-700 dark:prose-h2:text-gray-300 prose-h2:mt-8 prose-h2:mb-2 prose-h2:uppercase prose-h2:tracking-wider
        prose-table:text-xs prose-table:w-full
        prose-thead:border-b prose-thead:border-gray-200 dark:prose-thead:border-gray-700
        prose-th:text-left prose-th:px-3 prose-th:py-2 prose-th:text-gray-400 dark:prose-th:text-gray-500 prose-th:font-medium prose-th:text-[10px] prose-th:uppercase prose-th:tracking-wider
        prose-td:px-3 prose-td:py-2 prose-td:border-b prose-td:border-gray-100 dark:prose-td:border-gray-800
        prose-tr:hover:bg-gray-50 dark:prose-tr:hover:bg-gray-800/40
        prose-code:text-emerald-600 dark:prose-code:text-emerald-400 prose-code:bg-gray-100 dark:prose-code:bg-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px] prose-code:before:content-none prose-code:after:content-none
        prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:text-xs prose-pre:rounded-lg prose-pre:border prose-pre:border-gray-700">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  )
}
