import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

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

// Mock curriculumStore — prevents real fetch calls from all components and pages
vi.mock('../../store/curriculumStore', () => ({
  fetchReviewQueue: vi.fn(),
  logAttempt: vi.fn(),
  fetchQuiz: vi.fn(),
  fetchNote: vi.fn(),
  saveNote: vi.fn(),
  checkExercise: vi.fn(),
  fetchInterviewQuestions: vi.fn(),
  evaluateAnswerWithSrs: vi.fn(),
  fetchInterviewReviewQueue: vi.fn(),
  selfGradeInterview: vi.fn(),
  markLessonComplete: vi.fn(),
  resetLessonProgress: vi.fn(),
  fetchStats: vi.fn(),
  fetchProgressExport: vi.fn(),
  fetchLesson: vi.fn(),
  addRecentLesson: vi.fn(),
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(),
  isBookmarked: vi.fn().mockReturnValue(false),
  fetchExerciseDue: vi.fn(),
  searchContent: vi.fn(),
  fetchModuleQuiz: vi.fn(),
  fetchWeakAreaQuestions: vi.fn(),
  getBookmarks: vi.fn().mockReturnValue([]),
  getRecentLessons: vi.fn().mockReturnValue([]),
}))

vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }) => <pre>{children}</pre>,
}))
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneDark: {},
}))
import {
  fetchReviewQueue, logAttempt, fetchQuiz, fetchNote, saveNote,
  fetchInterviewQuestions, evaluateAnswerWithSrs, selfGradeInterview,
  fetchStats, fetchLesson, fetchExerciseDue,
  fetchModuleQuiz, fetchWeakAreaQuestions, getBookmarks, getRecentLessons,
  checkExercise, markLessonComplete,
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

  it('renders Show answer button for open-ended exercise (no expectedOutput)', () => {
    render(<CodePlayground exerciseSlug="linux/cron" exerciseText="Write a cron job" />)
    expect(screen.getByRole('button', { name: /show answer/i })).toBeInTheDocument()
  })

  it('does not render Show answer button for validated exercise (has expectedOutput)', () => {
    render(<CodePlayground expectedOutput="hello" exerciseSlug="linux/cron" exerciseText="echo hello" />)
    expect(screen.queryByRole('button', { name: /show answer/i })).toBeNull()
  })

  it('toggles to Hide answer after clicking Show answer', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ answer: '`crontab -e`' }),
    })
    render(<CodePlayground exerciseSlug="linux/cron" exerciseText="Write a cron job" />)
    fireEvent.click(screen.getByRole('button', { name: /show answer/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /hide answer/i })).toBeInTheDocument())
  })
})

// ─── SearchModal ──────────────────────────────────────────────────────────────
import SearchModal from '../SearchModal'

const MOCK_MODULES = [
  {
    slug: 'linux', title: 'Linux', group: 'Foundations',
    lessons: [
      { id: 1, slug: 'cron', title: 'Cron Jobs' },
      { id: 2, slug: 'systemd', title: 'Systemd' },
    ],
  },
  {
    slug: 'docker', title: 'Docker', group: 'Containers & Infra',
    lessons: [
      { id: 3, slug: 'scheduling', title: 'Cron-style Scheduling' },
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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'systemd' } })
    expect(screen.getByText('Systemd')).toBeInTheDocument()
    expect(screen.queryByText('Cron Jobs')).toBeNull()
  })

  it('shows group filter pills when results span multiple groups', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cron' } })
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Foundations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Containers & Infra' })).toBeInTheDocument()
  })

  it('filters results to selected group when pill is clicked', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cron' } })
    fireEvent.click(screen.getByRole('button', { name: 'Foundations' }))
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument()
    expect(screen.queryByText('Cron-style Scheduling')).toBeNull()
  })

  it('restores all results when All pill is clicked after group filter', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cron' } })
    fireEvent.click(screen.getByRole('button', { name: 'Foundations' }))
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument()
    expect(screen.getByText('Cron-style Scheduling')).toBeInTheDocument()
  })

  it('resets group filter when query changes', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cron' } })
    fireEvent.click(screen.getByRole('button', { name: 'Foundations' }))
    expect(screen.queryByText('Cron-style Scheduling')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'style' } })
    expect(screen.getByText('Cron-style Scheduling')).toBeInTheDocument()
  })

  it('does not show pills when query is empty', () => {
    render(
      <MemoryRouter>
        <SearchModal modules={MOCK_MODULES} onClose={() => {}} />
      </MemoryRouter>
    )
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull()
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

  it('shows exercise due badge on Spaced Review when exerciseDue > 0', () => {
    renderSidebar({ exerciseDue: 7 })
    expect(screen.getByText('7 ex')).toBeInTheDocument()
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /A\. ls/ }))
    })

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

