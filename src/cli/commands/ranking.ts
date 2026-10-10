import chalk from 'chalk'
import ora from 'ora'
import { GitCollector } from '../../git/git-collector'
import { GitParser } from '../../git/git-parser'
import { AnalyzeOptions } from '../index'
import { buildAuthorFilter } from '../common/author-filter'
import { GitLogOptions, AuthorStats, AuthorRankingResult } from '../../types/git-types'
import { ensureCommitSamples } from '../common/commit-guard'
import { printAuthorRanking } from './report/ranking-printer'

export interface RankingOptions extends AnalyzeOptions {
  author?: string // 指定统计某个作者
  excludeAuthors?: string // 排除某些作者（逗号分隔）
  merge?: boolean // 合并同名不同邮箱的作者
}

/**
 * 排名执行器，负责统计所有提交者的996指数并排序
 */
export class RankingExecutor {
  /**
   * 执行排名分析的主流程
   */
  static async execute(path: string, options: RankingOptions): Promise<void> {
    try {
      const collector = new GitCollector()

      // 计算时间范围（复用 analyze 命令的逻辑）
      const { since: effectiveSince, until: effectiveUntil } = await resolveTimeRange({
        collector,
        path,
        options,
      })

      console.log(chalk.blue('🔍 分析仓库:'), path || process.cwd())
      if (effectiveSince && effectiveUntil) {
        console.log(chalk.blue('📅 时间范围:'), `${effectiveSince} 至 ${effectiveUntil}`)
      } else {
        console.log(chalk.blue('📅 时间范围:'), '所有时间')
      }

      // 处理排除作者列表
      const excludeList = options.excludeAuthors ? options.excludeAuthors.split(',').map((a) => a.trim()) : []
      if (excludeList.length > 0) {
        console.log(chalk.blue('🚫 排除作者:'), excludeList.join(', '))
      }

      // 处理指定作者
      if (options.author) {
        console.log(chalk.blue('👤 指定作者:'), options.author)
      }

      console.log()

      // 构建基础的 Git 采集参数
      const collectOptions: GitLogOptions = {
        path,
        since: effectiveSince,
        until: effectiveUntil,
        silent: false,
        authorPattern: undefined,
      }

      // 检查 commit 样本量
      const hasEnoughCommits = await ensureCommitSamples(collector, collectOptions, 20, '排名分析')
      if (!hasEnoughCommits) {
        return
      }

      // 创建进度指示器
      const spinner = ora('📦 获取所有提交者...').start()

      // 使用通用过滤模块获得匹配的作者正则并信息
      let authorPattern: string | undefined
      let allAuthors = await collector.getAllAuthors(collectOptions)
      try {
        const built = await buildAuthorFilter(collector, path, effectiveSince, effectiveUntil, options)
        authorPattern = built.pattern
        built.infoLines.forEach((l) => console.log(l))
        if (built.infoLines.length) console.log()
        // 若构建后的 pattern 对应的是一组作者，则我们将 allAuthors 缩减为匹配集合用于单独统计
        if (authorPattern) {
          const regex = new RegExp(authorPattern, 'i')
          allAuthors = allAuthors.filter((a) => regex.test(a.email) || regex.test(a.name))
        }
      } catch (e) {
        spinner.fail(`作者过滤失败: ${(e as Error).message}`)
        return
      }

      // 按邮箱去重：同一邮箱可能以多个 committer 名称出现（如 jinxin / jinxin3 共用同一邮箱），
      // 若按 (name|email) 逐条采集会被重复统计。这里每个邮箱只保留一条，并以提交数最多的名称作为展示名，
      // 累计提交数，避免后续 --merge 把重复行相加导致总数翻倍。
      allAuthors = dedupeAuthorsByEmail(allAuthors)

      if (allAuthors.length === 0) {
        spinner.fail('作者过滤后无提交者')
        return
      }

      spinner.text = `匹配到 ${allAuthors.length} 位提交者，正在分析...`
      spinner.render()

      // 如果启用合并，先构建合并映射表
      let mergeMap: Map<string, { name: string; email: string }> | undefined
      if (options.merge) {
        const { AuthorMerger } = await import('../../core/author-merger')
        const merger = new AuthorMerger()
        mergeMap = merger.getMergeMap(
          allAuthors.map((a) => ({ name: a.name, email: a.email, commitCount: a.commitCount })),
        )

        if (mergeMap.size > 0) {
          console.log(chalk.blue('🔄 启用作者合并:'), `将合并 ${mergeMap.size} 个身份`)
        }
      }

      // 并行分析每个作者的数据
      const authorStatsPromises = allAuthors.map(async (author) => {
        try {
          // 收集作者数据
          const rawData = await collector.collectForAuthor(collectOptions, author)

          // 如果提交数太少，跳过该作者
          if (rawData.totalCommits < 5) {
            return null
          }

          // 解析数据
          const parsedData = GitParser.parseGitData(rawData, undefined, effectiveSince, effectiveUntil)

          // 计算 996 指数
          const result = GitParser.calculate996Index(parsedData)

          const stats: AuthorStats = {
            name: author.name,
            email: author.email,
            totalCommits: rawData.totalCommits,
            index996: result.index996,
            index996Str: result.index996Str,
            overTimeRadio: result.overTimeRadio,
            workingHourCommits: parsedData.workHourPl[0].count,
            overtimeCommits: parsedData.workHourPl[1].count,
            weekdayCommits: parsedData.workWeekPl[0].count,
            weekendCommits: parsedData.workWeekPl[1].count,
          }

          return stats
        } catch (error) {
          // 如果某个作者分析失败，记录但不中断整体流程
          console.warn(chalk.yellow(`\n⚠️  无法分析作者 ${author.name}: ${(error as Error).message}`))
          return null
        }
      })

      const authorStatsResults = await Promise.all(authorStatsPromises)
      let authorStats = authorStatsResults.filter((stats): stats is AuthorStats => stats !== null)

      if (authorStats.length === 0) {
        spinner.fail('没有可分析的提交者数据')
        return
      }

      // 如果启用合并，合并同名作者的统计数据
      if (options.merge && mergeMap && mergeMap.size > 0) {
        authorStats = mergeAuthorStats(authorStats, mergeMap)
        console.log(chalk.green(`✓ 已合并，最终作者数: ${authorStats.length}`))
      }

      // 按 996 指数降序排序（卷王排行）
      authorStats.sort((a, b) => b.index996 - a.index996)

      spinner.succeed('分析完成！')
      console.log()

      // 构建排名结果
      const rankingResult: AuthorRankingResult = {
        authors: authorStats,
        totalAuthors: authorStats.length,
        timeRange: {
          since: effectiveSince,
          until: effectiveUntil,
        },
      }

      // 打印排名结果
      printAuthorRanking(rankingResult, options)
    } catch (error) {
      console.error(chalk.red('❌ 排名分析失败:'), (error as Error).message)
      process.exit(1)
    }
  }
}

