const API = 'http://localhost:8000'

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

export function fetchXp() {
  return apiFetch('/xp')
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
