#!/usr/bin/env node
/**
 * claude-web-terminal 服务端
 *
 * 职责：
 *   1. 用 express 托管 public/ 下的前端静态资源
 *   2. 用 ws 提供 WebSocket，把终端字节流双向转发给浏览器
 *   3. 用 node-pty 包裹 `tmux attach`，接管一个持久化的 tmux 会话（里面跑 claude）
 *   4. 提供 /upload 接口，接收手机图片并落盘，返回路径供 Claude Code 引用
 *
 * 设计要点：
 *   - 会话固定名 CLAUDE（tmux session），不存在才创建，断线重连回到原会话
 *   - 每个 WebSocket 连接对应一个 `tmux attach` 客户端，断开即 detach（不杀会话）
 *   - 仅在 Tailscale 私网内访问，安全性主要依赖 Tailscale ACL；可选 TOKEN 兜底
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn as ptySpawn } from 'node-pty';
import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置（环境变量可覆盖）----------
const PORT = Number(process.env.PORT || 7681);
const HOST = process.env.HOST || '0.0.0.0'; // Tailscale 场景下监听全部网卡，靠 ACL 限制来源
const SESSION = process.env.TMUX_SESSION || 'claude';
const CLAUDE_CMD =
  process.env.CLAUDE_CMD || 'claude --dangerously-skip-permissions';
const TOKEN = process.env.TOKEN || ''; // 可选：非空时要求 URL ?token=xxx 校验
const SHELL = process.env.SHELL || '/bin/zsh';
const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(os.homedir(), 'claude-web-uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 去掉 TMUX 相关变量：否则若本服务自身运行在 tmux 内，`tmux attach` 会因
// 「sessions should be nested with care」拒绝嵌套，导致客户端收不到任何输出。
function cleanEnv() {
  const e = { ...process.env };
  delete e.TMUX;
  delete e.TMUX_PANE;
  return e;
}
const BASE_ENV = cleanEnv();

// 解析 tmux 绝对路径：node-pty 不走 shell，依赖 PATH；launchd 环境下 PATH
// 常常不含 Homebrew，这里启动时一次性定位，找不到则报错退出。
function resolveTmux() {
  try {
    return execSync('command -v tmux', { env: BASE_ENV }).toString().trim();
  } catch {
    for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
      if (fs.existsSync(p)) return p;
    }
    console.error('找不到 tmux，请先安装：brew install tmux');
    process.exit(1);
  }
}
const TMUX_BIN = resolveTmux();

// ---------- 工具函数 ----------

/** 确保 tmux 会话存在；不存在则新建并在其中启动 claude */
function ensureSession() {
  try {
    execSync(`tmux has-session -t ${SESSION} 2>/dev/null`, { env: BASE_ENV });
  } catch {
    // 会话不存在 → 创建一个分离的会话并启动 claude
    execSync(
      `tmux new-session -d -s ${SESSION} -x 220 -y 50 ${JSON.stringify(
        CLAUDE_CMD,
      )}`,
      { stdio: 'ignore', env: BASE_ENV },
    );
    // 关闭 tmux 状态栏，给终端腾出一整行（移动端寸土寸金）
    try {
      execSync(`tmux set-option -t ${SESSION} status off`, { env: BASE_ENV });
    } catch {}
  }
}

// ---------- HTTP / 静态资源 ----------
const app = express();
app.use(express.json({ limit: '25mb' }));

// 可选 token 校验中间件（对页面与接口生效；WebSocket 单独校验）
app.use((req, res, next) => {
  if (!TOKEN) return next();
  if (req.query.token === TOKEN) return next();
  res.status(401).send('Unauthorized: missing or wrong token');
});

app.use(express.static(path.join(__dirname, 'public')));

// 本地 vendor xterm.js（不依赖外网 CDN）
app.use(
  '/vendor/xterm',
  express.static(path.join(__dirname, 'node_modules/@xterm/xterm')),
);
app.use(
  '/vendor/addon-fit',
  express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')),
);

// 图片上传：手机发 base64，落盘到 UPLOAD_DIR，返回绝对路径
app.post('/upload', (req, res) => {
  try {
    const { dataUrl, name } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'no dataUrl' });
    }
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'bad dataUrl' });
    const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
    const base = path
      .parse(name || 'img')
      .name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(UPLOAD_DIR, `${Date.now()}-${base || 'img'}.${ext}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    res.json({ path: file });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (TOKEN) {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ensureSession();

  // 每个连接 attach 一次 tmux；-A 不需要，因为已确保存在
  const pty = ptySpawn(TMUX_BIN, ['attach', '-t', SESSION], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: { ...BASE_ENV, TERM: 'xterm-256color', SHELL },
  });

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  pty.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      pty.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try {
        pty.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0));
      } catch {}
    }
  });

  ws.on('close', () => {
    // 断开仅 detach 该客户端（kill pty 即发送 detach），tmux 会话保留
    try {
      pty.kill();
    } catch {}
  });
});

server.listen(PORT, HOST, () => {
  ensureSession();
  console.log(`claude-web-terminal listening on http://${HOST}:${PORT}`);
  console.log(`  tmux session : ${SESSION}`);
  console.log(`  claude cmd   : ${CLAUDE_CMD}`);
  console.log(`  upload dir   : ${UPLOAD_DIR}`);
  if (TOKEN) console.log('  token        : enabled');
});
