import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

export default function SearchModal({ modules, onClose }) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()

  const items = modules.flatMap(m =>
    (m.lessons || []).map(l => ({
      moduleSlug: m.slug,
      moduleTitle: m.title,
      lessonSlug: l.slug,
      lessonTitle: l.title,
    }))
  )

  const q = query.trim().toLowerCase()
  const results = q
    ? items.filter(item =>
        item.lessonTitle.toLowerCase().includes(q) ||
        item.moduleTitle.toLowerCase().includes(q)
      ).slice(0, 10)
    : []

  useEffect(() => { setActiveIdx(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])

  const go = (item) => {
    navigate(`/module/${item.moduleSlug}/lesson/${item.lessonSlug}`)
    onClose()
  }

  const handleKey = (e) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && results[activeIdx]) go(results[activeIdx])
  }

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
            placeholder="Search lessons…"
            className="flex-1 py-3 text-sm bg-transparent text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 outline-none"
          />
          <kbd className="text-[10px] text-gray-400 dark:text-gray-500 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700">Esc</kbd>
        </div>

        {results.length > 0 && (
          <ul className="max-h-72 overflow-y-auto py-1">
            {results.map((item, i) => (
              <li key={`${item.moduleSlug}/${item.lessonSlug}`}>
                <button
                  onClick={() => go(item)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    i === activeIdx
                      ? 'bg-emerald-50 dark:bg-emerald-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <span className="text-xs text-gray-400 dark:text-gray-500">{item.moduleTitle} › </span>
                  <span className="text-sm text-gray-800 dark:text-gray-100">{item.lessonTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {q && results.length === 0 && (
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