/**
 * 合并同名作者的统计数据
 */
function mergeAuthorStats(
  stats: AuthorStats[],
  mergeMap: Map<string, { name: string; email: string }>
): AuthorStats[] {
  const merged = new Map<string, AuthorStats>()

  for (const stat of stats) {
    // 查找是否需要合并到另一个主身份
    const primaryIdentity = mergeMap.get(stat.email.toLowerCase())
    const targetEmail = primaryIdentity ? primaryIdentity.email : stat.email
    const targetName = primaryIdentity ? primaryIdentity.name : stat.name

    const existing = merged.get(targetEmail.toLowerCase())

    if (existing) {
      // 合并到已有统计
      existing.totalCommits += stat.totalCommits
      existing.workingHourCommits += stat.workingHourCommits
      existing.overtimeCommits += stat.overtimeCommits
      existing.weekdayCommits += stat.weekdayCommits
      existing.weekendCommits += stat.weekendCommits

      // 重新计算 996 指数（加权平均）
      const totalCommits = existing.totalCommits
      existing.index996 =
        (existing.index996 * (totalCommits - stat.totalCommits) + stat.index996 * stat.totalCommits) / totalCommits
      existing.index996Str = existing.index996.toFixed(2)

      // 重新计算加班占比，保持与 calculate996Index 相同的百分比逻辑（包含周末修正）
      const y = existing.workingHourCommits // 工作时间提交
      const x = existing.overtimeCommits // 加班时间提交
      const m = existing.weekdayCommits // 工作日提交数
      const n = existing.weekendCommits // 周末提交数
      if (m + n > 0 && y + x > 0) {
        const overTimeAmendCount = Math.round(x + (y * n) / (m + n))
        existing.overTimeRadio = Math.ceil((overTimeAmendCount / (y + x)) * 100) // 百分比数值（与其他路径统一）
      }
    } else {
      // 新增统计（使用主身份的名称和邮箱）
      merged.set(targetEmail.toLowerCase(), {
        ...stat,
        name: targetName,
        email: targetEmail,
      })
    }
  }

  return Array.from(merged.values())
}

