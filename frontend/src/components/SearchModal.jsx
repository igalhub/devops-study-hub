import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchContent } from '../store/curriculumStore'

export default function SearchModal({ modules, progress = {}, onClose }) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [contentResults, setContentResults] = useState([])
  const [contentLoading, setContentLoading] = useState(false)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)
  const navigate = useNavigate()

  const items = modules.flatMap(m =>
    (m.lessons || []).map(l => ({
      moduleSlug: m.slug,
      moduleTitle: m.title,
      lessonSlug: l.slug,
      lessonTitle: l.title,
      done: progress[String(l.id)] === 'complete',
    }))
  )

  const q = query.trim().toLowerCase()
  const titleResults = q
    ? items.filter(item =>
        item.lessonTitle.toLowerCase().includes(q) ||
        item.moduleTitle.toLowerCase().includes(q)
      ).slice(0, 5)
    : []

  // content search — debounced backend call
  useEffect(() => {
    if (q.length < 2) { setContentResults([]); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setContentLoading(true)
      searchContent(q)
        .then(data => setContentResults(data))
        .catch(() => setContentResults([]))
        .finally(() => setContentLoading(false))
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [q])

  const titleSlugs = new Set(titleResults.map(r => r.lessonSlug))
  const allResults = [
    ...titleResults.map(r => ({ ...r, type: 'title' })),
    ...contentResults
      .filter(r => !titleSlugs.has(r.lesson_slug))
      .slice(0, 5)
      .map(r => ({
        moduleSlug: r.module_slug,
        moduleTitle: r.module_title,
        lessonSlug: r.lesson_slug,
        lessonTitle: r.lesson_title,
        done: progress[String(r.lesson_id)] === 'complete',
        snippet: r.snippet,
        type: 'content',
      })),
  ]

  useEffect(() => { setActiveIdx(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])

  const go = (item) => {
    navigate(`/module/${item.moduleSlug}/lesson/${item.lessonSlug}`)
    onClose()
  }

  const handleKey = (e) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, allResults.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && allResults[activeIdx]) go(allResults[activeIdx])
  }

  const titleCount = titleResults.length
  const showContentDivider = titleCount > 0 && contentResults.length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-gray-200 dark:border-gray-700">
          <span className="text-gray-400 dark:text-gray-500 text-sm">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search lessons and content…"
            className="flex-1 py-3 text-sm bg-transparent text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 outline-none"
          />
          {contentLoading && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 animate-pulse">searching…</span>
          )}
          <kbd className="text-[10px] text-gray-400 dark:text-gray-500 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700">Esc</kbd>
        </div>

        {allResults.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-1">
            {allResults.map((item, i) => (
              <li key={`${item.moduleSlug}/${item.lessonSlug}/${item.type}`}>
                {i === titleCount && showContentDivider && (
                  <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 mt-1 pt-2">
                    In content
                  </div>
                )}
                <button
                  onClick={() => go(item)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    i === activeIdx
                      ? 'bg-emerald-50 dark:bg-emerald-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <div className="flex items-baseline gap-1">
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{item.moduleTitle} › </span>
                    <span className="text-sm text-gray-800 dark:text-gray-100">{item.lessonTitle}</span>
                    {item.done && <span className="ml-auto text-xs text-emerald-500 shrink-0">✓</span>}
                  </div>
                  {item.snippet && (
                    <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500 truncate">{item.snippet}</p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {q && allResults.length === 0 && !contentLoading && (
          <div className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">No results for "{query}"</div>
        )}

        {!q && (
          <div className="px-4 py-2.5 text-xs text-gray-400 dark:text-gray-500">
            {items.length} lessons across {modules.length} modules
          </div>
        )}
      </div>
    </div>
  )
}
