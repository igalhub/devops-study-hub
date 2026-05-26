export default function ThemeToggle({ dark, toggle }) {
  return (
    <button
      onClick={toggle}
      className="text-xs px-3 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
    >
      {dark ? '☀ Light' : '☾ Dark'}
    </button>
  )
}
