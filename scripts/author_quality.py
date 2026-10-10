#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
author_quality.py — 去噪 / 分类 / 归一化的研发贡献分析（code996 推广原型 · 方案 A）

为什么需要它：
    单纯用「代码行数」衡量产出会被两类噪声严重误导：
      * 生成代码 / 依赖升级 / 锁文件刷新（零人工思考量，却把行数顶到最高）
      * 依赖清理 / 旧模块下线、以及对源码的整文件「重新格式化」（净删或巨量增删，
        却是低价值改动）——这类应当提交 message 标注，却被当成高产出
    本脚本改为三层处理：
      1) 去噪：按路径正则剔除 lock / generated / vendor 文件
      2) 分类：按 commit message 把提交分为 feat/fix/refactor/test/chore/deps/format/...
         格式化/生成/依赖/杂务类提交改动的「源码行」也计为低价值，不计入有效改动
      3) 归一化：用「有效提交 / 有效改动量(增+删) / 活跃天数 / 模块数」加权合成分
         替代单一行数（有效改动量同时奖励「写新代码」与「清理旧代码」）
         （可选 --survival：用 git blame 统计每人「存活代码行」即当前仍存在的代码量）
    同一人多用邮箱 / 名称变体（jinxin / jinxin3）按「去数字后的名字」自动合并。

用法：
  python author_quality.py --repo <git仓库路径> [--all-time] [--since YYYY-MM-DD]
                           [--until YYYY-MM-DD] [--exclude-authors jenkins,ci]
                           [--end-hour 18] [--survival] [--json out.json]

后续将抽象为 code996 子命令 `code996 quality`（方案 B），分类正则与权重与此保持一致。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import defaultdict

# ----------------------------------------------------------------------------
# 配置：噪声路径与提交类型（与方案 B 的 TS 实现保持一致）
# ----------------------------------------------------------------------------
LOCK_PATTERNS = [
    r"pubspec\.lock$", r"package-lock\.json$", r"yarn\.lock$",
    r"pnpm-lock\.yaml$", r"composer\.lock$", r"Gemfile\.lock$", r"go\.sum$",
]
GENERATED_PATTERNS = [
    r"\.g\.dart$", r"\.freezed\.dart$", r"\.pb\.dart$", r"\.pbjson\.dart$",
    r"\.pb\.go$", r"\.pb\.cc$", r"\.pb\.h$", r"\.mocks\.dart$",
    r"\.generated\.", r"\.gen\.ts$", r"\.min\.js$", r"\.min\.css$",
]
VENDOR_DIRS = [
    r"(?:^|/)build/", r"(?:^|/)\.dart_tool/", r"(?:^|/)node_modules/",
    r"(?:^|/)vendor/", r"(?:^|/)\.git/",
]
# 提交类型（顺序即优先级；先命中先返回）
MSG_TYPES = [
    ("revert",    r"^\s*revert\b"),
    ("deps",      r"\b(?:deps?|dependencies|dependenc|upgrade|bump|pub (?:get|upgrade)|packages?)\b"),
    ("format",    r"\b(?:format|lint|fmt|prettier|code ?style|style:|reformat|整理|对齐)\b"),
    ("generated", r"\b(?:generated|auto-?generated|codegen|gen:)\b"),
    ("chore",     r"\b(?:chore|ci\b|build\(deps\))\b"),
    ("test",      r"\b(?:test|spec)\b"),
    ("fix",       r"\b(?:fix|bug|hotfix)\b"),
    ("refactor",  r"\brefactor\b"),
    ("feat",      r"\b(?:feat|feature)\b"),
    ("docs",      r"\b(?:docs?|readme|document)\b"),
]
# 即便触及源码也视为低价值、不计入「有效提交」的类型
NON_EFFECTIVE_COMMIT_TYPES = {"format", "generated"}
# 低价值提交类型：其源码改动不计入「有效改动量」（格式化/生成/依赖/杂务）
LOW_VALUE_TYPES = {"format", "generated", "chore", "deps"}
# 归一化权重（可配置，总和为 1）
WEIGHTS = {"eff_commits": 0.40, "eff_churn": 0.30, "active_days": 0.20, "modules": 0.10}


def file_category(path: str) -> str:
    if any(re.search(p, path) for p in LOCK_PATTERNS):
        return "lock"
    if any(re.search(p, path) for p in GENERATED_PATTERNS):
        return "generated"
    if any(re.search(p, path) for p in VENDOR_DIRS):
        return "vendor"
    return "source"


def commit_type(message: str) -> str:
    m = message.lower()
    for t, pat in MSG_TYPES:
        if re.search(pat, m):
            return t
    return "other"


def top_module(path: str) -> str:
    # 取首个路径段作为「模块/目录」粒度（lib / test / android / ios ...）
    p = path.split("?")[0]
    parts = [x for x in p.split("/") if x]
    return parts[0] if parts else "(root)"


def name_key(name: str) -> str:
    # 去数字 + 小写，用于合并 jinxin / jinxin3、Marko / Marko 等同人多邮箱
    return re.sub(r"\d+", "", name.lower()).strip() or name.lower()


