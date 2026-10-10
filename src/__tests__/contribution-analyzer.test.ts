import { ContributionAnalyzer } from '../core/contribution-analyzer'

describe('ContributionAnalyzer - 去噪/分类/归一化', () => {
  const sample = [
    'COMMIT',
    'h1',
    'jinxin',
    'jinxin@dreame.tech',
    '2026-01-01',
    'feat: add login',
    '10\t2\tsrc/login.dart',
    'COMMIT',
    'h2',
    'jinxin3',
    'jinxin@dreame.tech',
    '2026-01-02',
    'fix: typo in login',
    '5\t1\tsrc/login.dart',
    'COMMIT',
    'h3',
    'alice',
    'alice@x.com',
    '2026-01-03',
    'format code',
    '100\t100\tsrc/big.dart',
    'COMMIT',
    'h4',
    'bob',
    'bob@x.com',
    '2026-01-04',
    'chore: bump deps',
    '50\t10\tpubspec.lock',
  ].join('\n')

  it('parseNumstat 解析出提交与文件分类', () => {
    const commits = ContributionAnalyzer.parseNumstat(sample)
    expect(commits.length).toBe(4)
    // h4 的 pubspec.lock 应被识别为 lock
    const bob = commits[3]
    expect(bob.files[0][3]).toBe('lock')
  })

  it('同邮箱不同名称变体合并为单一身份（提交累加）', () => {
    const rows = ContributionAnalyzer.analyzeCommits(ContributionAnalyzer.parseNumstat(sample), {})
    // jinxin 与 jinxin3 共用 jinxin@dreame.tech，应合并为一行
    const jinxinRows = rows.filter((r) => r.email === 'jinxin@dreame.tech')
    expect(jinxinRows.length).toBe(1)
    const j = jinxinRows[0]
    // 两次提交的源码改动累加：10+2 + 5+1
    expect(j.commits).toBe(2)
    expect(j.effAdded).toBe(15)
    expect(j.effDeleted).toBe(3)
  })

  it('不同邮箱同名称变体（去数字）合并为单一身份', () => {
    const raw = [
      'COMMIT', 'h1', 'marko', 'marko@a.com', '2026-01-01', 'feat: x', '5\t1\tsrc/a.dart',
      'COMMIT', 'h2', 'marko2', 'marko@b.com', '2026-01-02', 'fix: y', '3\t1\tsrc/b.dart',
    ].join('\n')
    const rows = ContributionAnalyzer.analyzeCommits(ContributionAnalyzer.parseNumstat(raw), {})
    expect(rows.length).toBe(1)
    const m = rows[0]
    expect(m.commits).toBe(2)
    expect(m.effAdded).toBe(8)
  })

  it('格式化/生成/依赖类提交的源码行计入低价值行，不计入有效改动', () => {
    const rows = ContributionAnalyzer.analyzeCommits(ContributionAnalyzer.parseNumstat(sample), {})
    const alice = rows.find((r) => r.name === 'alice')!
    // 100/100 的源码改动来自 format 提交 → 低价值行，有效改动为 0，且不算有效提交
    expect(alice.lowValueLines).toBe(200)
    expect(alice.effAdded).toBe(0)
    expect(alice.effDeleted).toBe(0)
    expect(alice.effCommits).toBe(0)
  })

  it('lock 文件行数计入噪音，不计入有效改动', () => {
    const rows = ContributionAnalyzer.analyzeCommits(ContributionAnalyzer.parseNumstat(sample), {})
    const bob = rows.find((r) => r.name === 'bob')!
    // 50/10 的锁文件改动 → 全部计入噪音，有效改动为 0
    expect(bob.effAdded).toBe(0)
    expect(bob.effDeleted).toBe(0)
    expect(bob.noiseRatio).toBeGreaterThan(0.99)
  })

  it('exclude-authors 按子串过滤作者', () => {
    const rows = ContributionAnalyzer.analyzeCommits(ContributionAnalyzer.parseNumstat(sample), {
      excludeAuthors: 'alice',
    })
    const names = rows.map((r) => r.name)
    // alice 应被排除
    expect(names).not.toContain('alice')
    // jinxin 与 jinxin3 同邮箱合并为单一身份（显示名 last-write-wins 可能为 jinxin3），
    // 用邮箱判定该作者未被误排除更稳健
    const jinxinRows = rows.filter((r) => r.email === 'jinxin@dreame.tech')
    expect(jinxinRows.length).toBe(1)
  })

  it('贡献分归一化且无 NaN，按分数降序', () => {
    const rows = ContributionAnalyzer.analyzeCommits(ContributionAnalyzer.parseNumstat(sample), {})
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(Number.isNaN(r.score)).toBe(false)
      expect(r.score).toBeGreaterThanOrEqual(0)
    }
    // 最高分不超过 100
    expect(rows[0].score).toBeLessThanOrEqual(100)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score)
    }
  })
})