// ─── ProjectDetail ────────────────────────────────────────────────────────────
import ProjectDetail from '../../pages/ProjectDetail'

const MOCK_PROJECT = {
  slug: 'containerize-python-app',
  title: 'Containerize a Python App',
  description: 'Build and containerize a Python web app.',
  difficulty: 'intermediate',
  modules: ['Docker', 'Python'],
  steps: [
    {
      id: 1, title: 'Write a Dockerfile', type: 'sandbox',
      prompt: 'Write a Dockerfile for a Python app.',
      language: 'bash', status: 'not_started', score: null, answer: null,
      hints: ['Use FROM python:3.11', 'Set WORKDIR to /app'],
    },
    {
      id: 2, title: 'Run the container', type: 'sandbox',
      prompt: 'Run the container and verify output.',
      language: 'bash', status: 'not_started', score: null, answer: null,
      hints: [],
    },
    {
      id: 3, title: 'Explain Docker layers', type: 'ai',
      prompt: 'Explain how Docker layers work.',
      language: null, status: 'not_started', score: null, answer: null,
      hints: [],
    },
    {
      id: 4, title: 'Push to registry', type: 'sandbox',
      prompt: 'Push the image to a registry.',
      language: 'bash', status: 'not_started', score: null, answer: null,
      hints: [],
    },
  ],
}

function renderProjectDetail(slug = 'containerize-python-app') {
  return render(
    <MemoryRouter initialEntries={[`/projects/${slug}`]}>
      <Routes>
        <Route path="/projects/:projectSlug" element={<ProjectDetail onXpEarned={() => {}} />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProjectDetail', () => {
  it('shows loading state before fetch resolves', () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    renderProjectDetail()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders project title and difficulty badge after fetch', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => expect(screen.getByText('Containerize a Python App')).toBeInTheDocument())
    expect(screen.getByText('intermediate')).toBeInTheDocument()
  })

  it('renders all four step titles', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => screen.getByText('Write a Dockerfile'))
    expect(screen.getByText('Run the container')).toBeInTheDocument()
    expect(screen.getByText('Explain Docker layers')).toBeInTheDocument()
    expect(screen.getByText('Push to registry')).toBeInTheDocument()
  })

  it('first sandbox step is expanded — Run and Check buttons visible', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => screen.getByText('Write a Dockerfile'))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^check$/i })).toBeInTheDocument()
  })

  it('AI step shows Submit for AI Review when expanded', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => screen.getByText('Explain Docker layers'))
    fireEvent.click(screen.getByText('Explain Docker layers'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit for ai review/i })).toBeInTheDocument()
    )
  })

  it('shows Hint button for step with hints', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => screen.getByText('Write a Dockerfile'))
    expect(screen.getByRole('button', { name: /^hint$/i })).toBeInTheDocument()
  })
})

// ─── InterviewPrep ────────────────────────────────────────────────────────────
import InterviewPrep from '../../pages/InterviewPrep'

const MOCK_MODULES_IP = [{ slug: 'docker', title: 'Docker' }]

const MOCK_INTERVIEW_QUESTION = {
  id: 10,
  question: 'What is the difference between a container and a VM?',
  hints: [],
  model_answer: 'Containers share the OS kernel while VMs run a full guest OS.',
}

const MOCK_REVIEW_CARD = {
  id: 1,
  question: 'What is a Docker image?',
  hints: [],
  module_slug: 'docker',
  module_title: 'Docker',
  model_answer: 'A Docker image is a read-only template.',
}

function renderInterviewPrep(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/interview']}>
      <Routes>
        <Route path="/interview" element={
          <InterviewPrep
            modules={MOCK_MODULES_IP}
            onXpEarned={() => {}}
            onInterviewDueChange={() => {}}
            interviewQueue={null}
            {...props}
          />
        } />
      </Routes>
    </MemoryRouter>
  )
}

