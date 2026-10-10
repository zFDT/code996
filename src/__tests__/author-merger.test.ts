import { AuthorMerger } from '../core/author-merger'

describe('AuthorMerger - 合并同名/同邮箱作者', () => {
  const merger = new AuthorMerger()

  describe('areSimilarNames', () => {
    it('名称互为子串时视为同一人', () => {
      expect(merger.areSimilarNames('jinxin', 'jinxin3')).toBe(true)
      expect(merger.areSimilarNames('JINXIN', 'jinxin3')).toBe(true)
    })

    it('不相关的名称不应合并', () => {
      expect(merger.areSimilarNames('alice', 'bob')).toBe(false)
      expect(merger.areSimilarNames('Marko', 'chaipeng')).toBe(false)
      expect(merger.areSimilarNames('liubinhua', 'Ben')).toBe(false)
    })
  })

  describe('getMergeMap - 跨邮箱合并', () => {
    it('jinxin / jinxin3 共用两个邮箱时应合并为同一主身份', () => {
      const map = merger.getMergeMap([
        { name: 'jinxin', email: 'jinxin@dreame.tech', commitCount: 1145 },
        { name: 'jinxin3', email: 'jinxin@dreame.tech', commitCount: 37 },
        { name: 'jinxin', email: 'jinxin@mova-tech.com', commitCount: 10 },
        { name: 'jinxin3', email: 'jinxin@mova-tech.com', commitCount: 27 },
      ])

      // 两个邮箱都应映射到同一个主邮箱
      expect(map.get('jinxin@dreame.tech')?.email).toBe('jinxin@dreame.tech')
      expect(map.get('jinxin@mova-tech.com')?.email).toBe('jinxin@dreame.tech')
      // 主身份名称来自提交数最多的身份
      expect(map.get('jinxin@dreame.tech')?.name).toBe('jinxin')
    })

    it('同一名称多邮箱时，主身份选择提交数最多的邮箱', () => {
      const map = merger.getMergeMap([
        { name: 'zhang', email: 'zhang@dreame.tech', commitCount: 1500 },
        { name: 'zhang', email: 'zhang@mova-tech.com', commitCount: 15 },
      ])

      expect(map.get('zhang@mova-tech.com')?.email).toBe('zhang@dreame.tech')
    })

    it('不相关的同名邮箱不应被错误合并', () => {
      const map = merger.getMergeMap([
        { name: 'liubinhua', email: 'liu@mova-tech.com', commitCount: 3 },
        { name: 'Ben', email: 'liu@mova-tech.com', commitCount: 240 },
      ])

      // 不同名称、相同邮箱：getMergeMap 不产生映射（由 ranking 的邮箱去重负责合并）
      expect(map.size).toBe(0)
    })
  })

  describe('analyzeAuthors - 提交数统计', () => {
    it('同一邮箱出现在多个名称下时，提交数应累加而非重复', () => {
      const result = merger.analyzeAuthors([
        { name: 'jinxin', email: 'jinxin@dreame.tech', commitCount: 1145 },
        { name: 'jinxin3', email: 'jinxin@dreame.tech', commitCount: 37 },
        { name: 'jinxin', email: 'jinxin@mova-tech.com', commitCount: 10 },
        { name: 'jinxin3', email: 'jinxin@mova-tech.com', commitCount: 27 },
      ])

      // 合并后应为 1 个分组
      expect(result.groups.length).toBe(1)
      // 该分组总提交数 = 1145 + 37 + 10 + 27 = 1219，不能翻倍
      expect(result.groups[0].totalCommits).toBe(1219)
    })
  })
})
