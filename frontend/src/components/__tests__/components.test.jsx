import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Monaco Editor cannot run in jsdom — stub it out
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={e => onChange?.(e.target.value)}
    />
  ),
}))

// Mock curriculumStore — prevents real fetch calls from Review, Notes, Quiz, CodePlayground
vi.mock('../../store/curriculumStore', () => ({
  fetchReviewQueue: vi.fn(),
  logAttempt: vi.fn(),
  fetchQuiz: vi.fn(),
  fetchNote: vi.fn(),
  saveNote: vi.fn(),
  checkExercise: vi.fn(),
}))
import {
  fetchReviewQueue, logAttempt, fetchQuiz, fetchNote, saveNote,
} from '../../store/curriculumStore'

// Stub fetch globally for any remaining direct API calls
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

// ─── readiness utility ────────────────────────────────────────────────────────
import { readinessColor } from '../../utils/readiness'

describe('readinessColor', () => {
  it('returns emerald for score >= 75', () => {
    expect(readinessColor(75)).toMatch(/emerald/)
    expect(readinessColor(100)).toMatch(/emerald/)
  })

  it('returns amber for score 40–74', () => {
    expect(readinessColor(40)).toMatch(/amber/)
    expect(readinessColor(74)).toMatch(/amber/)
  })

  it('returns red for score < 40', () => {
    expect(readinessColor(0)).toMatch(/red/)
    expect(readinessColor(39)).toMatch(/red/)
  })
})

// ─── ThemeToggle ──────────────────────────────────────────────────────────────
import ThemeToggle from '../ThemeToggle'