describe('InterviewPrep', () => {
  it('renders heading and Start Session button in idle state', () => {
    renderInterviewPrep()
    expect(screen.getByText('Interview Prep')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start session/i })).toBeInTheDocument()
  })

  it('renders Quick Review button', () => {
    renderInterviewPrep()
    expect(screen.getByRole('button', { name: /quick review/i })).toBeInTheDocument()
  })

  it('shows review banner when interviewQueue has items', () => {
    renderInterviewPrep({ interviewQueue: [MOCK_REVIEW_CARD] })
    expect(screen.getByRole('button', { name: /practice due/i })).toBeInTheDocument()
  })

  it('hides review banner when interviewQueue is empty', () => {
    renderInterviewPrep({ interviewQueue: [] })
    expect(screen.queryByRole('button', { name: /practice due/i })).toBeNull()
  })

  it('shows question and Submit Answer after clicking Start Session', async () => {
    fetchInterviewQuestions.mockResolvedValue([MOCK_INTERVIEW_QUESTION])
    renderInterviewPrep()
    fireEvent.click(screen.getByRole('button', { name: /start session/i }))
    await waitFor(() =>
      expect(screen.getByText(MOCK_INTERVIEW_QUESTION.question)).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /submit answer/i })).toBeInTheDocument()
  })

  it('shows Reveal Answer button in flashcard mode after Quick Review', async () => {
    fetchInterviewQuestions.mockResolvedValue([MOCK_INTERVIEW_QUESTION])
    renderInterviewPrep()
    fireEvent.click(screen.getByRole('button', { name: /quick review/i }))
    await waitFor(() =>
      expect(screen.getByText(MOCK_INTERVIEW_QUESTION.question)).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /reveal answer/i })).toBeInTheDocument()
  })

  it('renders Mock Interview button in idle state', () => {
    renderInterviewPrep()
    expect(screen.getByRole('button', { name: /mock interview/i })).toBeInTheDocument()
  })

  it('shows question and countdown timer after clicking Mock Interview', async () => {
    fetchInterviewQuestions.mockResolvedValue([MOCK_INTERVIEW_QUESTION])
    renderInterviewPrep()
    fireEvent.click(screen.getByRole('button', { name: /mock interview/i }))
    await waitFor(() =>
      expect(screen.getByText(MOCK_INTERVIEW_QUESTION.question)).toBeInTheDocument()
    )
    expect(screen.getByText('15:00')).toBeInTheDocument()
  })

  it('Submit Answer in mock mode reveals model answer without calling evaluateAnswerWithSrs', async () => {
    fetchInterviewQuestions.mockResolvedValue([MOCK_INTERVIEW_QUESTION])
    renderInterviewPrep()
    fireEvent.click(screen.getByRole('button', { name: /mock interview/i }))
    await waitFor(() =>
      expect(screen.getByText(MOCK_INTERVIEW_QUESTION.question)).toBeInTheDocument()
    )
    fireEvent.change(screen.getByPlaceholderText(/type your answer/i), { target: { value: 'containers share the kernel' } })
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }))
    await waitFor(() =>
      expect(screen.getByText(/show model answer/i)).toBeInTheDocument()
    )
    expect(evaluateAnswerWithSrs).not.toHaveBeenCalled()
  })

  it('self-grading in mock mode shows results card without calling selfGradeInterview', async () => {
    fetchInterviewQuestions.mockResolvedValue([MOCK_INTERVIEW_QUESTION])
    renderInterviewPrep()
    fireEvent.click(screen.getByRole('button', { name: /mock interview/i }))
    await waitFor(() =>
      expect(screen.getByText(MOCK_INTERVIEW_QUESTION.question)).toBeInTheDocument()
    )
    fireEvent.change(screen.getByPlaceholderText(/type your answer/i), { target: { value: 'containers share the kernel' } })
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }))
    await waitFor(() =>
      expect(screen.getByText(/show model answer/i)).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: /^strong$/i }))
    await waitFor(() =>
      expect(screen.getByText('Mock Interview Complete')).toBeInTheDocument()
    )
    expect(screen.getByText(/accuracy/i)).toBeInTheDocument()
    expect(selfGradeInterview).not.toHaveBeenCalled()
  })
})

// ─── Roadmap ──────────────────────────────────────────────────────────────────
import Roadmap from '../../pages/Roadmap'

const MOCK_ROADMAP_MODULES = [
  { slug: 'linux', title: 'Linux', group: 'Foundations', lessons: [{ id: 1 }, { id: 2 }] },
  { slug: 'python', title: 'Python', group: 'Foundations', lessons: [{ id: 3 }] },
  { slug: 'docker', title: 'Docker', group: 'Containers & Infra', lessons: [{ id: 4 }] },
]

