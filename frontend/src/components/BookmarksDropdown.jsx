import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { getBookmarks } from '../store/curriculumStore'

export default function BookmarksDropdown() {
  const [open, setOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState(() => getBookmarks())
  const ref = useRef(null)

  useEffect(() => {
    const handler = () => setBookmarks(getBookmarks())
    window.addEventListener('bookmark-updated', handler)
    return () => window.removeEventListener('bookmark-updated', handler)
  }, [])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (bookmarks.length === 0) return null

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs transition-colors ${
          open
            ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
            : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400'
        }`}
      >
        Saved
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 w-64 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-40 overflow-hidden">
          {bookmarks.map(r => (
            <Link
              key={r.lessonSlug}
              to={`/module/${r.moduleSlug}/lesson/${r.lessonSlug}`}
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
            >
              <div className="text-[10px] text-gray-400 dark:text-gray-500 truncate">{r.moduleTitle}</div>
              <div className="text-sm text-gray-800 dark:text-gray-100 truncate">{r.lessonTitle}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