describe('ThemeToggle', () => {
  it('shows Light label when dark is true', () => {
    render(<ThemeToggle dark={true} toggle={() => {}} />)
    expect(screen.getByRole('button')).toHaveTextContent('Light')
  })

  it('shows Dark label when dark is false', () => {
    render(<ThemeToggle dark={false} toggle={() => {}} />)
    expect(screen.getByRole('button')).toHaveTextContent('Dark')
  })

  it('calls toggle on click', () => {
    const toggle = vi.fn()
    render(<ThemeToggle dark={false} toggle={toggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(toggle).toHaveBeenCalledOnce()
  })
})

// ─── CodePlayground ───────────────────────────────────────────────────────────
import CodePlayground from '../CodePlayground'

describe('CodePlayground', () => {
  it('renders Run button', () => {
    render(<CodePlayground />)
    expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument()
  })

  it('renders Check button when expectedOutput is provided', () => {
    render(<CodePlayground expectedOutput="hello" exerciseSlug="bash/script-basics" exerciseIndex={0} />)
    expect(screen.getByRole('button', { name: /check/i })).toBeInTheDocument()
  })

  it('does not render Check button without expectedOutput', () => {
    render(<CodePlayground />)
    expect(screen.queryByRole('button', { name: /check/i })).toBeNull()
  })

  it('defaults to bash language tab active', () => {
    render(<CodePlayground />)
    const bashBtn = screen.getByRole('button', { name: /^bash$/i })
    expect(bashBtn).toHaveClass('bg-emerald-600')
  })
})

// ─── SearchModal ──────────────────────────────────────────────────────────────
import SearchModal from '../SearchModal'

const MOCK_MODULES = [
  {
    slug: 'linux', title: 'Linux',
    lessons: [
      { id: 1, slug: 'cron', title: 'Cron Jobs' },
      { id: 2, slug: 'systemd', title: 'Systemd' },
    ],
  },
]

describe('SearchModal', () => {
  it('renders the search input', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('filters lessons by title when query matches', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cron' } })
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument()
    expect(screen.queryByText('Systemd')).toBeNull()
  })
})

// ─── Review ───────────────────────────────────────────────────────────────────
import Review from '../../pages/Review'

const MOCK_CARD = {
  id: 1,
  question: 'What is a container?',
  options: ['A virtual machine', 'An isolated process', 'A network switch'],
  correct_index: 1,
  explanation: 'Containers are lightweight isolated processes.',
  lesson_title: 'Docker Basics',
  module_title: 'Docker',
}

describe('Review', () => {
  it('shows 0 count and "All caught up" when queue is empty', async () => {
    fetchReviewQueue.mockResolvedValue([])
    render(<Review />)
    await waitFor(() => expect(screen.getByText('0')).toBeInTheDocument())
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument()
  })

  it('shows card count and Start Review button when queue has items', async () => {
    fetchReviewQueue.mockResolvedValue([MOCK_CARD])
    render(<Review />)
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /start review/i })).toBeInTheDocument()
  })

  it('does not show Start Review button when queue is empty', async () => {
    fetchReviewQueue.mockResolvedValue([])
    render(<Review />)
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /start review/i })).toBeNull()
  })

  it('disables Finish button while logAttempt is pending (race condition regression)', async () => {
    fetchReviewQueue.mockResolvedValue([MOCK_CARD])
    // Never resolves — simulates slow network holding the DB write open
    logAttempt.mockReturnValue(new Promise(() => {}))

    render(<Review />)
    await waitFor(() => screen.getByRole('button', { name: /start review/i }))
    fireEvent.click(screen.getByRole('button', { name: /start review/i }))

    // Active phase — must click "Reveal Answer" before options appear
    await waitFor(() => screen.getByText(MOCK_CARD.question))
    fireEvent.click(screen.getByRole('button', { name: /reveal answer/i }))

    await waitFor(() => screen.getByRole('button', { name: /A\. A virtual machine/ }))
    fireEvent.click(screen.getByRole('button', { name: /A\. A virtual machine/ }))

    // Finish appears but must be disabled until logAttempt resolves
    expect(screen.getByRole('button', { name: /finish/i })).toBeDisabled()
  })

  it('shows score percentage after completing all cards', async () => {
    fetchReviewQueue.mockResolvedValue([MOCK_CARD])
    logAttempt.mockResolvedValue({ xp_earned: 5, xp_total: 50 })

    render(<Review />)
    await waitFor(() => screen.getByRole('button', { name: /start review/i }))
    fireEvent.click(screen.getByRole('button', { name: /start review/i }))

    await waitFor(() => screen.getByText(MOCK_CARD.question))
    fireEvent.click(screen.getByRole('button', { name: /reveal answer/i }))

    // Click the correct answer (index 1 = "An isolated process")
    await waitFor(() => screen.getByRole('button', { name: /B\. An isolated process/ }))
    fireEvent.click(screen.getByRole('button', { name: /B\. An isolated process/ }))

    await waitFor(() => screen.getByRole('button', { name: /finish/i }))
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))

    // Done phase: 1/1 correct = 100%
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument())
  })
})

// ─── Sidebar ──────────────────────────────────────────────────────────────────
import Sidebar from '../Sidebar'

const SIDEBAR_MODULE = {
  slug: 'linux',
  title: 'Linux',
  group: 'Foundations',
  lessons: [
    { id: 1, slug: 'lesson-1', title: 'Lesson One' },
    { id: 2, slug: 'lesson-2', title: 'Lesson Two' },
  ],
}

function renderSidebar(props = {}) {
  return render(
    <MemoryRouter>
      <Sidebar
        modules={[SIDEBAR_MODULE]}
        progress={{}}
        reviewDue={0}
        interviewDue={0}
        {...props}
      />
    </MemoryRouter>
  )
}