describe('Roadmap', () => {
  it('renders Roadmap heading', () => {
    render(<Roadmap modules={MOCK_ROADMAP_MODULES} progress={{}} />)
    expect(screen.getByRole('heading', { name: /roadmap/i })).toBeInTheDocument()
  })

  it('renders group headings for represented groups', () => {
    render(<Roadmap modules={MOCK_ROADMAP_MODULES} progress={{}} />)
    expect(screen.getByText('Foundations')).toBeInTheDocument()
    expect(screen.getByText('Containers & Infra')).toBeInTheDocument()
  })

  it('renders all module titles', () => {
    render(<Roadmap modules={MOCK_ROADMAP_MODULES} progress={{}} />)
    expect(screen.getByText('Linux')).toBeInTheDocument()
    expect(screen.getByText('Python')).toBeInTheDocument()
    expect(screen.getByText('Docker')).toBeInTheDocument()
  })

  it('shows 50% for a half-completed 2-lesson module', () => {
    // Linux has 2 lessons; lesson id 1 is complete → 50%
    render(<Roadmap modules={MOCK_ROADMAP_MODULES} progress={{ '1': 'complete' }} />)
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('shows readiness % when readiness data is provided', () => {
    render(
      <Roadmap
        modules={MOCK_ROADMAP_MODULES}
        progress={{}}
        readiness={{ linux: { readiness: 72 } }}
      />
    )
    expect(screen.getByText('72%')).toBeInTheDocument()
  })

  it('shows no Resume CTA when recent lessons list is empty', () => {
    getRecentLessons.mockReturnValue([])
    render(<MemoryRouter><Roadmap modules={MOCK_ROADMAP_MODULES} progress={{}} /></MemoryRouter>)
    expect(screen.queryByText(/resume/i)).not.toBeInTheDocument()
  })

  it('shows Resume CTA linking to the last visited lesson', () => {
    getRecentLessons.mockReturnValue([
      { moduleSlug: 'linux', moduleTitle: 'Linux', lessonSlug: 'cron', lessonTitle: 'Cron Jobs' },
    ])
    render(<MemoryRouter><Roadmap modules={MOCK_ROADMAP_MODULES} progress={{}} /></MemoryRouter>)
    const link = screen.getByRole('link', { name: /cron jobs/i })
    expect(link).toHaveAttribute('href', '/module/linux/lesson/cron')
  })
})

// ─── ModuleView ───────────────────────────────────────────────────────────────
import ModuleView from '../../pages/ModuleView'

const MOCK_MODULE_MV = {
  slug: 'linux', title: 'Linux', group: 'Foundations',
  lessons: [
    { id: 1, slug: 'cron', title: 'Cron Jobs', duration_min: 15, difficulty: 'beginner' },
    { id: 2, slug: 'systemd', title: 'Systemd', duration_min: 20, difficulty: 'intermediate' },
  ],
}

function renderModuleView(slug = 'linux', progress = {}) {
  return render(
    <MemoryRouter initialEntries={[`/module/${slug}`]}>
      <Routes>
        <Route path="/module/:moduleSlug" element={
          <ModuleView modules={[MOCK_MODULE_MV]} progress={progress} onProgressUpdate={() => {}} />
        } />
      </Routes>
    </MemoryRouter>
  )
}

describe('ModuleView', () => {
  it('shows Module not found for an unknown slug', () => {
    renderModuleView('does-not-exist')
    expect(screen.getByText('Module not found.')).toBeInTheDocument()
  })

  it('renders module title and lesson count', () => {
    renderModuleView()
    expect(screen.getByRole('heading', { name: 'Linux' })).toBeInTheDocument()
    expect(screen.getByText('2 lessons')).toBeInTheDocument()
  })

  it('renders all lesson titles', () => {
    renderModuleView()
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument()
    expect(screen.getByText('Systemd')).toBeInTheDocument()
  })

  it('shows Mark done button for each incomplete lesson', () => {
    renderModuleView()
    const buttons = screen.getAllByRole('button', { name: /mark done/i })
    expect(buttons).toHaveLength(2)
  })

  it('shows ✓ Done and Reset for a completed lesson', () => {
    // lesson id 1 (Cron Jobs) is complete; Systemd is not
    renderModuleView('linux', { '1': 'complete' })
    expect(screen.getByText('✓ Done')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^reset$/i })).toBeInTheDocument()
  })
})

// ─── Stats ────────────────────────────────────────────────────────────────────
import Stats from '../../pages/Stats'

const MOCK_STATS_DATA = {
  summary: { total_xp: 250, lessons_done: 5, quiz_attempts: 10, quiz_correct: 7, streak: 3 },
  xp_by_day: [
    { day: '2026-05-01', xp: 50 },
    { day: '2026-05-31', xp: 30 },
  ],
  quiz_by_module: [
    { module_title: 'Linux', module_slug: 'linux', total: 5, correct: 4 },
  ],
  quiz_weak_lessons: [
    { lesson_slug: 'filesystem-permissions', lesson_title: 'File System & Permissions', module_slug: 'linux', module_title: 'Linux', accuracy: 40, attempt_count: 5, wrong_count: 3 },
  ],
}

