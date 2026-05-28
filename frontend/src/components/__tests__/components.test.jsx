import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

// Stub fetch globally — components that call the API should not fire in unit tests
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
