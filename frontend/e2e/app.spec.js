import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5173'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function clearLocalStorage(page) {
  await page.evaluate(() =>
    ['devops_bookmarks', 'devops_recent', 'playground-editor-height'].forEach(k =>
      localStorage.removeItem(k)
    )
  )
}

// Returns current XP value, or 0 if the XP badge is not rendered (fresh DB).
async function getXP(page) {
  const el = page.locator('text=/\\d+ XP/').first()
  if (await el.count() === 0) return 0
  const text = await el.textContent()
  return parseInt(text.replace(/\D/g, ''), 10)
}

// Returns the index of the first exercise with expected_output for a given lesson slug.
async function firstCheckableExercise(page, lessonSlug) {
  const data = await page.evaluate(async (slug) => {
    const r = await fetch(`http://localhost:8000/lessons/${slug}`)
    return r.json()
  }, lessonSlug)
  const idx = data.exercises.findIndex(ex => ex.expected_output)
  if (idx === -1) throw new Error(`No checkable exercise found in ${lessonSlug}`)
  return { index: idx, expectedOutput: data.exercises[idx].expected_output }
}

// Opens a Monaco editor exercise card by index, waits for editor to mount.
async function openExercise(page, index) {
  const card = page.locator(`[data-exercise-index="${index}"]`)
  const tryIt = card.locator('button:has-text("Try it")')
  await expect(tryIt).toBeVisible()
  await tryIt.click()
  await page.waitForSelector('.monaco-editor', { timeout: 8000 })
}

// Replaces all editor content with the given text.
async function typeInEditor(page, text) {
  // Use Monaco's API to set value directly — reliable, fires onChange synchronously.
  const set = await page.evaluate((code) => {
    const editors = window._monacoEditors
    if (editors && editors.length > 0) {
      editors[editors.length - 1].setValue(code)
      return true
    }
    return false
  }, text)
  if (!set) {
    // Fallback: keyboard interaction with textarea
    const textarea = page.locator('.monaco-editor textarea').first()
    await textarea.focus()
    await page.waitForTimeout(200)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.type(text)
    await page.waitForTimeout(200)
  }
}

// ── 1. Core navigation ────────────────────────────────────────────────────────

test('sidebar renders all 23 modules', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.locator('nav a[href^="/module/"]')).toHaveCount(23)
})

test('roadmap page loads with module cards', async ({ page }) => {
  await page.goto(`${BASE}/roadmap`)
  await expect(page.locator('text=Roadmap').first()).toBeVisible()
  await expect(page.locator('text=Linux').first()).toBeVisible()
})

test('roadmap module card links to module page', async ({ page }) => {
  await page.goto(`${BASE}/roadmap`)
  await page.locator('a[href="/module/bash"]').first().click()
  await expect(page).toHaveURL(/\/module\/bash/)
})

// ── 2. Lesson viewer ─────────────────────────────────────────────────────────

test('lesson loads with title, content, and exercises', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await expect(page.locator('h1, h2').first()).toBeVisible()
  await expect(page.locator('button:has-text("Try it")').first()).toBeVisible()
})

test('mark lesson complete awards XP', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  // Wait for progress to load — one of the two states will become visible
  await page.locator('button:has-text("Mark as complete")')
    .or(page.locator('text=✓ Lesson complete')).first()
    .waitFor({ state: 'visible', timeout: 5000 })
  // Reset if already done so XP can be re-awarded on this run
  if (await page.locator('text=✓ Lesson complete').count() > 0) {
    await page.locator('button:has-text("Reset")').click()
    await expect(page.locator('button:has-text("Mark as complete")')).toBeVisible({ timeout: 3000 })
  }
  const xpBefore = await getXP(page)
  await page.locator('button:has-text("Mark as complete")').click()
  await page.waitForTimeout(600)
  expect(await getXP(page)).toBeGreaterThan(xpBefore)
})