describe('Stats', () => {
  it('shows loading state while fetchStats is pending', () => {
    fetchStats.mockReturnValue(new Promise(() => {}))
    render(<MemoryRouter><Stats /></MemoryRouter>)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows error state when fetchStats rejects', async () => {
    fetchStats.mockRejectedValue(new Error('network error'))
    render(<MemoryRouter><Stats /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Failed to load stats.')).toBeInTheDocument())
  })

  it('renders summary cards with correct values', async () => {
    fetchStats.mockResolvedValue(MOCK_STATS_DATA)
    render(<MemoryRouter><Stats /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('250 XP')).toBeInTheDocument())
    expect(screen.getByText('70%')).toBeInTheDocument()
    expect(screen.getByText('3 days')).toBeInTheDocument()
  })

  it('renders Export progress button after data loads', async () => {
    fetchStats.mockResolvedValue(MOCK_STATS_DATA)
    render(<MemoryRouter><Stats /></MemoryRouter>)
    await waitFor(() => screen.getByRole('button', { name: /export progress/i }))
    expect(screen.getByRole('button', { name: /export progress/i })).toBeInTheDocument()
  })

  it('quiz_by_module module name links to /module/:slug', async () => {
    fetchStats.mockResolvedValue(MOCK_STATS_DATA)
    render(<MemoryRouter><Stats /></MemoryRouter>)
    await waitFor(() => screen.getByText('Quiz accuracy by module'))
    const links = screen.getAllByRole('link', { name: 'Linux' })
    expect(links.some(l => l.getAttribute('href') === '/module/linux')).toBe(true)
  })

  it('quiz_weak_lessons module name links to /module/:slug', async () => {
    fetchStats.mockResolvedValue(MOCK_STATS_DATA)
    render(<MemoryRouter><Stats /></MemoryRouter>)
    await waitFor(() => screen.getByText('Quiz Weak Areas'))
    const moduleLinks = screen.getAllByRole('link', { name: 'Linux' })
    expect(moduleLinks.some(l => l.getAttribute('href') === '/module/linux')).toBe(true)
  })

  it('shows no quiz attempts message when quiz_by_module is empty', async () => {
    fetchStats.mockResolvedValue({
      ...MOCK_STATS_DATA,
      quiz_by_module: [],
      summary: { ...MOCK_STATS_DATA.summary, quiz_attempts: 0 },
    })
    render(<MemoryRouter><Stats /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no quiz attempts yet/i)).toBeInTheDocument())
  })
})

// ─── LessonViewer ─────────────────────────────────────────────────────────────
import LessonViewer from '../../pages/LessonViewer'

const MOCK_LESSON_DATA = {
  id: 10, title: 'Cron Jobs', module_title: 'Linux', module_slug: 'linux',
  difficulty: 'beginner', duration_min: 15,
  content: '## Introduction\n\nCron is a job scheduler.',
  exercises: [],
}

const MOCK_MODULES_LV = [
  {
    slug: 'linux', title: 'Linux',
    lessons: [
      { id: 10, slug: 'cron', title: 'Cron Jobs' },
      { id: 11, slug: 'systemd', title: 'Systemd' },
    ],
  },
]

function renderLessonViewer(slug = 'cron', progress = {}) {
  return render(
    <MemoryRouter initialEntries={[`/module/linux/lesson/${slug}`]}>
      <Routes>
        <Route path="/module/:moduleSlug/lesson/:lessonSlug" element={
          <LessonViewer modules={MOCK_MODULES_LV} progress={progress} onProgressUpdate={() => {}} />
        } />
      </Routes>
    </MemoryRouter>
  )
}