describe('Sidebar', () => {
  it('shows Spaced Review badge with count when reviewDue > 0', () => {
    renderSidebar({ reviewDue: 3 })
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('hides Spaced Review badge when reviewDue is 0', () => {
    renderSidebar({ reviewDue: 0 })
    // Badge text should not exist; "Spaced Review" nav link still present
    const link = screen.getByRole('link', { name: /spaced review/i })
    expect(link).toBeInTheDocument()
    expect(link).not.toHaveTextContent('0')
  })

  it('shows Interview badge with count when interviewDue > 0', () => {
    renderSidebar({ interviewDue: 5 })
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('shows Done badge for fully completed module', () => {
    renderSidebar({ progress: { '1': 'complete', '2': 'complete' } })
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('shows progress % badge for in-progress module', () => {
    renderSidebar({ progress: { '1': 'complete' } })
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})

// ─── Notes ────────────────────────────────────────────────────────────────────
import Notes from '../Notes'

describe('Notes', () => {
  beforeEach(() => {
    fetchNote.mockResolvedValue({ content: '' })
    saveNote.mockResolvedValue({})
  })

  it('renders textarea with placeholder', () => {
    // Textarea renders immediately — no async wait needed
    render(<Notes lessonSlug="linux/permissions" />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/your notes/i)).toBeInTheDocument()
  })

  it('shows Saving… after typing (debounce fires after 800ms)', async () => {
    // Use a pending saveNote so the 'saving' state doesn't immediately resolve to 'saved'
    saveNote.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      render(<Notes lessonSlug="linux/permissions" />)
      await act(async () => { await Promise.resolve() })

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'some note' } })
      await act(async () => { vi.advanceTimersByTime(800) })

      expect(screen.getByText('Saving…')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows ✓ Saved after save resolves', async () => {
    vi.useFakeTimers()
    try {
      render(<Notes lessonSlug="linux/permissions" />)
      await act(async () => { await Promise.resolve() })

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'some note' } })
      await act(async () => { vi.advanceTimersByTime(800) })
      // Let the saveNote promise's .then() microtask fire
      await act(async () => { await Promise.resolve() })

      expect(screen.getByText('✓ Saved')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── Quiz ─────────────────────────────────────────────────────────────────────
import Quiz from '../Quiz'

const MOCK_QUESTION = {
  id: 10,
  question: 'Which command lists files?',
  options: ['ls', 'cd', 'pwd', 'rm'],
  correct_index: 0,
  explanation: 'ls lists directory contents.',
}

describe('Quiz', () => {
  it('renders Start Quiz button in idle phase', () => {
    render(<Quiz lessonSlug="linux/permissions" />)
    expect(screen.getByRole('button', { name: /start quiz/i })).toBeInTheDocument()
  })

  it('shows question and options after starting', async () => {
    fetchQuiz.mockResolvedValue([MOCK_QUESTION])
    logAttempt.mockResolvedValue({ xp_earned: 5, xp_total: 55 })

    render(<Quiz lessonSlug="linux/permissions" />)
    fireEvent.click(screen.getByRole('button', { name: /start quiz/i }))

    await waitFor(() => expect(screen.getByText(MOCK_QUESTION.question)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /A\. ls/ })).toBeInTheDocument()
  })

  it('disables option buttons after selecting an answer', async () => {
    fetchQuiz.mockResolvedValue([MOCK_QUESTION])
    logAttempt.mockResolvedValue({ xp_earned: 5, xp_total: 55 })

    render(<Quiz lessonSlug="linux/permissions" />)
    fireEvent.click(screen.getByRole('button', { name: /start quiz/i }))

    await waitFor(() => screen.getByRole('button', { name: /A\. ls/ }))
    fireEvent.click(screen.getByRole('button', { name: /A\. ls/ }))

    // All option buttons should be disabled once revealed
    const optionBtns = screen.getAllByRole('button', { name: /^[A-D]\./ })
    optionBtns.forEach(btn => expect(btn).toBeDisabled())
  })

  it('shows score percentage after completing all questions', async () => {
    fetchQuiz.mockResolvedValue([MOCK_QUESTION])
    logAttempt.mockResolvedValue({ xp_earned: 5, xp_total: 55 })

    render(<Quiz lessonSlug="linux/permissions" />)
    fireEvent.click(screen.getByRole('button', { name: /start quiz/i }))

    await waitFor(() => screen.getByRole('button', { name: /A\. ls/ }))
    fireEvent.click(screen.getByRole('button', { name: /A\. ls/ })) // correct

    await waitFor(() => screen.getByRole('button', { name: /see results/i }))
    fireEvent.click(screen.getByRole('button', { name: /see results/i }))

    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument())
  })
})