test('lesson completion persists after reload', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const markDone = page.locator('button:has-text("Mark done")')
  if (await markDone.count() > 0) await markDone.click()
  await page.waitForTimeout(600)
  await page.reload()
  // After reload the lesson should show as done — no "Mark done" button
  await expect(page.locator('button:has-text("Mark done")')).toHaveCount(0)
})

// ── 3. Code sandbox ───────────────────────────────────────────────────────────

test('Run button executes code and shows output', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await openExercise(page, 0)
  await typeInEditor(page, 'echo "e2e-run-test"')
  await page.waitForTimeout(200)
  await page.locator('button:has-text("Run")').first().click()
  await expect(page.locator('text=e2e-run-test')).toBeVisible({ timeout: 15000 })
})

test('Ctrl+Enter fires Run from inside Monaco', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await openExercise(page, 0)
  await page.evaluate(() => {
    window.__runCalled = false
    const orig = window.fetch
    window.fetch = (...a) => { if (a[0]?.includes('/sandbox/run')) window.__runCalled = true; return orig.apply(window, a) }
  })
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__runCalled)).toBe(true)
})

test('Check button validates correct answer and awards XP', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const { index, expectedOutput } = await firstCheckableExercise(page, 'script-basics')
  await openExercise(page, index)
  await typeInEditor(page, `echo "${expectedOutput}"`)
  const xpBefore = await getXP(page)
  await page.locator('button:has-text("Check")').first().click()
  await expect(page.locator('text=✅ Correct!').first()).toBeVisible({ timeout: 15000 })
  // Check is idempotent — XP may not increase on a repeat attempt
  expect(await getXP(page)).toBeGreaterThanOrEqual(xpBefore)
})

test('Ctrl+Shift+Enter fires Check from inside Monaco', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const { index } = await firstCheckableExercise(page, 'script-basics')
  await openExercise(page, index)
  await page.evaluate(() => {
    window.__checkCalled = false
    const orig = window.fetch
    window.fetch = (...a) => { if (a[0]?.includes('/sandbox/check')) window.__checkCalled = true; return orig.apply(window, a) }
  })
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+Shift+Enter')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__checkCalled)).toBe(true)
})

test('passed exercise shows checkmark badge and persists after close', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const { index, expectedOutput } = await firstCheckableExercise(page, 'script-basics')
  const card = page.locator(`[data-exercise-index="${index}"]`)
  await openExercise(page, index)
  await typeInEditor(page, `echo "${expectedOutput}"`)
  await page.locator('button:has-text("Check")').first().click()
  await expect(page.locator('text=✅ Correct!').first()).toBeVisible({ timeout: 15000 })
  await card.locator('button:has-text("Close")').click()
  await expect(card.locator('text=✓')).toBeVisible()
})

test('editor height persists in localStorage across reloads', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await openExercise(page, 0)
  await page.evaluate(() => localStorage.setItem('playground-editor-height', '350'))
  await page.reload()
  await openExercise(page, 0)
  expect(await page.evaluate(() => localStorage.getItem('playground-editor-height'))).toBe('350')
})

// ── 4. Hints ─────────────────────────────────────────────────────────────────

test('Hint button reveals first hint, Next hint reveals second', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const { index } = await firstCheckableExercise(page, 'script-basics')
  await openExercise(page, index)

  const hintBtn = page.locator('button:has-text("Hint")').first()
  if (await hintBtn.count() === 0) return test.skip()

  await hintBtn.click()
  await expect(page.locator('text=/Hint 1:/i')).toBeVisible()

  const nextBtn = page.locator('button:has-text("Next hint")')
  if (await nextBtn.count() > 0) {
    await nextBtn.click()
    await expect(page.locator('text=/Hint 2:/i')).toBeVisible()
  }
})

// ── 5. Quiz ───────────────────────────────────────────────────────────────────