describe('LessonViewer', () => {
  beforeEach(() => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve({ completed: [] }) })
    fetchExerciseDue.mockResolvedValue({ due_keys: [], due_count: 0 })
  })

  it('shows skeleton loading while fetchLesson is pending', async () => {
    fetchLesson.mockReturnValue(new Promise(() => {}))
    const { container } = renderLessonViewer()
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeInTheDocument())
  })

  it('shows Lesson not found when fetchLesson rejects with 404', async () => {
    fetchLesson.mockRejectedValue(new Error('404 Not Found'))
    renderLessonViewer()
    await waitFor(() => expect(screen.getByText('Lesson not found.')).toBeInTheDocument())
  })

  it('renders lesson title after fetchLesson resolves', async () => {
    fetchLesson.mockResolvedValue(MOCK_LESSON_DATA)
    renderLessonViewer()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cron Jobs' })).toBeInTheDocument())
  })

  it('shows Mark as complete button for an incomplete lesson', async () => {
    fetchLesson.mockResolvedValue(MOCK_LESSON_DATA)
    renderLessonViewer()
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
    expect(screen.getByRole('button', { name: /mark as complete/i })).toBeInTheDocument()
  })

  it('shows ✓ Lesson complete and Reset when lesson is done', async () => {
    fetchLesson.mockResolvedValue(MOCK_LESSON_DATA)
    renderLessonViewer('cron', { '10': 'complete' })
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
    expect(screen.getByText('✓ Lesson complete')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^reset$/i })).toBeInTheDocument()
  })

  it('pressing ] navigates to the next lesson', async () => {
    fetchLesson
      .mockResolvedValueOnce(MOCK_LESSON_DATA)
      .mockResolvedValueOnce({ ...MOCK_LESSON_DATA, id: 11, title: 'Systemd' })
    renderLessonViewer('cron')
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
    fireEvent.keyDown(window, { key: ']' })
    await waitFor(() => screen.getByRole('heading', { name: 'Systemd' }))
  })

  it('pressing [ navigates to the previous lesson', async () => {
    fetchLesson
      .mockResolvedValueOnce({ ...MOCK_LESSON_DATA, id: 11, title: 'Systemd' })
      .mockResolvedValueOnce(MOCK_LESSON_DATA)
    renderLessonViewer('systemd')
    await waitFor(() => screen.getByRole('heading', { name: 'Systemd' }))
    fireEvent.keyDown(window, { key: '[' })
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
  })

  it('pressing space calls markLessonComplete for an incomplete lesson', async () => {
    fetchLesson.mockResolvedValue(MOCK_LESSON_DATA)
    markLessonComplete.mockResolvedValue({ xp_earned: 5, xp_total: 50 })
    renderLessonViewer('cron')
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
    fireEvent.keyDown(window, { key: ' ' })
    expect(markLessonComplete).toHaveBeenCalledWith(10)
  })

  it('shows Contents navigation when content has 3+ headings', async () => {
    const richContent = [
      '## Introduction',
      'Some text.',
      '## Core Concepts',
      'More text.',
      '## Summary',
      'Done.',
    ].join('\n\n')
    fetchLesson.mockResolvedValue({ ...MOCK_LESSON_DATA, content: richContent })
    renderLessonViewer('cron')
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
    expect(screen.getByText('Contents')).toBeInTheDocument()
  })

  it('renders Reference link to /reference/:moduleSlug in lesson header', async () => {
    fetchLesson.mockResolvedValue(MOCK_LESSON_DATA)
    renderLessonViewer()
    await waitFor(() => screen.getByRole('heading', { name: 'Cron Jobs' }))
    const refLink = screen.getByRole('link', { name: /reference/i })
    expect(refLink).toHaveAttribute('href', '/reference/linux')
  })
})

// ─── Hint reveal (HintBox via ProjectDetail) ──────────────────────────────────
describe('HintBox progressive reveal', () => {
  it('first Hint click shows first hint text and changes button to Next hint', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => screen.getByText('Write a Dockerfile'))
    fireEvent.click(screen.getByRole('button', { name: /^hint$/i }))
    expect(screen.getByText(/Use FROM python:3\.11/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next hint/i })).toBeInTheDocument()
  })

  it('second click shows second hint and disables button with No more hints', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECT) })
    renderProjectDetail()
    await waitFor(() => screen.getByText('Write a Dockerfile'))
    fireEvent.click(screen.getByRole('button', { name: /^hint$/i }))
    fireEvent.click(screen.getByRole('button', { name: /next hint/i }))
    expect(screen.getByText(/Set WORKDIR to \/app/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /no more hints/i })).toBeDisabled()
  })
})

// ─── BookmarksDropdown ────────────────────────────────────────────────────────
import BookmarksDropdown from '../BookmarksDropdown'

describe('BookmarksDropdown', () => {
  it('renders nothing when bookmarks list is empty', () => {
    getBookmarks.mockReturnValue([])
    const { container } = render(<MemoryRouter><BookmarksDropdown /></MemoryRouter>)
    expect(container.firstChild).toBeNull()
  })

  it('renders Saved button when bookmarks exist', () => {
    getBookmarks.mockReturnValue([
      { lessonSlug: 'cron', lessonTitle: 'Cron Jobs', moduleSlug: 'linux', moduleTitle: 'Linux' },
    ])
    render(<MemoryRouter><BookmarksDropdown /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument()
  })
})

// ─── RecentDropdown ───────────────────────────────────────────────────────────
import RecentDropdown from '../RecentDropdown'

describe('RecentDropdown', () => {
  it('renders nothing when recent list is empty', () => {
    getRecentLessons.mockReturnValue([])
    const { container } = render(<MemoryRouter><RecentDropdown /></MemoryRouter>)
    expect(container.firstChild).toBeNull()
  })

  it('renders Recent button when history exists', () => {
    getRecentLessons.mockReturnValue([
      { lessonSlug: 'cron', lessonTitle: 'Cron Jobs', moduleSlug: 'linux', moduleTitle: 'Linux' },
    ])
    render(<MemoryRouter><RecentDropdown /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /recent/i })).toBeInTheDocument()
  })
})

// ─── ModuleQuiz ───────────────────────────────────────────────────────────────
import ModuleQuiz from '../../pages/ModuleQuiz'

const MOCK_MQ_QUESTION = {
  id: 20,
  question: 'What does docker run do?',
  options: ['Builds an image', 'Starts a container', 'Pushes to registry', 'Pulls an image'],
  correct_index: 1,
  explanation: 'docker run creates and starts a new container.',
  lesson_title: 'Docker Basics',
}

