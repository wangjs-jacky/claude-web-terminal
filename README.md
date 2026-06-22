# claude-web-terminal

> 把 Mac mini 上的 **Claude Code** 投射到手机浏览器：手机打开一个地址，就能像坐在电脑前一样交互操作。基于 `node-pty` + `xterm.js`，用 `tmux` 持久化会话，经 **Tailscale** 私网安全访问。

![移动端工具条](https://img.shields.io/badge/mobile-toolbar-blue) ![tmux](https://img.shields.io/badge/session-tmux-green) ![tailscale](https://img.shields.io/badge/network-tailscale-orange)

## 这是什么

一个跑在 Mac mini 上的轻量 Node 服务：

- **后端**：`node-pty` 包裹 `tmux attach`，把终端字节流通过 WebSocket 双向转发
- **前端**：`xterm.js` 渲染终端 + 一套移动端友好的工具条（进入CC / 图片 / 清屏 / Tab / Esc / ^C / 方向键 / 翻页）
- **会话**：固定 `tmux` 会话名，手机断线重连回到原会话，**Claude Code 不中断**
- **网络**：手机装 Tailscale，走私有 IP，无需暴露公网端口

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

## 准备工作

| 依赖 | 说明 |
|------|------|
| Node.js ≥ 18 | 运行服务 |
| tmux | 会话持久化（`brew install tmux`） |
| claude（Claude Code CLI） | 被投射的目标 |
| Tailscale | Mac mini 与手机都登录同一账号 |

## 快速开始

### 1. 安装

```bash
git clone https://github.com/wangjs-jacky/claude-web-terminal.git
cd claude-web-terminal
npm install
```

> `node-pty` 是原生模块，安装时会自动编译，需要 Xcode Command Line Tools。

### 2. 启动

```bash
npm start
```

看到下面输出即成功：

```
claude-web-terminal listening on http://0.0.0.0:7681
  tmux session : claude
  claude cmd   : claude --dangerously-skip-permissions
```

### 3. 手机访问

1. 手机安装并登录 **Tailscale**（与 Mac mini 同账号）
2. 在 Mac mini 上查看 Tailscale IP：`tailscale ip -4`（形如 `100.x.x.x`）
3. 手机浏览器打开 `http://100.x.x.x:7681`

搞定 —— 你的 Claude Code 就投射到手机上了。

## 安装为 App（PWA，需 HTTPS）

浏览器规定 **Service Worker / PWA 安装必须运行在 HTTPS 安全上下文**，纯 `http://100.x.x.x` 无法安装（但终端功能、触屏滚动都正常）。

方案：用 **Tailscale 签发的可信证书**（Let's Encrypt），让本服务**直接**监听一个 HTTPS 端口（如 8443）。比 `tailscale serve` 更可控、可本地验证。

> 前提：Tailscale 管理后台已开启「HTTPS Certificates」+「MagicDNS」（默认多已开）。

```bash
# 1. 查出本机 .ts.net 域名
TS_DOMAIN=$(tailscale status --json | python3 -c "import sys,json;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")
echo "$TS_DOMAIN"   # 形如 jackymac-mini.tailxxxx.ts.net

# 2. 签发证书到 certs/（已被 .gitignore 忽略，不会提交）
mkdir -p certs
tailscale cert --cert-file certs/cert.crt --key-file certs/cert.key "$TS_DOMAIN"

# 3. 带 HTTPS 端口启动
HTTPS_PORT=8443 npm start
```

启动日志会多出一行 `https : https://0.0.0.0:8443 (cert: ...)`。手机浏览器打开：

```
https://<你的.ts.net域名>:8443
```

打开后用浏览器菜单「**添加到主屏幕 / 安装应用**」，即可像原生 App 一样全屏启动。

> **证书续期**：Tailscale 证书有效期约 90 天。重新运行第 2 步的 `tailscale cert` 即可刷新（可加 cron 每月跑一次）。
>
> **为什么不用 `tailscale serve`**：serve 代理 HTTPS 在部分环境下对自身 tailnet IP 存在自连/握手问题，本方案由 Node 直接持证书监听，链路更短也更易排查。

## 移动端手势

| 手势 | 效果 |
|------|------|
| **上下滑动终端区** | 滚动查看历史输出（已禁用浏览器下拉刷新） |
| **轻点终端区** | 唤起软键盘 |
| **工具条按钮** | 见下表 |

## 工具条说明

| 按钮 | 作用 |
|------|------|
| **发送 / ↵** | 文本框内容发送到终端；`发送`不带回车，`↵`回车提交 |
| **进入CC** | 发送 `claude --dangerously-skip-permissions` 启动 Claude Code |
| **📷 图片** | 选手机图片上传到 Mac mini，自动把路径塞进终端供 Claude 识别 |
| **清屏** | 清空当前终端显示 |
| **⌨ 键盘** | 唤起手机软键盘（聚焦终端） |
| **↵ / Tab / Esc / ^C / ^C×2** | 对应控制字符 |
| **← ↑ ↓ → / Home / End** | 方向键与行首行尾 |
| **↑上翻 / ↓下翻 / ⇊到底** | 滚动查看历史输出 |

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `7681` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听网卡（Tailscale 场景靠 ACL 限制来源） |
| `TMUX_SESSION` | `claude` | tmux 会话名 |
| `CLAUDE_CMD` | `claude --dangerously-skip-permissions` | 会话内启动命令 |
| `TOKEN` | 空 | 非空时要求 URL 带 `?token=xxx` 才能访问 |
| `UPLOAD_DIR` | `~/claude-web-uploads` | 图片上传落盘目录 |
| `HTTPS_PORT` | 空 | 设为如 `8443` 时额外监听 HTTPS（PWA 用） |
| `CERT_FILE` | `certs/cert.crt` | HTTPS 证书路径 |
| `KEY_FILE` | `certs/cert.key` | HTTPS 私钥路径 |

示例：

```bash
PORT=8080 TOKEN=my-secret npm start
# 访问 http://100.x.x.x:8080/?token=my-secret
```

## 开机自启（macOS launchd）

1. 编辑 `launchd.plist`，把 `__DIR__` 改为项目绝对路径，`__NODE__` 改为 `which node` 的结果
2. 安装：

```bash
cp launchd.plist ~/Library/LaunchAgents/com.jacky.claude-web-terminal.plist
launchctl load -w ~/Library/LaunchAgents/com.jacky.claude-web-terminal.plist
```

卸载：

```bash
launchctl unload ~/Library/LaunchAgents/com.jacky.claude-web-terminal.plist
```

## 安全说明

- 默认仅在 Tailscale 私网内可达，**不要**把 `7681` 端口转发到公网
- 如担心同 tailnet 其他设备，开启 `TOKEN` 做一层简单校验
- `--dangerously-skip-permissions` 会跳过 Claude Code 的权限确认，请确保只有你自己能访问

## 工作原理

1. 服务启动时 `tmux has-session`，不存在就 `tmux new-session -d` 起一个会话并在里面跑 `claude`
2. 每个 WebSocket 连接通过 `node-pty` 执行 `tmux attach`，成为该会话的一个客户端
3. 前端 `xterm.js` 把按键 → JSON 消息 → 后端 `pty.write()`；后端 `pty.onData` → WebSocket → 前端渲染
4. 前端 `fit` 后把 `cols/rows` 发给后端 `pty.resize()`，保证不错行
5. 手机断线 → WebSocket close → 后端 `pty.kill()` 仅 detach 该客户端，tmux 会话与 Claude Code 继续存活

## License

MIT © wangjs-jacky