def git_log_numstat(repo: str, since: str | None, until: str | None) -> str:
    cmd = [
        "git", "-C", repo, "log", "--numstat", "--date=short",
        "--pretty=format:COMMIT%n%H%n%an%n%ae%n%ad%n%s",
        "--no-merges",
    ]
    if since:
        cmd += ["--since", since]
    if until:
        cmd += ["--until", until]
    return subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)


def parse_commits(raw: str):
    """返回提交列表：每项为 (name, email, date, msg, files)
    files: list of (added:int, deleted:int, path:str, category:str)"""
    commits = []
    lines = raw.split("\n")
    i, n = 0, len(lines)
    while i < n:
        if lines[i] == "COMMIT":
            i += 1
            h = lines[i].strip(); i += 1
            name = lines[i].strip(); i += 1
            email = lines[i].strip().lower(); i += 1
            date = lines[i].strip(); i += 1
            msg = lines[i].strip(); i += 1
            files = []
            while i < n and lines[i] != "COMMIT":
                seg = lines[i].split("\t")
                i += 1
                if len(seg) < 3:
                    continue
                added_s, deleted_s, path = seg[0], seg[1], seg[2]
                if added_s == "-" or deleted_s == "-":
                    added = deleted = 0
                else:
                    added = int(added_s) if added_s.isdigit() else 0
                    deleted = int(deleted_s) if deleted_s.isdigit() else 0
                files.append((added, deleted, path, file_category(path)))
            commits.append((name, email, date, msg, files))
        else:
            i += 1
    return commits