const MOCK_MODULES_MQ = [{ slug: 'docker', title: 'Docker' }]

function renderModuleQuiz(slug = 'docker') {
  return render(
    <MemoryRouter initialEntries={[`/module/${slug}/quiz`]}>
      <Routes>
        <Route path="/module/:moduleSlug/quiz" element={<ModuleQuiz modules={MOCK_MODULES_MQ} />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ModuleQuiz', () => {
  it('shows loading state while fetchModuleQuiz is pending', () => {
    fetchModuleQuiz.mockReturnValue(new Promise(() => {}))
    renderModuleQuiz()
    expect(screen.getByText('Loading questions…')).toBeInTheDocument()
  })

  it('shows Module Quiz heading and Start Quiz button in idle phase', async () => {
    fetchModuleQuiz.mockResolvedValue([MOCK_MQ_QUESTION])
    renderModuleQuiz()
    await waitFor(() => expect(screen.getByRole('heading', { name: /module quiz/i })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /start quiz/i })).toBeInTheDocument()
  })

  it('shows question and options after clicking Start Quiz', async () => {
    fetchModuleQuiz.mockResolvedValue([MOCK_MQ_QUESTION])
    logAttempt.mockResolvedValue({ xp_earned: 0 })
    renderModuleQuiz()
    await waitFor(() => screen.getByRole('button', { name: /start quiz/i }))
    fireEvent.click(screen.getByRole('button', { name: /start quiz/i }))
    await waitFor(() => expect(screen.getByText(MOCK_MQ_QUESTION.question)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /A\. Builds an image/ })).toBeInTheDocument()
  })

  it('shows 100% score after answering the single question correctly', async () => {
    fetchModuleQuiz.mockResolvedValue([MOCK_MQ_QUESTION])
    logAttempt.mockResolvedValue({ xp_earned: 5 })
    renderModuleQuiz()
    await waitFor(() => screen.getByRole('button', { name: /start quiz/i }))
    fireEvent.click(screen.getByRole('button', { name: /start quiz/i }))
    await waitFor(() => screen.getByRole('button', { name: /B\. Starts a container/ }))
    fireEvent.click(screen.getByRole('button', { name: /B\. Starts a container/ }))
    await waitFor(() => screen.getByRole('button', { name: /finish/i }))
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument())
  })

  it('shows back-link with module title in idle phase', async () => {
    fetchModuleQuiz.mockResolvedValue([MOCK_MQ_QUESTION])
    renderModuleQuiz()
    await waitFor(() => screen.getByRole('button', { name: /start quiz/i }))
    expect(screen.getByText(/← docker/i)).toBeInTheDocument()
  })
})

// ─── AiTutor ──────────────────────────────────────────────────────────────────
import AiTutor from '../AiTutor'

describe('AiTutor', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('shows empty state when no messages', () => {
    render(<AiTutor lessonSlug="linux/cron" />)
    expect(screen.getByText(/no questions yet/i)).toBeInTheDocument()
  })

  it('renders textarea with placeholder and disabled Send button when input is empty', () => {
    render(<AiTutor lessonSlug="linux/cron" />)
    expect(screen.getByPlaceholderText(/ask a question/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
  })

  it('enables Send button once textarea has text', () => {
    render(<AiTutor lessonSlug="linux/cron" />)
    fireEvent.change(screen.getByPlaceholderText(/ask a question/i), {
      target: { value: 'How do cron jobs work?' },
    })
    expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled()
  })

  it('shows Thinking… on Send button while fetch is pending', async () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    render(<AiTutor lessonSlug="linux/cron" />)
    fireEvent.change(screen.getByPlaceholderText(/ask a question/i), {
      target: { value: 'What is cron?' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /thinking/i })).toBeInTheDocument()
    )
  })
})

// ─── CodePlayground check result ─────────────────────────────────────────────

describe('CodePlayground check result', () => {
  it('shows ✅ Correct! after a passing Check', async () => {
    checkExercise.mockResolvedValue({ passed: true, xp_earned: 5, expected: 'hello', actual: 'hello' })
    render(
      <CodePlayground expectedOutput="hello" exerciseSlug="bash/script-basics" exerciseIndex={0} />
    )
    fireEvent.click(screen.getByRole('button', { name: /check/i }))
    await waitFor(() => expect(screen.getByText(/Correct/)).toBeInTheDocument())
  })

  it('shows +XP badge when xp_earned > 0 on pass', async () => {
    checkExercise.mockResolvedValue({ passed: true, xp_earned: 5, expected: 'hello', actual: 'hello' })
    render(
      <CodePlayground expectedOutput="hello" exerciseSlug="bash/script-basics" exerciseIndex={0} />
    )
    fireEvent.click(screen.getByRole('button', { name: /check/i }))
    await waitFor(() => expect(screen.getByText('+5 XP')).toBeInTheDocument())
  })

  it('shows ❌ Not quite and diff panels when Check fails', async () => {
    checkExercise.mockResolvedValue({
      passed: false, xp_earned: 0, expected: 'hello', actual: 'world', stderr: '',
    })
    render(
      <CodePlayground expectedOutput="hello" exerciseSlug="bash/script-basics" exerciseIndex={0} />
    )
    fireEvent.click(screen.getByRole('button', { name: /check/i }))
    await waitFor(() => expect(screen.getByText(/Not quite/)).toBeInTheDocument())
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('world')).toBeInTheDocument()
  })
})