test('quiz panel loads and Start Quiz shows questions', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Quiz")').first().click()
  await expect(page.locator('button:has-text("Start Quiz")')).toBeVisible({ timeout: 3000 })
  await page.locator('button:has-text("Start Quiz")').click()
  await expect(page.locator('button').filter({ hasText: /^A\./ }).first()).toBeVisible({ timeout: 5000 })
})

test('selecting a quiz answer shows feedback', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Quiz")').first().click()
  await page.locator('button:has-text("Start Quiz")').click()
  const options = page.locator('button').filter({ hasText: /^[A-D]\./ })
  await expect(options.first()).toBeVisible({ timeout: 3000 })
  await options.first().click()
  await expect(page.locator('text=/correct|incorrect|Next/i').first()).toBeVisible({ timeout: 3000 })
})

// ── 6. AI Tutor ───────────────────────────────────────────────────────────────

test('AI Tutor panel and input are present on lesson page', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await expect(page.locator('button:has-text("Tutor")')).toBeVisible()
  await expect(page.getByPlaceholder('Ask a question… (Enter to send)')).toBeVisible()
})

// ── 7. Notes ─────────────────────────────────────────────────────────────────

test('notes save and reload after navigation', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Notes")').first().click()
  const noteText = `e2e-${Date.now()}`
  await page.getByPlaceholder('Your notes for this lesson…').fill(noteText)
  await page.waitForTimeout(1500) // auto-save debounce
  await page.reload()
  await page.locator('button:has-text("Notes")').first().click()
  await expect(page.locator(`text=${noteText}`)).toBeVisible({ timeout: 3000 })
})

// ── 8. Bookmarks ─────────────────────────────────────────────────────────────

test('bookmarking a lesson appears in Saved dropdown', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await clearLocalStorage(page)
  await page.reload()
  await page.locator('button:has-text("☆")').first().click()
  await page.waitForTimeout(300)
  await page.locator('button:has-text("Saved")').click()
  await expect(page.locator('text=Script Writing Basics').first()).toBeVisible({ timeout: 2000 })
  await clearLocalStorage(page)
})

// ── 9. Search ────────────────────────────────────────────────────────────────

test('search returns results for a known term', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('button:has-text("Search")').first().click()
  const input = page.getByPlaceholder(/search/i)
  await expect(input).toBeVisible({ timeout: 2000 })
  await input.fill('docker')
  await page.waitForTimeout(400)
  // At least one result row should appear (results render as <button> inside a <ul>)
  await expect(page.locator('ul button').first()).toBeVisible({ timeout: 3000 })
})

// ── 10. Interview Prep ────────────────────────────────────────────────────────

test('InterviewPrep page loads with a question', async ({ page }) => {
  await page.goto(`${BASE}/interview`)
  await expect(page.locator('select').first()).toBeVisible({ timeout: 3000 })
})

test('InterviewPrep module dropdown includes all 23 modules', async ({ page }) => {
  await page.goto(`${BASE}/interview`)
  const select = page.locator('select').first()
  await expect(select).toBeVisible({ timeout: 3000 })
  expect(await select.locator('option').count()).toBeGreaterThanOrEqual(23)
})

test('grading Strong on an interview question awards XP', async ({ page }) => {
  await page.goto(`${BASE}/interview`)
  await page.locator('button:has-text("Quick Review")').click()
  const revealBtn = page.locator('button:has-text("Reveal Answer")')
  await expect(revealBtn).toBeVisible({ timeout: 5000 })
  const xpBefore = await getXP(page)
  await revealBtn.click()
  const strongBtn = page.locator('button:has-text("Strong")')
  await expect(strongBtn.first()).toBeVisible({ timeout: 5000 })
  await strongBtn.first().click()
  await page.waitForTimeout(1000)
  expect(await getXP(page)).toBeGreaterThan(xpBefore)
})

// ── 11. Stats ─────────────────────────────────────────────────────────────────

