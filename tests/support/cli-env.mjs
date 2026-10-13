/**
 * cli-env.mjs — CLI 子进程测试用的隔离环境 (jev-redline-precheck T-FIX-01 · REVIEW F-01)
 *
 * light 入口会读全局 ~/.gantry/config.json 的 jev.enabled 和环境变量 TYPESAFE_API_KEY。
 * 子进程若直接继承开发者的 HOME / 环境变量，开启了 Jev 的维护者跑测试时会把描述外发，
 * 而且 Jev 判红的用例会从 light 变成 full。这里给子进程一个空 HOME，并去掉 TYPESAFE_*。
 *
 * 本文件不以 .test.mjs 结尾，不会被 `node --test tests/*.test.mjs` 当作测试运行。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STRIPPED_VARS = ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL'];

let isolatedHome = null;

/** 本进程独享的空 HOME，首次使用时创建，进程退出时清理 */
function home() {
  if (!isolatedHome) {
    isolatedHome = mkdtempSync(join(tmpdir(), 'gantry-test-home-'));
    process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }));
  }
  return isolatedHome;
}

/** process.env 的副本：HOME 指向隔离目录，去掉 TYPESAFE_* */
export function cliEnv() {
  const env = { ...process.env, HOME: home() };
  for (const key of STRIPPED_VARS) delete env[key];
  return env;
}
