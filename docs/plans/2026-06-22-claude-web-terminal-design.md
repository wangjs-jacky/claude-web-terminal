# 设计文档：claude-web-terminal

> 日期：2026-06-22

## 目标

把 Mac mini 上的 Claude Code 投射到手机浏览器，实现**可交互控制**：手机打开一个 Tailscale 私网地址即可像本机一样操作 Claude Code。

## 需求对齐（来自头脑风暴）

- **交互模式**：可交互控制（非只读）
- **网络**：Tailscale 内网穿透，走私有 IP，不暴露公网
- **会话持久化**：tmux 托管，断线重连不丢
- **UI**：完全复刻移动端工具条（进入CC / 图片 / 清屏 / 键盘 / ↵ Tab Esc ^C ^C×2 / 方向键 / 翻页）
- **发布**：发布到 GitHub（wangjs-jacky）

## 架构

```
手机浏览器 (xterm.js + 工具条)
      │  WebSocket（Tailscale 私网）
      ▼
Mac mini: Node 服务 (express + ws)
      │  node-pty
      ▼
  tmux attach -t claude   ←── 断线重连不丢
      │
   claude --dangerously-skip-permissions
```

## 组件

| 组件 | 技术 | 作用 |
|------|------|------|
| 后端 | Node + express + ws + node-pty | HTTP/WS 服务，pty 包裹 `tmux attach` |
| 会话 | tmux（session=claude） | 持久化 |
| 前端 | xterm.js + addon-fit（本地 vendor） | 渲染 + 自适应 |
| 工具条 | 原生 HTML/CSS/JS | 复刻移动端按钮 |
| 自启 | launchd plist | 随 Mac mini 启动 |

## 数据流

1. 启动确保 tmux 会话存在（不存在则建并跑 claude）
2. WS 连接 → node-pty 执行 `tmux attach`
3. 前端按键 → JSON `{type:'input'}` → `pty.write`
4. `pty.onData` → WS → `term.write`
5. 前端 fit → `{type:'resize'}` → `pty.resize`
6. WS close → `pty.kill`（仅 detach，会话存活）

## 错误处理

- WS 断开：前端 3 秒自动重连
- token 校验：HTTP 中间件 + WS upgrade 双重校验
- 图片上传失败：状态条提示

## 安全

- 仅 Tailscale 私网可达
- 可选 TOKEN 兜底
- `--dangerously-skip-permissions` 风险提示写入 README

## 测试策略

- 本机 `npm start` 启动后用 `curl` 验证页面与 vendor 资源 200
- 浏览器连 WS，验证终端可见 claude 启动画面、可输入、可 resize
