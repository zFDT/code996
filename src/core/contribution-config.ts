/**
 * 贡献质量分析共享配置（方案 B）
 * 分类正则、权重与 core 判据集中在此，供 ContributionAnalyzer 与 GitCollector 复用，
 * 与方案 A（scripts/author_quality.py）保持完全一致。
 */

export const LOCK_PATTERNS: RegExp[] = [
  new RegExp('pubspec\\.lock$'),
  new RegExp('package-lock\\.json$'),
  new RegExp('yarn\\.lock$'),
  new RegExp('pnpm-lock\\.yaml$'),
  new RegExp('composer\\.lock$'),
  new RegExp('Gemfile\\.lock$'),
  new RegExp('go\\.sum$'),
]

export const GENERATED_PATTERNS: RegExp[] = [
  new RegExp('\\.g\\.dart$'),
  new RegExp('\\.freezed\\.dart$'),
  new RegExp('\\.pb\\.dart$'),
  new RegExp('\\.pbjson\\.dart$'),
  new RegExp('\\.pb\\.go$'),
  new RegExp('\\.pb\\.cc$'),
  new RegExp('\\.pb\\.h$'),
  new RegExp('\\.mocks\\.dart$'),
  new RegExp('\\.generated\\.'),
  new RegExp('\\.gen\\.ts$'),
  new RegExp('\\.min\\.js$'),
  new RegExp('\\.min\\.css$'),
]

export const VENDOR_DIRS: RegExp[] = [
  new RegExp('(?:^|/)build/'),
  new RegExp('(?:^|/)\\.dart_tool/'),
  new RegExp('(?:^|/)node_modules/'),
  new RegExp('(?:^|/)vendor/'),
  new RegExp('(?:^|/)\\.git/'),
]

/** 提交类型（顺序即优先级；先命中先返回） */
export const MSG_TYPES: Array<[string, RegExp]> = [
  ['revert', new RegExp('^\\s*revert\\b')],
  ['deps', new RegExp('\\b(?:deps?|dependencies|dependenc|upgrade|bump|pub (?:get|upgrade)|packages?)\\b')],
  ['format', new RegExp('\\b(?:format|lint|fmt|prettier|code ?style|style:|reformat|整理|对齐)\\b')],
  ['generated', new RegExp('\\b(?:generated|auto-?generated|codegen|gen:)\\b')],
  ['chore', new RegExp('\\b(?:chore|ci\\b|build\\(deps\\))\\b')],
  ['test', new RegExp('\\b(?:test|spec)\\b')],
  ['fix', new RegExp('\\b(?:fix|bug|hotfix)\\b')],
  ['refactor', new RegExp('\\brefactor\\b')],
  ['feat', new RegExp('\\b(?:feat|feature)\\b')],
  ['docs', new RegExp('\\b(?:docs?|readme|document)\\b')],
]

/** 即便触及源码也视为低价值、不计入「有效提交」的类型 */
export const NON_EFFECTIVE_COMMIT_TYPES = new Set<string>(['format', 'generated'])

/** 低价值提交类型：其源码改动不计入「有效改动量」 */
export const LOW_VALUE_TYPES = new Set<string>(['format', 'generated', 'chore', 'deps'])

/** 归一化权重（总和为 1） */
export const WEIGHTS = {
  effCommits: 0.4,
  effChurn: 0.3,
  activeDays: 0.2,
  modules: 0.1,
}

export function fileCategory(path: string): 'lock' | 'generated' | 'vendor' | 'source' {
  if (LOCK_PATTERNS.some((re) => re.test(path))) return 'lock'
  if (GENERATED_PATTERNS.some((re) => re.test(path))) return 'generated'
  if (VENDOR_DIRS.some((re) => re.test(path))) return 'vendor'
  return 'source'
}

export function commitType(message: string): string {
  const m = message.toLowerCase()
  for (const [t, re] of MSG_TYPES) {
    if (re.test(m)) return t
  }
  return 'other'
}

export function topModule(path: string): string {
  const p = path.split('?')[0]
  const parts = p.split('/').filter(Boolean)
  return parts.length > 0 ? parts[0]! : '(root)'
}

/** 去数字 + 小写，用于合并 jinxin / jinxin3、Marko / Marko 等同人多邮箱 */
export function nameKey(name: string): string {
  const k = name.toLowerCase().replace(/\d+/g, '').trim()
  return k || name.toLowerCase()
}
