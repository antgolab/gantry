/**
 * settings-merge.mjs — .claude/settings.json 权限数组合并（叶子模块）
 *
 * 为 gantry install/uninstall 提供 permissions.allow 数组的 append + Set 去重 / 反向删除，
 * 以及侧文件（managed-permissions.json）的登记读写。所有写盘走原子写（.tmp + rename）。
 *
 * - settings.json 用点路径（如 "permissions.allow"）表达嵌套字段。
 * - 侧文件用字面键（如 "permissions.allow"）平铺登记 gantry 加过的条目。
 * - JSON.parse 失败一律 throw（D6），不静默降级。
 * - permissions.deny 命中同名条目时打印 stderr 警告（D7），不影响写入。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getByPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function warnIfDenied(settings, fieldPath, entries) {
  if (fieldPath !== 'permissions.allow') return;
  const deny = getByPath(settings, 'permissions.deny');
  if (!Array.isArray(deny)) return;
  const denySet = new Set(deny);
  for (const entry of entries) {
    if (denySet.has(entry)) {
      process.stderr.write(
        `[gantry] 警告：permissions.deny 已含 "${entry}"，Claude Code deny 优先于 allow，本次合并到 allow 无实际效果。\n`,
      );
    }
  }
}

export function mergeSettingsJson(settingsPath, addsMap) {
  const settings = readJson(settingsPath);
  const newlyAdded = {};

  for (const [fieldPath, entries] of Object.entries(addsMap)) {
    const existing = Array.isArray(getByPath(settings, fieldPath))
      ? getByPath(settings, fieldPath)
      : [];
    const existingSet = new Set(existing);
    const merged = [...existing];
    const added = [];
    for (const entry of entries) {
      if (!existingSet.has(entry)) {
        merged.push(entry);
        existingSet.add(entry);
        added.push(entry);
      }
    }
    if (added.length > 0) {
      setByPath(settings, fieldPath, merged);
      newlyAdded[fieldPath] = added;
      warnIfDenied(settings, fieldPath, added);
    }
  }

  if (Object.keys(newlyAdded).length > 0) {
    writeJsonAtomic(settingsPath, settings);
  }
  return newlyAdded;
}

export function unmergeSettingsJson(settingsPath, removesMap) {
  if (!existsSync(settingsPath)) return;
  const settings = readJson(settingsPath);
  let changed = false;

  for (const [fieldPath, entries] of Object.entries(removesMap)) {
    const existing = getByPath(settings, fieldPath);
    if (!Array.isArray(existing)) continue;
    const removeSet = new Set(entries);
    const kept = existing.filter(entry => !removeSet.has(entry));
    if (kept.length !== existing.length) {
      setByPath(settings, fieldPath, kept);
      changed = true;
    }
  }

  if (changed) {
    writeJsonAtomic(settingsPath, settings);
  }
}

export function readManaged(sideFilePath) {
  return readJson(sideFilePath);
}

export function writeManaged(sideFilePath, entriesMap) {
  const managed = readJson(sideFilePath);
  for (const [fieldPath, entries] of Object.entries(entriesMap)) {
    const existing = Array.isArray(managed[fieldPath]) ? managed[fieldPath] : [];
    const existingSet = new Set(existing);
    const merged = [...existing];
    for (const entry of entries) {
      if (!existingSet.has(entry)) {
        merged.push(entry);
        existingSet.add(entry);
      }
    }
    managed[fieldPath] = merged;
  }
  writeJsonAtomic(sideFilePath, managed);
}
