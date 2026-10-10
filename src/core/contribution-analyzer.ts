/**
 * 贡献质量分析核心（方案 B）
 * 去噪 / 分类 / 归一化：把「代码行数」替换为多维度贡献分。
 * 纯逻辑（parseNumstat / analyzeCommits）不依赖 git，便于单测；
 * analyze() 负责调用 GitCollector 取数。
 */
import { GitCollector } from '../git/git-collector'
import {
  fileCategory,
  commitType,
  topModule,
  nameKey,
  WEIGHTS,
  LOW_VALUE_TYPES,
  NON_EFFECTIVE_COMMIT_TYPES,
} from './contribution-config'
import { GitLogOptions } from '../types/git-types'

export interface QualityOptions {
  since?: string
  until?: string
  author?: string
  excludeAuthors?: string
  endHour?: string
  survival?: boolean
}

export interface QualityRow {
  email: string
  name: string
  commits: number
  effCommits: number
  rawAdded: number
  rawDeleted: number
  effAdded: number
  effDeleted: number
  effChurn: number
  lowValueLines: number
  noiseRatio: number
  reverts: number
  activeDays: number
  modules: number
  survivalLines: number
  typeCounts: Record<string, number>
  score: number
}

interface CommitEntry {
  name: string
  email: string
  date: string
  msg: string
  files: Array<[number, number, string, string]>
}

interface Acc {
  name: string
  commits: number
  effCommits: number
  rawAdded: number
  rawDeleted: number
  effAdded: number
  effDeleted: number
  noiseLines: number
  lowValueLines: number
  reverts: number
  typeCounts: Record<string, number>
  activeDays: Set<string>
  modules: Set<string>
  emails: Set<string>
  primaryEmail: string
  maxCommits: number
  survivalLines: number
}

export class ContributionAnalyzer {
  /** 解析 `git log --numstat` 的自定义格式输出为提交列表 */
  static parseNumstat(raw: string): CommitEntry[] {
    const commits: CommitEntry[] = []
    const lines = raw.split('\n')
    const n = lines.length
    let i = 0
    while (i < n) {
      if (lines[i] === 'COMMIT') {
        i++
        i++ // 跳过 hash 行
        const name = (lines[i++] ?? '').trim()
        const email = (lines[i++] ?? '').trim().toLowerCase()
        const date = (lines[i++] ?? '').trim()
        const msg = (lines[i++] ?? '').trim()
        const files: CommitEntry['files'] = []
        while (i < n && lines[i] !== 'COMMIT') {
          const seg = (lines[i++] ?? '').split('\t')
          // 提交之间 git 会插入空行作为分隔；字段不足 3 个（空行/异常行）直接跳过，
          // 切勿再次 i++，否则会越过紧随其后的 COMMIT 分隔符导致整段被吞并成一个提交
          if (seg.length < 3) {
            continue
          }
          const addedS = seg[0]
          const deletedS = seg[1]
          const p = seg[2] ?? ''
          let added = 0
          let deleted = 0
          if (addedS !== '-' && deletedS !== '-') {
            added = addedS !== undefined && /^\d+$/.test(addedS) ? parseInt(addedS, 10) : 0
            deleted = deletedS !== undefined && /^\d+$/.test(deletedS) ? parseInt(deletedS, 10) : 0
          }
          files.push([added, deleted, p, fileCategory(p)])
        }
        commits.push({ name, email, date, msg, files })
      } else {
        i++
      }
    }
    return commits
  }