def compute_survival(repo: str):
    """用 git blame 统计当前 HEAD 每人的存活代码行（仅统计 source 文件）。"""
    try:
        files = subprocess.check_output(
            ["git", "-C", repo, "ls-files"], text=True
        ).splitlines()
    except subprocess.CalledProcessError:
        return {}
    src_files = [f for f in files if file_category(f) == "source"]
    counts = defaultdict(int)
    for f in src_files:
        try:
            out = subprocess.check_output(
                ["git", "-C", repo, "blame", "--line-porcelain", "HEAD", "--", f],
                text=True, errors="replace", stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            continue
        for line in out.splitlines():
            if line.startswith("author-mail "):
                email = line.split("<", 1)[1].rstrip(">").strip().lower()
                counts[email] += 1
    return counts


def merge_authors(authors, surv):
    """按「去数字后的名字」合并同人多邮箱；汇总指标与存活行。"""
    merged = {}
    for email, a in authors.items():
        key = name_key(a["name"]) or email
        if key not in merged:
            m = dict(a)
            m["emails"] = {email}
            m["primary_email"] = email
            m["_maxc"] = a["commits"]
            m["survival_lines"] = surv.get(email, 0)
            merged[key] = m
        else:
            m = merged[key]
            m["emails"].add(email)
            m["commits"] += a["commits"]
            m["eff_commits"] += a["eff_commits"]
            m["raw_added"] += a["raw_added"]
            m["raw_deleted"] += a["raw_deleted"]
            m["eff_added"] += a["eff_added"]
            m["eff_deleted"] += a["eff_deleted"]
            m["noise_lines"] += a["noise_lines"]
            m["low_value_lines"] += a["low_value_lines"]
            m["reverts"] += a["reverts"]
            m["active_days"] |= a["active_days"]
            m["modules"] |= a["modules"]
            for t, c in a["type_counts"].items():
                m["type_counts"][t] += c
            m["survival_lines"] += surv.get(email, 0)
            if a["commits"] > m["_maxc"]:
                m["name"] = a["name"]
                m["primary_email"] = email
                m["_maxc"] = a["commits"]
    return merged


def analyze(repo, since, until, exclude, survival):
    raw = git_log_numstat(repo, since, until)
    commits = parse_commits(raw)

    excl = [e.strip().lower() for e in (exclude or "").split(",") if e.strip()]

    authors = defaultdict(lambda: {
        "name": "", "commits": 0, "eff_commits": 0,
        "raw_added": 0, "raw_deleted": 0,
        "eff_added": 0, "eff_deleted": 0,
        "noise_lines": 0, "low_value_lines": 0, "reverts": 0,
        "type_counts": defaultdict(int),
        "active_days": set(), "modules": set(),
    })

    for name, email, date, msg, files in commits:
        if any(e in name.lower() or e in email for e in excl):
            continue
        a = authors[email]
        if not a["name"]:
            a["name"] = name
        a["name"] = name  # 保留最后出现的展示名
        a["commits"] += 1
        ctype = commit_type(msg)
        a["type_counts"][ctype] += 1
        if ctype == "revert":
            a["reverts"] += 1
        a["active_days"].add(date)

        has_source = False
        for added, deleted, path, cat in files:
            a["raw_added"] += added
            a["raw_deleted"] += deleted
            if cat != "source":
                a["noise_lines"] += added + deleted
                continue
            has_source = True
            a["modules"].add(top_module(path))
            if ctype in LOW_VALUE_TYPES:
                # 格式化/生成/依赖/杂务类提交：即便改的是源码也视为低价值
                a["low_value_lines"] += added + deleted
            else:
                a["eff_added"] += added
                a["eff_deleted"] += deleted

        if has_source and ctype not in NON_EFFECTIVE_COMMIT_TYPES:
            a["eff_commits"] += 1

    surv = compute_survival(repo) if survival else {}
    merged = merge_authors(authors, surv)

    # 归一化
    def max_of(key_fn):
        vals = [key_fn(a) for a in merged.values()]
        return max(vals) if vals else 1

    max_eff_commits = max_of(lambda a: a["eff_commits"]) or 1
    max_eff_churn = max_of(lambda a: a["eff_added"] + a["eff_deleted"]) or 1
    max_days = max_of(lambda a: len(a["active_days"])) or 1
    max_modules = max_of(lambda a: len(a["modules"])) or 1

    rows = []
    for a in merged.values():
        eff_churn = a["eff_added"] + a["eff_deleted"]
        raw_total = a["raw_added"] + a["raw_deleted"]
        noise_ratio = ((a["noise_lines"] + a["low_value_lines"]) / raw_total) if raw_total else 0.0
        score = (
            WEIGHTS["eff_commits"] * (a["eff_commits"] / max_eff_commits)
            + WEIGHTS["eff_churn"] * (eff_churn / max_eff_churn)
            + WEIGHTS["active_days"] * (len(a["active_days"]) / max_days)
            + WEIGHTS["modules"] * (len(a["modules"]) / max_modules)
        )
        rows.append({
            "email": a["primary_email"],
            "name": a["name"],
            "commits": a["commits"],
            "eff_commits": a["eff_commits"],
            "raw_added": a["raw_added"],
            "raw_deleted": a["raw_deleted"],
            "eff_added": a["eff_added"],
            "eff_deleted": a["eff_deleted"],
            "eff_churn": eff_churn,
            "low_value_lines": a["low_value_lines"],
            "noise_ratio": noise_ratio,
            "reverts": a["reverts"],
            "active_days": len(a["active_days"]),
            "modules": len(a["modules"]),
            "survival_lines": a.get("survival_lines", 0),
            "type_counts": dict(a["type_counts"]),
            "score": round(score * 100, 1),
        })
    rows.sort(key=lambda r: r["score"], reverse=True)
    return rows


def fmt_int(n):
    return f"{n:,}"


def print_table(rows):
    hdr = (f"{'贡献分':>6} {'作者':<13} {'提交':>5} {'有效提交':>7} {'原始+/−':>13} "
           f"{'有效改动':>11} {'低价值行':>9} {'噪音%':>6} {'活跃天':>5} {'模块':>4} {'rev':>4}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        raw_net = f"+{fmt_int(r['raw_added'])}/−{fmt_int(r['raw_deleted'])}"
        surv_note = f"  存活行={fmt_int(r['survival_lines'])}" if r["survival_lines"] else ""
        print(
            f"{r['score']:>6} {r['name'][:13]:<13} {r['commits']:>5} "
            f"{r['eff_commits']:>7} {raw_net:>13} "
            f"{fmt_int(r['eff_churn']):>11} {fmt_int(r['low_value_lines']):>9} "
            f"{r['noise_ratio']*100:>5.1f}% {r['active_days']:>5} {r['modules']:>4} {r['reverts']:>4}"
            f"{surv_note}"
        )
    print()
    print("指标说明：")
    print("  原始+/−   : git numstat 全量增删行（含依赖/生成/锁文件，纯行数口径）")
    print("  有效改动   : 仅 source 文件、且非格式化/生成/依赖类提交的真实增删行合计（写+删都计，清理被认可）")
    print("  低价值行   : 格式化/生成/依赖/杂务类提交中改动的源码行（已被剔除出有效改动）")
    print("  噪音%     : (非source行 + 低价值行) / 全量行数")
    print("  存活行     : --survival 时由 git blame 统计当前仍存在的代码行")
    print("  贡献分     : 有效提交0.4 + 有效改动0.3 + 活跃天0.2 + 模块数0.1，按最大值归一化")


def main():
    ap = argparse.ArgumentParser(description="去噪/分类/归一化的研发贡献分析")
    ap.add_argument("--repo", default=".", help="git 仓库路径")
    ap.add_argument("--all-time", action="store_true", help="不限制时间范围")
    ap.add_argument("--since", help="起始日期 YYYY-MM-DD")
    ap.add_argument("--until", help="结束日期 YYYY-MM-DD")
    ap.add_argument("--exclude-authors", default="", help="按名称或邮箱子串排除，逗号分隔")
    ap.add_argument("--end-hour", type=int, default=18, help="（预留）工作日的结束小时，用于夜间提交标识")
    ap.add_argument("--survival", action="store_true", help="用 git blame 计算存活代码行")
    ap.add_argument("--json", help="将结果写入 JSON 文件")
    args = ap.parse_args()

    since = None if args.all_time else (args.since or "1970-01-01")
    until = args.until
    rows = analyze(args.repo, since, until, args.exclude_authors, args.survival)
    print_table(rows)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        print(f"[json] 已写入 {args.json}")


if __name__ == "__main__":
    main()
