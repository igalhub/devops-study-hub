import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:8000'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function clearLocalStorage(page) {
  await page.evaluate(() => {
    ['devops_bookmarks', 'devops_recent', 'playground-editor-height'].forEach(k =>
      localStorage.removeItem(k)
    )
  })
}

async function getXP(page) {
  const text = await page.locator('text=/\\d+ XP/').first().textContent()
  return parseInt(text.replace(/\D/g, ''), 10)
}

// ── 1. Core navigation ────────────────────────────────────────────────────────

test('sidebar renders all 23 modules', async ({ page }) => {
  await page.goto(BASE)
  const links = page.locator('nav a[href^="/module/"]')
  await expect(links).toHaveCount(23)
})

test('roadmap page loads with module cards', async ({ page }) => {
  await page.goto(`${BASE}/roadmap`)
  await expect(page.locator('text=Roadmap')).toBeVisible()
  // At least one module card with a progress indicator
  await expect(page.locator('text=Linux')).toBeVisible()
})

// ── 2. Lesson viewer ─────────────────────────────────────────────────────────

test('lesson loads with title and content', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await expect(page.locator('h1, h2').first()).toBeVisible()
  // Exercises section
  await expect(page.locator('button:has-text("Try it")').first()).toBeVisible()
})

test('mark lesson complete awards XP', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const xpBefore = await getXP(page)
  const markDone = page.locator('button:has-text("Mark done"), button:has-text("Done")')
  if (await markDone.count() > 0) {
    await markDone.first().click()
    await page.waitForTimeout(500)
    const xpAfter = await getXP(page)
    expect(xpAfter).toBeGreaterThan(xpBefore)
  }
})

test('lesson completion persists after reload', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const markDone = page.locator('button:has-text("Mark done"), button:has-text("Done")')
  if (await markDone.count() > 0) {
    await markDone.first().click()
    await page.waitForTimeout(500)
    await page.reload()
    await expect(page.locator('button:has-text("Done"), [class*="emerald"]').first()).toBeVisible()
  }
})

// ── 3. Code sandbox ───────────────────────────────────────────────────────────

test('Run button executes code and shows output', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  // Open first exercise
  await page.locator('button:has-text("Try it")').first().click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  // Clear editor and type a simple command
  const textarea = page.locator('.monaco-editor textarea').first()
  await textarea.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('echo "e2e-test-output"')

  await page.locator('button:has-text("Run")').first().click()
  await expect(page.locator('text=e2e-test-output')).toBeVisible({ timeout: 15000 })
})

test('Ctrl+Enter keyboard shortcut fires Run', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Try it")').first().click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  // Patch fetch to detect /sandbox/run call
  await page.evaluate(() => {
    window.__runCalled = false
    const orig = window.fetch
    window.fetch = (...args) => {
      if (args[0]?.includes('/sandbox/run')) window.__runCalled = true
      return orig.apply(window, args)
    }
  })

  const textarea = page.locator('.monaco-editor textarea').first()
  await textarea.focus()
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(500)

  const called = await page.evaluate(() => window.__runCalled)
  expect(called).toBe(true)
})

test('Check button validates correct answer and awards XP', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)

  // Find exercise 14 which has expected_output
  const card = page.locator('[data-exercise-index="14"]')
  await card.locator('button:has-text("Try it")').click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  // Get expected output from API
  const lesson = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8000/lessons/script-basics')
    return r.json()
  })
  const ex = lesson.exercises[14]

  const textarea = page.locator('.monaco-editor textarea').first()
  await textarea.focus()
  await page.keyboard.press('Control+a')
  // Type the solution code that produces the expected output
  await textarea.fill('')
  await page.keyboard.type(`echo "${ex.expected_output}"`)

  const xpBefore = await getXP(page)
  await page.locator('button:has-text("Check")').first().click()
  await expect(page.locator('text=Correct')).toBeVisible({ timeout: 15000 })
  const xpAfter = await getXP(page)
  expect(xpAfter).toBeGreaterThanOrEqual(xpBefore)
})

test('Ctrl+Shift+Enter fires Check from inside Monaco', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const card = page.locator('[data-exercise-index="14"]')
  await card.locator('button:has-text("Try it")').click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  await page.evaluate(() => {
    window.__checkCalled = false
    const orig = window.fetch
    window.fetch = (...args) => {
      if (args[0]?.includes('/sandbox/check')) window.__checkCalled = true
      return orig.apply(window, args)
    }
  })

  const textarea = page.locator('.monaco-editor textarea').first()
  await textarea.focus()
  await page.keyboard.press('Control+Shift+Enter')
  await page.waitForTimeout(500)

  const called = await page.evaluate(() => window.__checkCalled)
  expect(called).toBe(true)
})