/**
 * 按邮箱去重提交者列表
 * 同一个邮箱可能对应多个 committer 名称（例如同一人换了电脑/配置导致名称不同），
 * 这些身份在 git 中指向同一批提交。若逐条采集会被重复统计。
 * 这里每个邮箱只保留一条记录，并把提交数累加，展示名取提交数最多的那个名称。
 */
function dedupeAuthorsByEmail(
  authors: Array<{ name: string; email: string; commitCount: number }>,
): Array<{ name: string; email: string; commitCount: number }> {
  const byEmail = new Map<string, { name: string; email: string; commitCount: number }>()

  for (const a of authors) {
    const key = a.email.toLowerCase()
    const existing = byEmail.get(key)
    if (!existing) {
      byEmail.set(key, { name: a.name, email: a.email, commitCount: a.commitCount })
      continue
    }

    const prevCount = existing.commitCount
    existing.commitCount += a.commitCount
    // 保留提交数更多的名称作为展示名
    if (a.commitCount > prevCount) {
      existing.name = a.name
    }
  }

  return Array.from(byEmail.values())
}

/**
 * 解析时间范围（复用 analyze 命令的逻辑）
 */
async function resolveTimeRange({
  collector,
  path,
  options,
}: {
  collector: GitCollector
  path: string
  options: RankingOptions
}): Promise<{ since?: string; until?: string }> {
  if (options.allTime) {
    return {}
  }

  // 处理 --year 参数
  if (options.year) {
    const yearRange = parseYearOption(options.year)
    if (yearRange) {
      return {
        since: yearRange.since,
        until: yearRange.until,
      }
    }
  }

  if (options.since || options.until) {
    return {
      since: options.since,
      until: options.until,
    }
  }

  // 默认回溯最后一次提交的365天
  try {
    const lastCommitDate = await collector.getLastCommitDate({ 
      path,
      since: '1970-01-01',
      until: '2100-01-01',
      silent: true,
      authorPattern: undefined,
    })
    if (lastCommitDate) {
      const untilDate = new Date(lastCommitDate)
      const sinceDate = new Date(untilDate)
      sinceDate.setDate(sinceDate.getDate() - 365)

      return {
        since: sinceDate.toISOString().split('T')[0],
        until: untilDate.toISOString().split('T')[0],
      }
    }
  } catch {
    // 忽略错误，使用默认值
  }

  // 默认最近一年
  const until = new Date()
  const since = new Date(until)
  since.setDate(since.getDate() - 365)

  return {
    since: since.toISOString().split('T')[0],
    until: until.toISOString().split('T')[0],
  }
}

/**
 * 解析 --year 参数
 */
function parseYearOption(yearStr: string): { since: string; until: string } | null {
  yearStr = yearStr.trim()

  // 匹配年份范围格式：2023-2025
  const rangeMatch = yearStr.match(/^(\d{4})-(\d{4})$/)
  if (rangeMatch) {
    const startYear = parseInt(rangeMatch[1], 10)
    const endYear = parseInt(rangeMatch[2], 10)

    if (startYear < 1970 || endYear < 1970 || startYear > endYear) {
      console.error(chalk.red('❌ 年份格式错误: 起始年份不能大于结束年份，且年份必须 >= 1970'))
      process.exit(1)
    }

    return {
      since: `${startYear}-01-01`,
      until: `${endYear}-12-31`,
    }
  }

  // 匹配单年格式：2025
  const singleMatch = yearStr.match(/^(\d{4})$/)
  if (singleMatch) {
    const year = parseInt(singleMatch[1], 10)

    if (year < 1970) {
      console.error(chalk.red('❌ 年份格式错误: 年份必须 >= 1970'))
      process.exit(1)
    }

    return {
      since: `${year}-01-01`,
      until: `${year}-12-31`,
    }
  }

  console.error(chalk.red('❌ 年份格式错误: 请使用 YYYY 格式（如 2025）或 YYYY-YYYY 格式（如 2023-2025）'))
  process.exit(1)
}
