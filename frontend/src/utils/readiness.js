export function readinessColor(score) {
  if (score >= 75) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 40) return 'text-amber-500 dark:text-amber-400'
  return 'text-red-500 dark:text-red-400'
}