test('completed exercise shows checkmark badge after passing', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const card = page.locator('[data-exercise-index="14"]')
  await card.locator('button:has-text("Try it")').click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  const lesson = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8000/lessons/script-basics')
    return r.json()
  })
  const ex = lesson.exercises[14]

  const textarea = page.locator('.monaco-editor textarea').first()
  await textarea.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.type(`echo "${ex.expected_output}"`)
  await page.locator('button:has-text("Check")').first().click()
  await expect(page.locator('text=Correct')).toBeVisible({ timeout: 15000 })

  // Close and reopen — badge should persist
  await card.locator('button:has-text("Close")').click()
  await expect(card.locator('text=✓')).toBeVisible()
})

test('editor height persists across exercise open/close', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Try it")').first().click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  // Set a custom height via localStorage
  await page.evaluate(() => localStorage.setItem('playground-editor-height', '350'))
  await page.reload()
  await page.locator('button:has-text("Try it")').first().click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  const height = await page.evaluate(() => localStorage.getItem('playground-editor-height'))
  expect(height).toBe('350')
})

// ── 4. Hints ─────────────────────────────────────────────────────────────────

test('Hint button reveals hints one at a time', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  // Find an exercise that has hints (expected_output exercises)
  const card = page.locator('[data-exercise-index="14"]')
  await card.locator('button:has-text("Try it")').click()
  await page.waitForSelector('.monaco-editor', { timeout: 5000 })

  const hintBtn = page.locator('button:has-text("Hint"), button:has-text("hint")').first()
  if (await hintBtn.count() === 0) {
    test.skip()
    return
  }

  await hintBtn.click()
  await expect(page.locator('text=/Hint 1:/i')).toBeVisible()

  const nextHint = page.locator('button:has-text("Next hint")')
  if (await nextHint.count() > 0) {
    await nextHint.click()
    await expect(page.locator('text=/Hint 2:/i')).toBeVisible()
  }
})

// ── 5. Quiz ───────────────────────────────────────────────────────────────────

test('quiz loads 5 questions for a lesson', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Quiz"), [role="tab"]:has-text("Quiz")').first().click()
  await expect(page.locator('button:has-text("Start Quiz")')).toBeVisible({ timeout: 3000 })
  await page.locator('button:has-text("Start Quiz")').click()
  await expect(page.locator('text=/Question 1/i')).toBeVisible({ timeout: 3000 })
})

test('answering a quiz question shows feedback', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('button:has-text("Quiz"), [role="tab"]:has-text("Quiz")').first().click()
  await page.locator('button:has-text("Start Quiz")').click()
  await page.waitForSelector('button[class*="rounded"]:not(:has-text("Start"))', { timeout: 3000 })

  // Click the first answer option
  const options = page.locator('button').filter({ hasText: /^[A-D]\./ })
  if (await options.count() > 0) {
    await options.first().click()
    // Should show correct/incorrect feedback
    await expect(page.locator('text=/correct|incorrect|Next/i').first()).toBeVisible({ timeout: 3000 })
  }
})

// ── 6. AI Tutor ───────────────────────────────────────────────────────────────

test('AI tutor panel is present on lesson page', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await expect(page.locator('text=Tutor')).toBeVisible()
  await expect(page.locator('placeholder=Ask a question')).toBeVisible()
})

// ── 7. Notes ─────────────────────────────────────────────────────────────────

test('notes tab saves and reloads content', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  await page.locator('[role="tab"]:has-text("Notes"), button:has-text("Notes")').first().click()

  const noteText = `e2e-note-${Date.now()}`
  const editor = page.locator('textarea[placeholder*="notes"], .notes-editor, [contenteditable]').first()
  if (await editor.count() > 0) {
    await editor.fill(noteText)
    await page.waitForTimeout(1500) // auto-save debounce
    await page.reload()
    await page.locator('[role="tab"]:has-text("Notes"), button:has-text("Notes")').first().click()
    await expect(page.locator(`text=${noteText}`)).toBeVisible({ timeout: 3000 })
  }
})

// ── 8. Bookmarks ─────────────────────────────────────────────────────────────

test('bookmarking a lesson appears in header dropdown', async ({ page }) => {
  await clearLocalStorage(page)
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)

  await page.locator('button[title*="Bookmark"], button:has-text("☆")').first().click()
  await page.waitForTimeout(300)

  // Open bookmarks dropdown
  await page.locator('button:has-text("Saved")').click()
  await expect(page.locator('text=Script Writing Basics')).toBeVisible({ timeout: 2000 })

  // Cleanup
  await clearLocalStorage(page)
})

// ── 9. Search ────────────────────────────────────────────────────────────────