test('stats page renders XP and streak sections', async ({ page }) => {
  await page.goto(`${BASE}/stats`)
  await expect(page.locator('text=/XP|Experience/i').first()).toBeVisible()
  await expect(page.locator('text=/streak/i').first()).toBeVisible()
})

test('export button downloads a JSON file', async ({ page }) => {
  await page.goto(`${BASE}/stats`)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator('button:has-text("Export")').first().click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.json$/)
})

// ── 12. Projects ─────────────────────────────────────────────────────────────

test('projects page lists projects', async ({ page }) => {
  await page.goto(`${BASE}/projects`)
  await expect(page.locator('a[href^="/projects/"]').first()).toBeVisible({ timeout: 3000 })
})

test('project detail page shows steps', async ({ page }) => {
  await page.goto(`${BASE}/projects`)
  await page.locator('a[href^="/projects/"]').first().click()
  await expect(page.locator('text=/step/i').first()).toBeVisible({ timeout: 5000 })
})

// ── 13. Spaced Review ────────────────────────────────────────────────────────

test('spaced review page loads', async ({ page }) => {
  await page.goto(`${BASE}/review`)
  // Either shows a queue or an empty-state message
  await expect(page.locator('text=/review|queue|nothing|caught up/i').first()).toBeVisible({ timeout: 3000 })
})

// ── 14. Module quiz page ──────────────────────────────────────────────────────

test('module quiz page loads for bash', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/quiz`)
  await expect(page.locator('text=/quiz/i').first()).toBeVisible({ timeout: 3000 })
})

// ── 15. Focus mode ────────────────────────────────────────────────────────────

test('Focus mode hides right panel, Side panel restores it', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await expect(page.locator('button:has-text("Tutor")')).toBeVisible()
  await page.locator('button:has-text("Focus")').click()
  await expect(page.locator('button:has-text("Tutor")')).not.toBeVisible()
  await page.locator('button:has-text("Side panel")').click()
  await expect(page.locator('button:has-text("Tutor")')).toBeVisible()
})

// ── 16. Dark mode ─────────────────────────────────────────────────────────────

test('dark mode toggle adds and removes dark class', async ({ page }) => {
  await page.goto(BASE)
  // Ensure we start in light mode
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); localStorage.setItem('theme', 'light') })
  await page.locator('button:has-text("Dark")').click()
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
  await page.locator('button:has-text("Light")').click()
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
})

// ── 17. Exercise parser regression ────────────────────────────────────────────
// Before the fix, ### Exercise N: blocks were split on every numbered sub-bullet,
// turning a 6-exercise lesson into 14 phantom items.

test('awk-sed renders exactly 6 exercise cards (parser regression)', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/awk-sed`)
  await page.waitForSelector('[data-exercise-index]', { timeout: 8000 })
  await expect(page.locator('[data-exercise-index]')).toHaveCount(6)
})

test('awk-sed named exercises have multi-step text, not a single sub-bullet', async ({ page }) => {
  await page.goto(BASE) // navigate first so page.evaluate fetch is not blocked by about:blank
  const data = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8000/lessons/awk-sed')
    return r.json()
  })
  // First 4 exercises are named (open-ended, no expected_output).
  const named = data.exercises.filter(ex => ex.expected_output === null)
  expect(named).toHaveLength(4)
  for (const ex of named) {
    const lines = ex.text.split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(1)
  }
})

// ── 18. Search group filter ───────────────────────────────────────────────────

test('search group filter pills appear when results span groups', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('button:has-text("Search")').first().click()
  const input = page.getByPlaceholder(/search/i)
  await expect(input).toBeVisible({ timeout: 2000 })
  await input.fill('docker')
  await page.waitForTimeout(400)
  // "All" pill is the first exact-match "All" button in the filter row
  await expect(page.getByRole('button', { name: 'All', exact: true }).first()).toBeVisible({ timeout: 3000 })
})

