import { useState, useEffect } from 'react'
import { fetchNote, saveNote } from '../store/curriculumStore'

export default function Notes({ lessonSlug }) {
  const [content, setContent] = useState('')
  const [status, setStatus] = useState('idle') // idle | dirty | saving | saved

  useEffect(() => {
    setContent('')
    setStatus('idle')
    fetchNote(lessonSlug).then(d => setContent(d.content)).catch(() => {})
  }, [lessonSlug])

  useEffect(() => {
    if (status !== 'dirty') return
    const timer = setTimeout(() => {
      setStatus('saving')
      saveNote(lessonSlug, content)
        .then(() => setStatus('saved'))
        .catch(() => setStatus('idle'))
    }, 800)
    return () => clearTimeout(timer)
  }, [content, status, lessonSlug])

  const handleChange = (e) => {
    setContent(e.target.value)
    setStatus('dirty')
  }

  return (
    <div className="flex flex-col h-full">
      <textarea
        value={content}
        onChange={handleChange}
        placeholder="Your notes for this lesson…"
        className="flex-1 resize-none px-4 py-4 text-sm text-gray-800 dark:text-gray-100 bg-transparent placeholder-gray-400 dark:placeholder-gray-500 outline-none font-mono leading-relaxed"
      />
      <div className="shrink-0 px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-right text-gray-400 dark:text-gray-500 h-8">
        {status === 'saving' && 'Saving…'}
        {status === 'saved' && '✓ Saved'}
      </div>
    </div>
  )
}
