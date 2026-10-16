/**
 * gantry knowledge — 知识库维护子命令组
 *
 *   gantry knowledge migrate [--dry-run]   委托 learnings/migrator.mjs
 *   gantry knowledge maintain [--rebuild-index] [--promote-threshold N] [--archive-days N]
 *                                          委托 learnings/maintainer.mjs (T13；未实装时 graceful 报错)
 */

import { migrate } from '../lib/learnings/index.mjs';

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

function printHelp() {
  console.log(`gantry knowledge — 知识库维护

用法: gantry knowledge <subcommand> [options]

子命令:
  migrate              一次性迁移旧知识出口 (.gantry/specs/LESSONS.md + knowledge/*.md)
                       到 .gantry/learnings/team/ (幂等)
    --dry-run            只预览,不落盘

  maintain             维护 learnings (promotion / archive / rebuild-index)
    --rebuild-index      全量重建 BM25 索引
    --promote-threshold N  promotion 阈值 (默认 3)
    --archive-days N      archive 天数阈值 (默认 90)
`);
}

export async function knowledge(args) {
  const sub = args[0];

  if (sub === '--help' || sub === '-h' || sub === undefined) {
    printHelp();
    return;
  }

  if (sub === 'migrate') {
    const dryRun = args.includes('--dry-run');
    const result = await migrate({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (sub === 'maintain') {
    const opts = {
      rebuildIndex: args.includes('--rebuild-index'),
      promoteThreshold: getFlag(args, '--promote-threshold'),
      archiveDays: getFlag(args, '--archive-days'),
    };

    // T13 已实装，走 learnings/index.mjs facade（T-FIX-08）。
    let maintainer;
    try {
      maintainer = await import('../lib/learnings/index.mjs');
    } catch {
      console.error('maintainer not implemented (waiting T13)');
      process.exit(1);
    }

    const result = await maintainer.maintain(opts);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`未知子命令: ${sub}\n运行 gantry knowledge --help 查看`);
  process.exit(1);
}