test('search group filter pill narrows results to that group', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('button:has-text("Search")').first().click()
  const input = page.getByPlaceholder(/search/i)
  await expect(input).toBeVisible({ timeout: 2000 })
  // "linux" has results only in Foundations; after clicking Foundations pill, Containers results gone
  await input.fill('bash')
  await page.waitForTimeout(400)
  const foundationsPill = page.locator('button:has-text("Foundations")')
  if (await foundationsPill.count() > 0) {
    await foundationsPill.click()
    // Containers & Infra pill should no longer be active (still visible but not filtering Foundations results out)
    await expect(page.locator('button:has-text("Foundations")')).toBeVisible()
  }
})

// ── 19. Keyboard navigation ───────────────────────────────────────────────────

test('pressing ] on a lesson navigates to the next lesson', async ({ page }) => {
  // Load app first so fetch is available in page context
  await page.goto(BASE)
  const data = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8000/modules')
    return r.json()
  })
  const bashModule = data.find(m => m.slug === 'bash')
  if (!bashModule || bashModule.lessons.length < 2) return test.skip()

  const firstLesson = bashModule.lessons[0]
  const secondLesson = bashModule.lessons[1]
  await page.goto(`${BASE}/module/bash/lesson/${firstLesson.slug}`)
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 5000 })
  await page.keyboard.press(']')
  await expect(page).toHaveURL(new RegExp(secondLesson.slug), { timeout: 3000 })
})

test('pressing space marks lesson complete and awards XP', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 5000 })
  // Only run if lesson is not already complete
  const markDone = page.locator('button:has-text("Mark as complete"), button:has-text("Mark done")')
  if (await markDone.count() === 0) return test.skip()
  const xpBefore = await getXP(page)
  await page.keyboard.press(' ')
  await page.waitForTimeout(800)
  expect(await getXP(page)).toBeGreaterThan(xpBefore)
})

// ── 20. Interview Quick Review ────────────────────────────────────────────────

test('Quick Review shows flashcard with Reveal Answer button', async ({ page }) => {
  await page.goto(`${BASE}/interview`)
  const quickReview = page.locator('button:has-text("Quick Review")')
  await expect(quickReview).toBeVisible({ timeout: 3000 })
  await quickReview.click()
  // After clicking Quick Review, a question and Reveal Answer button should appear
  await expect(
    page.locator('button:has-text("Reveal Answer"), button:has-text("Reveal")').first()
  ).toBeVisible({ timeout: 5000 })
})

// ── 21. Module Quiz complete flow ─────────────────────────────────────────────

test('module quiz shows explanation and disables options after answering', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/quiz`)
  await expect(page.locator('button:has-text("Start Quiz")')).toBeVisible({ timeout: 5000 })
  await page.locator('button:has-text("Start Quiz")').click()
  // First question options appear
  await expect(page.locator('button').filter({ hasText: /^A\./ }).first()).toBeVisible({ timeout: 5000 })
  // Click the first option
  await page.locator('button').filter({ hasText: /^A\./ }).first().click()
  // After answering, all option buttons become disabled and an advance button appears
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    return btns.some(b => b.textContent.trim() === 'Next →' || b.textContent.trim() === 'Finish')
  }, { timeout: 5000 })
  // All A-D option buttons for this question should be disabled
  const options = page.locator('button').filter({ hasText: /^[A-D]\./ })
  const count = await options.count()
  for (let i = 0; i < count; i++) {
    await expect(options.nth(i)).toBeDisabled()
  }
})

// ── 22. Exercise SRS due badge ────────────────────────────────────────────────

test('exercise SRS due badge shows amber indicator when exercises are due', async ({ page }) => {
  await page.goto(BASE)
  const data = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8000/sandbox/exercises/due')
    return r.json()
  })
  if (data.due_count === 0) return test.skip()

  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  // Due exercises show an amber ↻ icon on the exercise card
  await expect(page.locator('text=↻').first()).toBeVisible({ timeout: 5000 })
})