// ─── Reference page ───────────────────────────────────────────────────────────
import Reference from '../../pages/Reference'

function renderReference(slug = 'linux') {
  return render(
    <MemoryRouter initialEntries={[`/reference/${slug}`]}>
      <Routes>
        <Route path="/reference/:moduleSlug" element={<Reference />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('Reference page', () => {
  it('shows skeleton while fetch is pending', () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    const { container } = renderReference()
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
  })

  it('shows not-found message on 404', async () => {
    global.fetch.mockResolvedValue({ status: 404 })
    renderReference()
    await waitFor(() =>
      expect(screen.getByText(/no reference card available/i)).toBeInTheDocument()
    )
  })

  it('renders back-link and markdown content after successful fetch', async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ content: '# Linux Reference\n\nKey commands here.' }),
    })
    renderReference()
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /← back to module/i })).toBeInTheDocument()
    )
    expect(screen.getByText('Key commands here.')).toBeInTheDocument()
  })

  it('renders filter input after content loads', async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ content: '# Linux\n\n## File Management\n\nls command\n\n## Networking\n\ncurl command' }),
    })
    renderReference()
    await waitFor(() => screen.getByPlaceholderText(/filter commands/i))
  })

  it('shows no matching sections when filter has no matches', async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ content: '# Linux\n\n## File Management\n\nls command' }),
    })
    renderReference()
    await waitFor(() => screen.getByPlaceholderText(/filter commands/i))
    fireEvent.change(screen.getByPlaceholderText(/filter commands/i), { target: { value: 'zzznomatch' } })
    await waitFor(() => expect(screen.getByText(/no matching sections/i)).toBeInTheDocument())
  })
})

// ─── Drill page ───────────────────────────────────────────────────────────────
import Drill from '../../pages/Drill'

const MOCK_DRILL_QUESTION = {
  id: 99, question: 'What does ls -la do?',
  options: ['List files', 'Delete files', 'Copy files', 'Move files'],
  correct_index: 0, explanation: 'ls -la lists all files with details.',
  lesson_title: 'Filesystem', module_title: 'Linux',
}

describe('Drill page', () => {
  it('shows loading while fetchWeakAreaQuestions is pending', () => {
    fetchWeakAreaQuestions.mockReturnValue(new Promise(() => {}))
    render(<MemoryRouter><Drill /></MemoryRouter>)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows no-weak-areas message when fetch returns empty list', async () => {
    fetchWeakAreaQuestions.mockResolvedValue([])
    render(<MemoryRouter><Drill /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no weak areas yet/i)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /back to stats/i })).toBeInTheDocument()
  })

  it('shows question count and Start Drill button when weak questions exist', async () => {
    fetchWeakAreaQuestions.mockResolvedValue([MOCK_DRILL_QUESTION])
    render(<MemoryRouter><Drill /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('button', { name: /start drill/i })).toBeInTheDocument())
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})

// ─── Projects page ────────────────────────────────────────────────────────────
import Projects from '../../pages/Projects'

const MOCK_PROJECTS_LIST = [
  {
    slug: 'containerize-python-app',
    title: 'Containerize a Python App',
    description: 'Build a Python web app.',
    difficulty: 'intermediate',
    modules: ['Docker', 'Python'],
    steps_done: 0,
    steps_total: 4,
  },
]

describe('Projects page', () => {
  it('shows loading state while fetch is pending', () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    render(<MemoryRouter><Projects /></MemoryRouter>)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders project title after fetch resolves', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECTS_LIST) })
    render(<MemoryRouter><Projects /></MemoryRouter>)
    await waitFor(() =>
      expect(screen.getByText('Containerize a Python App')).toBeInTheDocument()
    )
  })

  it('renders difficulty badge', async () => {
    global.fetch.mockResolvedValue({ json: () => Promise.resolve(MOCK_PROJECTS_LIST) })
    render(<MemoryRouter><Projects /></MemoryRouter>)
    await waitFor(() => screen.getByText('Containerize a Python App'))
    expect(screen.getByText('intermediate')).toBeInTheDocument()
  })
})
