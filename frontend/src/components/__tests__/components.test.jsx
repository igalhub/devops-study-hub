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

// Mock curriculumStore — prevents real fetch calls from Review, Notes, Quiz, CodePlayground,
// InterviewPrep
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
}))
import {
  fetchReviewQueue, logAttempt, fetchQuiz, fetchNote, saveNote,
  fetchInterviewQuestions, evaluateAnswerWithSrs, selfGradeInterview,
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