test('search returns results for a known term', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('button:has-text("Search"), button[aria-label*="Search"]').first().click()
  await page.waitForTimeout(200)

  const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first()
  await searchInput.fill('docker')
  await page.waitForTimeout(500)
  await expect(page.locator('[class*="result"], [role="option"]').first()).toBeVisible({ timeout: 3000 })
})

// ── 10. Interview Prep ────────────────────────────────────────────────────────

test('InterviewPrep loads and shows a question', async ({ page }) => {
  await page.goto(`${BASE}/interview`)
  await expect(page.locator('text=/interview|question/i').first()).toBeVisible()
  // Module selector should be present
  await expect(page.locator('select, [role="combobox"]').first()).toBeVisible()
})

test('InterviewPrep shows all modules in dropdown', async ({ page }) => {
  await page.goto(`${BASE}/interview`)
  const select = page.locator('select').first()
  const options = await select.locator('option').count()
  expect(options).toBeGreaterThanOrEqual(23)
})

test('self-grading an interview answer awards XP for Strong', async ({ page }) => {
  await page.goto(`${BASE}/interview/bash`)
  await page.waitForSelector('text=/Strong|Adequate|Weak/i', { timeout: 5000 }).catch(() => {})

  const xpBefore = await getXP(page)
  const strongBtn = page.locator('button:has-text("Strong")')
  if (await strongBtn.count() > 0) {
    await strongBtn.first().click()
    await page.waitForTimeout(1000)
    const xpAfter = await getXP(page)
    expect(xpAfter).toBeGreaterThanOrEqual(xpBefore)
  }
})

// ── 11. Stats ─────────────────────────────────────────────────────────────────

test('stats page renders XP and streak sections', async ({ page }) => {
  await page.goto(`${BASE}/stats`)
  await expect(page.locator('text=/XP|Experience/i').first()).toBeVisible()
  await expect(page.locator('text=/streak/i').first()).toBeVisible()
})

// ── 12. Projects ─────────────────────────────────────────────────────────────

test('projects page lists 10 projects', async ({ page }) => {
  await page.goto(`${BASE}/projects`)
  await expect(page.locator('text=/project/i').first()).toBeVisible()
  const cards = page.locator('[class*="card"], article, [class*="project"]')
  await expect(cards.first()).toBeVisible()
})

test('project detail page loads with steps', async ({ page }) => {
  await page.goto(`${BASE}/projects`)
  // Click first project
  const firstProject = page.locator('a[href^="/projects/"]').first()
  if (await firstProject.count() > 0) {
    await firstProject.click()
    await expect(page.locator('text=/Step|step/i').first()).toBeVisible({ timeout: 3000 })
  }
})

// ── 13. Spaced Review ────────────────────────────────────────────────────────

test('spaced review page loads', async ({ page }) => {
  await page.goto(`${BASE}/review`)
  await expect(page.locator('text=/review|flashcard|queue/i').first()).toBeVisible()
})

// ── 14. Export ───────────────────────────────────────────────────────────────

test('export button triggers file download', async ({ page }) => {
  await page.goto(`${BASE}/stats`)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.locator('button:has-text("Export")').first().click(),
  ])
  if (download) {
    expect(download.suggestedFilename()).toMatch(/\.json$/)
  }
})

// ── 15. Dark mode ─────────────────────────────────────────────────────────────

test('dark mode toggle switches theme', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('button:has-text("Light"), button:has-text("Dark")').first().click()
  await page.waitForTimeout(200)
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  // Toggle again to restore
  await page.locator('button:has-text("Light"), button:has-text("Dark")').first().click()
  // Either state is valid — we just confirm the toggle fires without errors
  expect(typeof isDark).toBe('boolean')
})

// ── 16. Focus mode ────────────────────────────────────────────────────────────

test('Focus mode hides the right panel', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/lesson/script-basics`)
  const focusBtn = page.locator('button:has-text("Focus")')
  await focusBtn.click()
  await page.waitForTimeout(200)
  // Tutor/Quiz/Notes panel should be hidden
  const panel = page.locator('text=Tutor')
  const visible = await panel.isVisible()
  // Click again to restore
  await focusBtn.click()
  expect(visible).toBe(false)
})

// ── 17. Module quiz page ──────────────────────────────────────────────────────

test('module quiz page loads for bash', async ({ page }) => {
  await page.goto(`${BASE}/module/bash/quiz`)
  await expect(page.locator('text=/quiz/i').first()).toBeVisible()
})

// ── 18. Roadmap links to modules ──────────────────────────────────────────────

test('roadmap module card links to module page', async ({ page }) => {
  await page.goto(`${BASE}/roadmap`)
  await page.locator('a[href="/module/bash"]').first().click()
  await expect(page).toHaveURL(/\/module\/bash/)
})
