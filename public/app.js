/* claude-web-terminal 前端：xterm.js 渲染 + WebSocket 转发 + 移动端工具条 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const statusEl = $('#status');

  // ---------- xterm 初始化 ----------
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily:
      'Menlo, Monaco, "SF Mono", "Courier New", monospace',
    scrollback: 5000,
    theme: {
      background: '#0b0e14',
      foreground: '#e6e6e6',
      cursor: '#e6e6e6',
    },
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('#terminal'));
  fitAddon.fit();

  // ---------- WebSocket ----------
  let ws;
  let reconnectTimer = null;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // 透传 token（若 URL 带了）
    const qs = location.search || '';
    return `${proto}://${location.host}/${qs}`;
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }),
      );
    }
  }

  function sendInput(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  // 发送 SGR 鼠标滚轮序列（tmux mouse on 接管）。
  // notches>0 向下滚（看更新内容），<0 向上滚（看历史）。x/y 缺省用终端中心。
  function sendWheel(notches, x, y) {
    const el = $('#terminal');
    const rect = el.getBoundingClientRect();
    const cx = x == null ? rect.left + rect.width / 2 : x;
    const cy = y == null ? rect.top + rect.height / 2 : y;
    const cellW = Math.max(1, rect.width / Math.max(1, term.cols));
    const cellH = Math.max(1, rect.height / Math.max(1, term.rows));
    const col = Math.min(term.cols, Math.max(1, Math.round((cx - rect.left) / cellW)));
    const row = Math.min(term.rows, Math.max(1, Math.round((cy - rect.top) / cellH)));
    const btn = notches > 0 ? 65 : 64;
    const seq = `\x1b[<${btn};${col};${row}M`;
    const n = Math.abs(notches);
    for (let i = 0; i < n; i++) sendInput(seq);
  }

  function connect() {
    setStatus('连接中…');
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      setStatus('● 已连接', 'ok');
      doFit();
    };
    ws.onmessage = (ev) => {
      term.write(ev.data);
    };
    ws.onclose = () => {
      setStatus('○ 已断开，3 秒后重连…', 'err');
      scheduleReconnect();
    };
    ws.onerror = () => {
      setStatus('✕ 连接错误', 'err');
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  // 浏览器输入（直接打字时）→ 发送到 pty
  term.onData((data) => sendInput(data));

  connect();

  // ---------- 触屏滚动 ----------
  // Claude Code 等全屏 TUI 使用 alt-screen，xterm 自身没有滚动历史，term.scrollLines 无效。
  // 解法：把触摸滑动转成「鼠标滚轮」转义序列发给后端；服务端已对 tmux 开启 mouse 模式，
  // tmux 会接管滚轮并滚动（alt-screen 时透传给内部应用，由应用自行滚动）。
  // 轻点 → 唤起软键盘。
  (function attachTouchScroll() {
    const el = $('#terminal');
    const WHEEL_STEP = 22; // 每滑动多少像素触发一次滚轮
    let lastY = 0;
    let startY = 0;
    let acc = 0;
    let moved = false;
    let lastX = 0;

    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        startY = lastY = e.touches[0].clientY;
        lastX = e.touches[0].clientX;
        acc = 0;
        moved = false;
      },
      { passive: false },
    );

    el.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        lastX = e.touches[0].clientX;
        acc += lastY - y; // 手指上滑(y 变小) → 正值
        lastY = y;
        if (Math.abs(y - startY) > 6) moved = true;
        const notches = Math.trunc(acc / WHEEL_STEP);
        if (notches !== 0) {
          sendWheel(notches, lastX, y);
          acc -= notches * WHEEL_STEP;
        }
        e.preventDefault(); // 阻止浏览器下拉刷新
      },
      { passive: false },
    );

    el.addEventListener('touchend', () => {
      if (!moved) term.focus(); // 轻点唤起软键盘
    });
  })();

  // ---------- 尺寸自适应 ----------
  function doFit() {
    try {
      fitAddon.fit();
    } catch (e) {}
    sendResize();
  }

  window.addEventListener('resize', () => setTimeout(doFit, 50));
  // 软键盘弹出/收起会改变可视区高度
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () =>
      setTimeout(doFit, 50),
    );
  }
  // 首屏稳定后再 fit 一次
  setTimeout(doFit, 300);

  // ---------- 工具条 ----------

  // 把 HTML data-send 里的转义序列还原为真实字符
  function unescape(s) {
    return s
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\x1b/g, '\x1b')
      .replace(/\\x03/g, '\x03');
  }

  // 所有带 data-send 的按钮：直接发对应控制字符
  document.querySelectorAll('[data-send]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      sendInput(unescape(btn.getAttribute('data-send')));
    });
  });

  // 文本输入：发送（不回车）/ ↵（回车提交）
  const textInput = $('#textInput');
  function flushText(withEnter) {
    const v = textInput.value;
    if (v) sendInput(v);
    if (withEnter) sendInput('\r');
    textInput.value = '';
    textInput.style.height = 'auto';
  }
  $('#btnSend').addEventListener('click', (e) => {
    e.preventDefault();
    flushText(false);
  });
  $('#btnSendEnter').addEventListener('click', (e) => {
    e.preventDefault();
    flushText(true);
  });
  // textarea 自动增高
  textInput.addEventListener('input', () => {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 96) + 'px';
  });

  // 功能键 data-act
  const actions = {
    'enter-cc': () => sendInput('claude --dangerously-skip-permissions\r'),
    clear: () => term.clear(),
    keyboard: () => term.focus(),
    ctrlc2: () => {
      sendInput('\x03');
      setTimeout(() => sendInput('\x03'), 60);
    },
    'page-up': () => sendWheel(-5),
    'page-down': () => sendWheel(5),
    'to-bottom': () => sendWheel(40), // 连续下滚到底

    image: () => $('#fileInput').click(),
  };
  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const fn = actions[btn.getAttribute('data-act')];
      if (fn) fn();
    });
  });

  // 收起 / 展开工具条
  const grid = $('#toolGrid');
  const collapseBtn = $('#btnCollapse');
  collapseBtn.addEventListener('click', () => {
    const hidden = grid.classList.toggle('hidden');
    collapseBtn.textContent = hidden ? '▲ 展开工具条' : '▼ 收起工具条';
    setTimeout(doFit, 50);
  });

  // ---------- 图片上传 ----------
  const fileInput = $('#fileInput');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    setStatus('上传图片中…');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const qs = location.search || '';
      const resp = await fetch('/upload' + qs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, name: file.name }),
      });
      const json = await resp.json();
      if (json.path) {
        // 把图片路径塞进终端，Claude Code 可识别本地图片路径
        sendInput(json.path + ' ');
        setStatus('● 已连接', 'ok');
      } else {
        setStatus('图片上传失败：' + (json.error || '未知'), 'err');
      }
    } catch (e) {
      setStatus('图片上传失败：' + e, 'err');
    }
  });

  // ---------- 注册 Service Worker（PWA 可安装 + 离线兜底）----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
