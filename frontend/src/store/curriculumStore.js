const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

async function apiFetch(path, options) {
  const res = await fetch(`${API}${path}`, options)
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
  return res.json()
}

export function fetchModules() {
  return apiFetch('/modules')
}

export function fetchProgress() {
  return apiFetch('/progress')
}

export function fetchLesson(slug) {
  return apiFetch(`/lessons/${slug}`)
}

export function markLessonComplete(lessonId) {
  return apiFetch(`/progress/${lessonId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'complete' }),
  })
}

export function resetLessonProgress(lessonId) {
  return apiFetch(`/progress/${lessonId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'not_started' }),
  })
}

export function fetchXp() {
  return apiFetch('/xp')
}

export function fetchStreak() {
  return apiFetch('/streaks')
}

export function fetchReviewQueue() {
  return apiFetch('/review/queue')
}

export function fetchQuiz(slug) {
  return apiFetch(`/quiz/${slug}`)
}

export function logAttempt(questionId, isCorrect) {
  return apiFetch('/quiz/attempt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: questionId, is_correct: isCorrect }),
  })
}

export function fetchInterviewQuestions(slug) {
  return apiFetch(`/interview/questions/${slug}`)
}

export function evaluateAnswer(moduleSlug, question, answer) {
  return apiFetch('/interview/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module_slug: moduleSlug, question, answer }),
  })
}

export function evaluateAnswerWithSrs(moduleSlug, questionId, question, answer) {
  return apiFetch('/interview/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module_slug: moduleSlug, question_id: questionId, question, answer }),
  })
}

export function fetchInterviewReviewQueue() {
  return apiFetch('/interview/review/queue')
}

export function fetchNote(lessonSlug) {
  return apiFetch(`/notes/${lessonSlug}`)
}

export function saveNote(lessonSlug, content) {
  return apiFetch(`/notes/${lessonSlug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export function fetchModuleQuiz(moduleSlug) {
  return apiFetch(`/quiz/module/${moduleSlug}`)
}

export function searchContent(q) {
  return apiFetch(`/search?q=${encodeURIComponent(q)}`)
}

const RECENT_KEY = 'devops_recent'
const MAX_RECENT = 10

export function addRecentLesson({ moduleSlug, moduleTitle, lessonSlug, lessonTitle }) {
  const existing = getRecentLessons()
  const filtered = existing.filter(r => r.lessonSlug !== lessonSlug)
  const updated = [{ moduleSlug, moduleTitle, lessonSlug, lessonTitle }, ...filtered].slice(0, MAX_RECENT)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(updated)) } catch { /* storage full */ }
  window.dispatchEvent(new Event('recent-updated'))
}

export function getRecentLessons() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] }
}

export function fetchStats() {
  return apiFetch('/stats')
}

export function fetchReadiness() {
  return apiFetch('/stats/readiness')
}

const BOOKMARKS_KEY = 'devops_bookmarks'

export function addBookmark({ moduleSlug, moduleTitle, lessonSlug, lessonTitle }) {
  const existing = getBookmarks()
  if (existing.some(b => b.lessonSlug === lessonSlug)) return
  const updated = [...existing, { moduleSlug, moduleTitle, lessonSlug, lessonTitle }]
  try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(updated)) } catch { /* storage full */ }
  window.dispatchEvent(new Event('bookmark-updated'))
}

export function removeBookmark(lessonSlug) {
  const updated = getBookmarks().filter(b => b.lessonSlug !== lessonSlug)
  try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(updated)) } catch {}
  window.dispatchEvent(new Event('bookmark-updated'))
}

export function isBookmarked(lessonSlug) {
  return getBookmarks().some(b => b.lessonSlug === lessonSlug)
}

export function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]') } catch { return [] }
}
