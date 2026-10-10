import chalk from 'chalk'
import ora from 'ora'
import { GitCollector } from '../../git/git-collector'
import { ContributionAnalyzer, QualityOptions, QualityRow } from '../../core/contribution-analyzer'
import { AnalyzeOptions } from '../index'
import { printGlobalNotices } from '../common/notices'
import { GitLogOptions } from '../../types/git-types'

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

/** 解析时间范围：与 analyze 命令一致（--all-time 取全部；否则默认最近一年） */
async function resolveQualityRange(
  collector: GitCollector,
  path: string,
  options: AnalyzeOptions,
): Promise<{ since?: string; until?: string }> {
  if (options.allTime) return {}
  if (options.since || options.until) return { since: options.since, until: options.until }
  try {
    const last = await collector.getLastCommitDate({ path, silent: true } as GitLogOptions)
    if (last) {
      const parts = last.split('-').map(Number)
      const y = parts[0]
      const m = parts[1]
      const d = parts[2]
      if (y !== undefined && m !== undefined && d !== undefined) {
        const dt = new Date(y, m - 1, d - 365)
        const fmt = (x: Date) =>
          `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
        return { since: fmt(dt), until: last }
      }
    }
  } catch {
    // 忽略，退化为全量
  }
  return {}
}

function printQualityTable(rows: QualityRow[]): void {
  console.log()
  console.log(
    `${chalk.bold('贡献分')}  ${chalk.bold('作者')}  ${chalk.bold('提交')}  ${chalk.bold('有效提交')}  ${chalk.bold('原始+/−')}  ${chalk.bold('有效改动')}  ${chalk.bold('低价值行')}  ${chalk.bold('噪音%')}  ${chalk.bold('活跃天')}  ${chalk.bold('模块')}  ${chalk.bold('rev')}`,
  )
  console.log(chalk.gray('─'.repeat(96)))
  for (const r of rows) {
    const rawNet = `${chalk.green('+' + fmtInt(r.rawAdded))}/${chalk.red('−' + fmtInt(r.rawDeleted))}`
    const surv = r.survivalLines ? chalk.cyan(`  存活行=${fmtInt(r.survivalLines)}`) : ''
    console.log(
      `${String(r.score).padStart(6)}  ${r.name.slice(0, 13).padEnd(13)} ${String(r.commits).padStart(5)} ` +
        `${String(r.effCommits).padStart(7)} ${rawNet.padEnd(28)} ${fmtInt(r.effChurn).padStart(11)} ` +
        `${fmtInt(r.lowValueLines).padStart(9)} ${(r.noiseRatio * 100).toFixed(1).padStart(5)}% ` +
        `${String(r.activeDays).padStart(5)} ${String(r.modules).padStart(4)} ${String(r.reverts).padStart(4)}` +
        surv,
    )
  }
  console.log()
  console.log(
    chalk.gray(
      '指标: 原始+/−=全量增删行(含依赖/生成) | 有效改动=仅源码且非格式化/生成/依赖的真实增删(写+删都计) | 低价值行=格式化/生成/依赖类提交的源码行',
    ),
  )
  console.log(
    chalk.gray('贡献分 = 有效提交×0.4 + 有效改动×0.3 + 活跃天×0.2 + 模块数×0.1（按各维度最大值归一化）'),
  )
}

/**
 * 贡献质量执行器：去噪 / 分类 / 归一化的研发产出统计（替代单一行数口径）
 */
export class QualityExecutor {
  static async execute(path: string, options: AnalyzeOptions): Promise<void> {
    try {
      const collector = new GitCollector()
      const { since, until } = await resolveQualityRange(collector, path, options)

      console.log(chalk.blue('🔍 贡献质量分析:'), path || process.cwd())
      if (since || until) {
        console.log(chalk.blue('📅 时间范围:'), `${since ?? '最早'} 至 ${until ?? '最新'}`)
      } else {
        console.log(chalk.blue('📅 时间范围:'), '所有时间')
      }
      if (options.excludeAuthors) {
        console.log(chalk.blue('🚫 排除作者:'), options.excludeAuthors)
      }

      const qOptions: QualityOptions = {
        since,
        until,
        author: options.author,
        excludeAuthors: options.excludeAuthors,
        survival: (options as Record<string, unknown>).survival as boolean | undefined,
      }

      const spinner = ora('📦 采集 git numstat 数据...').start()
      let rows: QualityRow[]
      try {
        rows = await ContributionAnalyzer.analyze(path, qOptions)
      } catch (e) {
        spinner.fail(`分析失败: ${(e as Error).message}`)
        return
      }
      spinner.succeed(`分析完成，共 ${rows.length} 位贡献者`)
      printQualityTable(rows)
      printGlobalNotices()
    } catch (e) {
      console.error(chalk.red('发生错误:'), (e as Error).message)
    }
  }
}
