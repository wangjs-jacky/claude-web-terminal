#!/usr/bin/env node
/**
 * 修复 node-pty prebuild 的 spawn-helper 可执行权限。
 *
 * 背景：npm 在解压某些带预编译二进制的包时，会丢掉文件的可执行位，
 * 导致运行时 `posix_spawnp failed`。这里在 postinstall 阶段统一补上 +x。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prebuildsDir = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'prebuilds',
);

if (!fs.existsSync(prebuildsDir)) {
  process.exit(0); // node-pty 未安装或结构不同，跳过
}

let fixed = 0;
for (const platform of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, platform, 'spawn-helper');
  if (fs.existsSync(helper)) {
    try {
      fs.chmodSync(helper, 0o755);
      fixed++;
    } catch (e) {
      console.warn(`[fix-node-pty] 无法 chmod ${helper}: ${e.message}`);
    }
  }
}

if (fixed > 0) {
  console.log(`[fix-node-pty] 已修复 ${fixed} 个 spawn-helper 可执行权限`);
}
