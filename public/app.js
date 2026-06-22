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
    'page-up': () => term.scrollPages(-1),
    'page-down': () => term.scrollPages(1),
    'to-bottom': () => term.scrollToBottom(),
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
})();