  /** 纯函数：聚合 + 合并同人 + 归一化打分 */
  static analyzeCommits(
    commits: CommitEntry[],
    options: QualityOptions,
    survival?: Map<string, number>,
  ): QualityRow[] {
    const exclude = (options.excludeAuthors ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const include = (options.author ?? '').trim().toLowerCase()

    const authors = new Map<string, Acc>()

    for (const c of commits) {
      if (exclude.some((e) => c.name.toLowerCase().includes(e) || c.email.includes(e))) continue
      if (include && !(c.name.toLowerCase().includes(include) || c.email.includes(include))) continue

      let a = authors.get(c.email)
      if (!a) {
        a = {
          name: c.name,
          commits: 0,
          effCommits: 0,
          rawAdded: 0,
          rawDeleted: 0,
          effAdded: 0,
          effDeleted: 0,
          noiseLines: 0,
          lowValueLines: 0,
          reverts: 0,
          typeCounts: {},
          activeDays: new Set<string>(),
          modules: new Set<string>(),
          emails: new Set<string>(),
          primaryEmail: c.email,
          maxCommits: 0,
          survivalLines: 0,
        }
        authors.set(c.email, a)
      }

      a.name = c.name
      a.commits += 1
      const ctype = commitType(c.msg)
      a.typeCounts[ctype] = (a.typeCounts[ctype] ?? 0) + 1
      if (ctype === 'revert') a.reverts += 1
      a.activeDays.add(c.date)

      let hasSource = false
      for (const [added, deleted, p, cat] of c.files) {
        a.rawAdded += added
        a.rawDeleted += deleted
        if (cat !== 'source') {
          a.noiseLines += added + deleted
          continue
        }
        hasSource = true
        a.modules.add(topModule(p))
        if (LOW_VALUE_TYPES.has(ctype)) {
          a.lowValueLines += added + deleted
        } else {
          a.effAdded += added
          a.effDeleted += deleted
        }
      }
      if (hasSource && !NON_EFFECTIVE_COMMIT_TYPES.has(ctype)) {
        a.effCommits += 1
      }
    }

    // 按「去数字后的名字」合并同人多邮箱（jinxin / jinxin3 等）
    const merged = new Map<string, Acc>()
    for (const [email, a] of authors) {
      const key = nameKey(a.name) || email
      const existing = merged.get(key)
      if (!existing) {
        a.emails.add(email)
        a.primaryEmail = email
        a.maxCommits = a.commits
        a.survivalLines = survival?.get(email) ?? 0
        merged.set(key, a)
      } else {
        existing.emails.add(email)
        existing.commits += a.commits
        existing.effCommits += a.effCommits
        existing.rawAdded += a.rawAdded
        existing.rawDeleted += a.rawDeleted
        existing.effAdded += a.effAdded
        existing.effDeleted += a.effDeleted
        existing.noiseLines += a.noiseLines
        existing.lowValueLines += a.lowValueLines
        existing.reverts += a.reverts
        existing.survivalLines += survival?.get(email) ?? 0
        for (const [t, cnt] of Object.entries(a.typeCounts)) {
          existing.typeCounts[t] = (existing.typeCounts[t] ?? 0) + cnt
        }
        a.activeDays.forEach((d) => existing.activeDays.add(d))
        a.modules.forEach((m) => existing.modules.add(m))
        if (a.commits > existing.maxCommits) {
          existing.name = a.name
          existing.primaryEmail = email
          existing.maxCommits = a.commits
        }
      }
    }

    const list = Array.from(merged.values())
    const maxEffCommits = Math.max(1, ...list.map((a) => a.effCommits))
    const maxEffChurn = Math.max(1, ...list.map((a) => a.effAdded + a.effDeleted))
    const maxDays = Math.max(1, ...list.map((a) => a.activeDays.size))
    const maxModules = Math.max(1, ...list.map((a) => a.modules.size))

    const rows: QualityRow[] = list.map((a) => {
      const effChurn = a.effAdded + a.effDeleted
      const rawTotal = a.rawAdded + a.rawDeleted
      const noiseRatio = rawTotal > 0 ? (a.noiseLines + a.lowValueLines) / rawTotal : 0
      const score =
        WEIGHTS.effCommits * (a.effCommits / maxEffCommits) +
        WEIGHTS.effChurn * (effChurn / maxEffChurn) +
        WEIGHTS.activeDays * (a.activeDays.size / maxDays) +
        WEIGHTS.modules * (a.modules.size / maxModules)
      return {
        email: a.primaryEmail,
        name: a.name,
        commits: a.commits,
        effCommits: a.effCommits,
        rawAdded: a.rawAdded,
        rawDeleted: a.rawDeleted,
        effAdded: a.effAdded,
        effDeleted: a.effDeleted,
        effChurn,
        lowValueLines: a.lowValueLines,
        noiseRatio,
        reverts: a.reverts,
        activeDays: a.activeDays.size,
        modules: a.modules.size,
        survivalLines: a.survivalLines,
        typeCounts: a.typeCounts,
        score: Math.round(score * 1000) / 10,
      }
    })
    rows.sort((x, y) => y.score - x.score)
    return rows
  }

  /** 完整流程：取数 → 解析 → 合并 → 打分 */
  static async analyze(path: string, options: QualityOptions): Promise<QualityRow[]> {
    const collector = new GitCollector()
    const gitOpts: GitLogOptions = {
      path,
      since: options.since,
      until: options.until,
      authorPattern: undefined,
      silent: true,
    }
    const raw = await collector.getNumstatLog(gitOpts)
    const commits = ContributionAnalyzer.parseNumstat(raw)
    const survival = options.survival ? await collector.getSurvivalLines(path) : undefined
    return ContributionAnalyzer.analyzeCommits(commits, options, survival)
  }
}
