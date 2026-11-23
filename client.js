/**
 * Settings → Plugins → Support tunnel
 *
 * The browser half has no service that can call into the Host, so everything
 * travels over the Web GUI's HTTP server: GET /api/support-tunnel/state and
 * POST /api/support-tunnel/export, both owner-only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-support-tunnel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const API = '/api/support-tunnel';
    // Remember what the operator typed: the domain is fixed per deployment and
    // retyping it on every export is pure friction. Nothing secret is stored.
    const FORM_KEY = 'dsh.support-tunnel.form';

    function readForm() {
      try {
        const raw = localStorage.getItem(FORM_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }

    const saved = readForm();

    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '14px 16px',
        background: 'var(--dsw-alias-bg-layer-1)',
        marginBottom: 14,
      },
      h2: { fontSize: 14, fontWeight: 600, margin: '0 0 12px' },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      label: { width: 108, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      button: {
        padding: '7px 16px',
        borderRadius: 8,
        // Outlined instead of filled: the brand token is near-white in this
        // theme, so a filled button with white text renders as a blank block.
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 500,
      },
      ghost: {
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: 13,
      },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      pre: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: 10,
        margin: '8px 0 0',
        fontSize: 12,
        maxHeight: 220,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 4 },
      // The two dots are different channels that fail independently; without a label
      // they read as one status shown twice.
      dotLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      // Two lines instead of six columns. The settings pane is too narrow for six
      // fixed columns — the action button got clipped at the right edge — so each
      // device became a card: status + name + button on top, note + connection below.
      // minWidth: 0 is what lets the flexible cells ellipsize instead of overflowing.
      deviceCard: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 },
      deviceLine1: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      deviceLine2: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 2, paddingLeft: 16, minWidth: 0 },
      deviceNameFirst: {
        flexShrink: 0, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontWeight: 500, marginRight: 6,
      },
      // Spacer so the action button stays right-aligned now that the name is first.
      deviceSpacer: { flex: 1, minWidth: 8 },
      deviceTitle: {
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontWeight: 500,
      },
      deviceNote: {
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', cursor: 'pointer',
      },
      deviceMeta: { flexShrink: 0, whiteSpace: 'nowrap', opacity: 0.75 },
      deviceAction: { flexShrink: 0, whiteSpace: 'nowrap' },
    };

    function statusColor(state) {
      if (!state) return 'var(--dsw-alias-state-idle-primary)';
      return state.listening ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)';
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [name, setName] = useState(saved.name || '');
      const [server, setServer] = useState(saved.server || '');
      const [port, setPort] = useState(saved.port || '24443');
      const [clientUser, setClientUser] = useState(saved.clientUser || '');
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const [error, setError] = useState('');
      const [copied, setCopied] = useState('');
      const [sshBusy, setSshBusy] = useState('');
      const [serverInfo, setServerInfo] = useState(null);
      const [serverDraft, setServerDraft] = useState('');
      const [serverBusy, setServerBusy] = useState(false);
      const [serverNotice, setServerNotice] = useState('');
      const [vncBusy, setVncBusy] = useState('');
      const [vncNotice, setVncNotice] = useState(null);
      // Which kit note is being edited, and the draft text.
      const [noteEditing, setNoteEditing] = useState('');
      const [noteDraft, setNoteDraft] = useState('');

      useEffect(() => {
        try {
          localStorage.setItem(FORM_KEY, JSON.stringify({ name, server, port, clientUser }));
        } catch {
          /* storage may be disabled; the form still works for this session */
        }
      }, [name, server, port, clientUser]);

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${API}/state`, { credentials: 'same-origin' });
          if (!response.ok) {
            setLoadError(response.status === 403 ? '没有权限（只允许本机 owner 访问）' : `读取失败：HTTP ${response.status}`);
            return;
          }
          const data = await response.json();
          setState(data);
          setLoadError('');
          setServer((current) => current || data.publicServer || '');
          setPort((current) => (current && current !== '24443' ? current : String(data.publicPort || data.port || 24443)));
        } catch (err) {
          setLoadError(`读取失败：${err && err.message ? err.message : '网络错误'}`);
        }
      }, []);

      const saveNote = useCallback(async (kitId, text) => {
        setNoteEditing('');
        try {
          const response = await fetch(`${API}/notes`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kitId, notes: text }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            setVncNotice({ kind: 'error', text: data.error || `保存备注失败：HTTP ${response.status}` });
          }
        } catch (err) {
          setVncNotice({ kind: 'error', text: `保存备注失败：${err && err.message}` });
        }
        load();
      }, [load]);

      useEffect(() => {
        load();
      }, [load]);

      const submit = useCallback(async () => {
        setBusy(true);
        setError('');
        setResult(null);
        try {
          const response = await fetch(`${API}/export`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              server: server.trim(),
              port: Number(port) || 0,
              clientUser: clientUser.trim(),
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            setError(data.error || `生成失败：HTTP ${response.status}`);
          } else {
            setResult(data);
            setName(data.name);
            load();
          }
        } catch (err) {
          setError(`生成失败：${err && err.message ? err.message : '网络错误'}`);
        } finally {
          setBusy(false);
        }
      }, [name, server, port, clientUser, load]);

      // 当前连的服务器。GET 拿显示值，POST 改地址——改完插件会重启好让后端用新地址重建，
      // 所以响应里说的只是"已提交"，真正的结果要看工具能不能连上。
      const loadServer = useCallback(async () => {
        try {
          const response = await fetch(`${API}/server`, { credentials: 'same-origin' });
          const data = await response.json().catch(() => ({}));
          if (data && data.ok) {
            setServerInfo(data);
            setServerDraft(data.remoteUrl || '');
          }
        } catch {
          // 服务器信息只是显示用，读不到不影响隧道本身
        }
      }, []);

      const switchServer = useCallback(async () => {
        const remoteUrl = String(serverDraft || '').trim();
        if (!remoteUrl) {
          setServerNotice('先填一个地址');
          return;
        }
        setServerBusy(true);
        setServerNotice('');
        try {
          const response = await fetch(`${API}/server`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ remoteUrl }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            setServerNotice(data.error || `HTTP ${response.status}`);
          } else {
            setServerNotice(data.hint || '已提交，插件正在重启');
          }
        } catch (err) {
          setServerNotice(`切换失败：${err && err.message ? err.message : '网络错误'}`);
        } finally {
          setServerBusy(false);
        }
      }, [serverDraft]);

      useEffect(() => { loadServer(); }, [loadServer]);

      const copy = useCallback(async (text, tag) => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(tag);
          setTimeout(() => setCopied(''), 1500);
        } catch {
          setCopied('失败');
        }
      }, []);

      // 让 Host 在桌面上开一个终端窗口直接连过去。
      // 比复制命令好：粘贴到别的机器上会失效（路径和端口都只在这台机器上）。
      const openSsh = useCallback(async (sessionKey, deviceName) => {
        if (!sessionKey) return;
        setSshBusy(sessionKey);
        setVncNotice(null);
        try {
          const response = await fetch(`${API}/ssh`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionKey }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            setVncNotice({ kind: 'error', text: `${deviceName}：${data.error || `HTTP ${response.status}`}` });
          }
        } catch (err) {
          setVncNotice({ kind: 'error', text: `打开终端失败：${err?.message || err}` });
        } finally {
          setSshBusy('');
        }
      }, []);

      const download = useCallback(() => {
        if (!result) return;
        const blob = new Blob([JSON.stringify(result.support, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `support-${result.name}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      }, [result]);

      // VNC is for the operator: one click should both bring the remote server
      // up and show the screen. The window has to be opened synchronously inside
      // the click handler, otherwise the popup blocker eats it — so open a blank
      // one first and point it at the page once the forward is ready.
      const remoteView = useCallback(async (sessionKey, deviceName, action) => {
        if (!sessionKey) return;
        setVncBusy(sessionKey);
        setVncNotice(null);

        let win = null;
        if (!action || action === 'start') {
          try {
            win = window.open('', '_blank', 'width=1400,height=900');
          } catch {
            win = null;
          }
        }

        try {
          const response = await fetch(`${API}/vnc`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action || 'start', target: sessionKey }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            if (win) win.close();
            setVncNotice({ kind: 'error', text: data.error || `HTTP ${response.status}` });
          } else if (data.stopped) {
            if (win) win.close();
            setVncNotice({ kind: 'info', text: `${deviceName} 的远程查看已关闭（端口 ${data.localPort} 已释放）` });
          } else {
            if (win && data.webUrl) {
              win.location.href = data.webUrl;
            }
            setVncNotice({
              kind: 'ok',
              text: win && data.webUrl
                ? `${deviceName} 的画面已在独立窗口打开（${data.address}）`
                : `${deviceName} → ${data.address}`,
              address: data.address,
              webUrl: data.webUrl || '',
              reused: data.reused,
            });
          }
        } catch (err) {
          if (win) win.close();
          setVncNotice({ kind: 'error', text: `请求失败：${err && err.message}` });
        } finally {
          setVncBusy('');
            // Re-read the state so the switch reflects what actually happened.
            // load() runs only on mount, so without this the button keeps saying
            // 「远程查看」after a viewer opened and 「关闭远程」after it closed.
            load();
        }
        }, [load]);

      const kits = state && state.kits ? state.kits : [];
      const devices = state && state.devices ? state.devices : [];
      // Which machines already have a viewer open. The session lives on the
      // server, so this reflects the button truthfully, not a local guess.
      const vncList = state && state.vncSessions ? state.vncSessions : [];
      const hasViewer = (kitId) => vncList.some((entry) => entry.kitId === kitId);

      return h('div', { style: S.wrap },
        // 服务器地址：换一台隧道服务器就在这里改。保存走 configEditor，插件会重启
        // 让后端用新地址重建——所以提示写的是"正在重启"，不是"已生效"。
        h('div', { style: { ...S.card, marginBottom: 14 } },
          h('h2', { style: S.h2 }, '服务器'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
            h('input', {
              value: serverDraft,
              onChange: (e) => setServerDraft(e.target.value),
              placeholder: 'https://127.0.0.1:24444',
              spellCheck: false,
              style: {
                flex: 1,
                fontSize: 12,
                padding: '6px 8px',
                borderRadius: 4,
                border: '1px solid var(--dsw-alias-border-secondary, #444)',
                background: 'transparent',
                color: 'inherit',
              },
            }),
            h('button', {
              style: {
                ...S.button,
                padding: '6px 14px',
                fontSize: 12,
                cursor: serverBusy || (serverInfo && !serverInfo.canEdit) ? 'not-allowed' : 'pointer',
                opacity: serverBusy || (serverInfo && !serverInfo.canEdit) ? 0.5 : 1,
              },
              disabled: serverBusy || Boolean(serverInfo && !serverInfo.canEdit),
              onClick: switchServer,
            }, serverBusy ? '切换中…' : '切换')),
          h('div', { style: { ...S.hint, marginTop: 6 } },
            serverNotice
              ? serverNotice
              : serverInfo && serverInfo.canEdit
                ? '切换后插件会重启，工具和远程画面都会连到新服务器。'
                : '这个 profile 不能保存配置，只能在 cordis.patch.yml 里改 remoteUrl。')),
        h('div', { style: S.card },
          h('h2', { style: S.h2 }, '隧道状态'),
          loadError
            ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, loadError)
            : h('div', { style: S.row },
              h('span', null,
                h('span', { style: { ...S.dot, background: statusColor(state) } }),
                state
                  ? (state.listening
                    ? `监听中 ${state.host}:${state.port}（${state.tls ? 'HTTPS' : '明文'}）`
                    : `未监听：${state.error || '未知原因'}`)
                  : '读取中…')),
          state && state.fingerprint
            ? h('div', { style: S.row },
              h('span', { style: S.label }, '证书指纹'),
              h('span', { style: { ...S.mono, flex: 1, wordBreak: 'break-all' } }, state.fingerprint),
              h('button', { style: S.ghost, onClick: () => copy(state.fingerprint, 'fp') },
                copied === 'fp' ? '已复制' : '复制'))
            : null,
          state
            ? h('div', { style: S.row },
              h('span', { style: S.label }, 'kit 目录'),
              h('span', { style: { ...S.mono, flex: 1, wordBreak: 'break-all' }, title: state.kitsDir }, state.kitsDir || '(默认)'),
              h('span', { style: S.hint }, `${kits.length} 个`))
            : null,
          state && state.clients && state.clients.length
            ? h('div', { style: S.row },
              h('span', { style: S.label }, '在线客户机'),
              h('span', { style: S.hint },
                state.clients.map((c) => `${c.name}（${c.clientOs || '?'}，:${c.localPort}）`).join('、')))
            : null),
          h('div', { style: { ...S.hint, marginTop: 8 } },
            '隧道只负责到达。桌面操作、COM 调用和命令执行由客户机会话里的 session1-agent 完成（127.0.0.1:9997），'
            + '它没起来时隧道显示在线但工具会失败；ssh 与 scp 是保底通道，agent 挂了仍可用。'),

        h('div', { style: { ...S.card, marginTop: 14 } },
          h('h2', { style: S.h2 },
            devices.length ? `设备（${devices.filter((d) => d.online).length}/${devices.length} 在线）` : '设备'),
          devices.length === 0
            ? h('div', { style: S.hint }, '还没有 kit。在下面填个名字，会生成第一个。')
            : h('div', null, devices.flatMap((device) => {
              if (!device.online || !device.sessions.length) {
                return [h('div', { key: device.kitId, style: S.deviceCard },
                  h('div', { style: S.deviceLine1 },
                    h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-idle-primary)' } }),
                    h('span', { style: S.deviceTitle, title: device.name }, device.name),
                    h('span', { style: { ...S.hint, ...S.deviceMeta } }, '离线')),
                  h('div', { style: S.deviceLine2 },
                    h('span', { style: { ...S.mono, ...S.hint, ...S.deviceMeta }, title: 'kitId' }, device.kitId)))];
              }
              // One row per machine, so "远程查看" always names a single session.
              return device.sessions.map((session) => h('div', { key: session.sessionKey, style: S.deviceCard },
                h('div', { style: S.deviceLine1 },
                  // Identity first: the machine is what you scan for, the dots qualify it.
                  h('span', {
                    style: { ...S.deviceNameFirst },
                    title: `${device.name} · ${device.kitId}`,
                  }, session.clientHost || device.name),
                  h('span', { title: '隧道：support-agent 已连接服务端', style: {
                    ...S.dot, background: 'var(--dsw-alias-state-success-primary)',
                  } }),
                  h('span', { style: { ...S.dotLabel, marginRight: 6 } }, '隧道'),
                  h('span', {
                    title: session.sshUp ? 'ssh：可登录，能跑命令和传文件' : `ssh：不可用${session.sshDetail ? '（' + session.sshDetail + '）' : ''}` ,
                    style: {
                      ...S.dot,
                      background: session.sshUp
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                    },
                  }),
                  h('span', { style: { ...S.dotLabel } }, 'ssh'),
                  h('span', { style: S.deviceSpacer }),
                  h('button', {
                    style: { ...S.ghost, ...S.deviceAction, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
                    disabled: vncBusy === session.sessionKey,
                    onClick: () => remoteView(
                      session.sessionKey,
                      session.clientHost || device.name,
                      hasViewer(device.kitId) ? 'stop' : 'start',
                    ),
                  }, vncBusy === session.sessionKey
                    ? '开启中…'
                    : (hasViewer(device.kitId) ? '关闭远程' : '远程查看'))),
                h('div', { style: S.deviceLine2 },
                  h('span', {
                    style: { ...S.hint, ...S.deviceNote },
                    title: device.notes ? `${device.notes}（点击编辑）` : '点击添加备注',
                    onClick: () => { setNoteEditing(device.kitId); setNoteDraft(device.notes || ''); },
                  }, noteEditing === device.kitId
                    ? h('input', {
                      autoFocus: true,
                      value: noteDraft,
                      onChange: (e) => setNoteDraft(e.target.value),
                      onBlur: () => saveNote(device.kitId, noteDraft),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') saveNote(device.kitId, noteDraft);
                        if (e.key === 'Escape') setNoteEditing('');
                      },
                      style: { width: '100%', fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-secondary, #444)', background: 'transparent', color: 'inherit' },
                    })
                    : (device.notes || '＋备注')),
                  h('span', {
                    style: { ...S.hint, ...S.mono, ...S.deviceMeta },
                    title: `${session.user || ''} :${session.localPort}`,
                  }, `${session.user || ''} :${session.localPort}`),
                  // 「SSH」让 Host 直接弹一个终端窗口连过去，不用复制粘贴。
                  session.sshCommand
                    ? h('button', {
                      style: { ...S.ghost, padding: '2px 8px', fontSize: 11, marginLeft: 8, cursor: 'pointer' },
                      title: session.sshCommand,
                      disabled: sshBusy === session.sessionKey,
                      onClick: () => openSsh(session.sessionKey, session.clientHost || device.name),
                    }, sshBusy === session.sessionKey ? '打开中…' : 'SSH')
                    : null)));
            })),
          vncNotice
            ? h('div', {
              style: {
                ...S.hint,
                marginTop: 10,
                color: vncNotice.kind === 'error'
                  ? 'var(--dsw-alias-state-error-primary)'
                  : vncNotice.kind === 'ok'
                    ? 'var(--dsw-alias-state-success-primary)'
                    : undefined,
              },
            },
            vncNotice.text,
            // The Host opens the viewer in its own window: a Chromium app
            // window looks like a remote-desktop client, and this page cannot
            // create windows at all because it runs inside the desktop app.
            vncNotice.address
              ? h('span', null,
                '　',
                // Browser client: no VNC viewer needed on this machine.
                vncNotice.webUrl
                  ? h('a', {
                    href: vncNotice.webUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    style: {
                      ...S.button,
                      padding: '4px 12px',
                      fontSize: 12,
                      textDecoration: 'none',
                      display: 'inline-block',
                      marginLeft: 4,
                    },
                  }, '打开画面')
                  : null,
                h('button', {
                  style: { ...S.ghost, padding: '4px 10px', fontSize: 12, marginLeft: 6, cursor: 'pointer' },
                  onClick: () => copy(vncNotice.address, 'vnc'),
                }, copied === 'vnc' ? '已复制' : '复制地址'),
                '　也可以用自己的 VNC 查看器连')
              : null)
            : null),

        h('div', { style: S.card },
          h('h2', { style: S.h2 }, '导出客户端配置'),
          h('div', { style: S.hint },
            '填写客户机要连的地址，生成 support.json。写到 kit 目录的 client 下，客户机覆盖同名文件后重启客户端即可。',
            h('br'),
            'kit 名不存在时会新建一个（生成新的 kitId 和 token，并在 Host 上生成 operator 密钥）。'),
          h('div', { style: { height: 12 } }),
          h('div', { style: S.row },
            h('span', { style: S.label }, 'kit 名'),
            h('input', {
              style: S.input,
              value: name,
              list: 'support-tunnel-kits',
              placeholder: '例如 工作机',
              onChange: (event) => setName(event.target.value),
            }),
            h('datalist', { id: 'support-tunnel-kits' },
              kits.map((kit) => h('option', { key: kit.kitId, value: kit.name })))),
          h('div', { style: S.row },
            h('span', { style: S.label }, '服务端地址'),
            h('input', {
              style: S.input,
              value: server,
              placeholder: '客户机要连的域名或 IP',
              onChange: (event) => setServer(event.target.value),
            })),
          h('div', { style: S.row },
            h('span', { style: S.label }, '端口'),
            h('input', {
              style: S.input,
              value: port,
              inputMode: 'numeric',
              onChange: (event) => setPort(event.target.value),
            })),
          h('div', { style: S.row },
            h('span', { style: S.label }, '登录用户'),
            h('input', {
              style: S.input,
              value: clientUser,
              placeholder: '可留空；新建 kit 时默认 root',
              onChange: (event) => setClientUser(event.target.value),
            })),
          h('div', { style: S.row },
            h('button', {
              style: { ...S.button, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' },
              disabled: busy,
              onClick: submit,
            }, busy ? '生成中…' : '生成 support.json')),
          error
            ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 } }, error)
            : null,
          result
            ? h('div', null,
              h('div', { style: { ...S.hint, marginTop: 12 } },
                result.created ? '已新建 kit ' : '已更新 kit ',
                h('strong', null, result.kitId),
                ' → ',
                h('span', { style: S.mono }, result.path)),
              h('div', { style: { ...S.row, marginTop: 10 } },
                h('button', { style: S.ghost, onClick: () => copy(JSON.stringify(result.support, null, 2), 'json') },
                  copied === 'json' ? '已复制' : '复制 JSON'),
                h('button', { style: S.ghost, onClick: download }, '下载 support.json')),
              h('pre', { style: S.pre }, JSON.stringify(result.support, null, 2)))
            : null));
    }

    // A wrench-and-tunnel glyph for the settings navigation row.
    function TunnelIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 3, y: 9, width: 6, height: 6, rx: 1.4 }),
        h('rect', { x: 15, y: 7, width: 6, height: 10, rx: 1.4 }),
        h('path', { d: 'M9 12h6' }),
        h('path', { d: 'M9 12h6', strokeOpacity: 0.45, strokeWidth: 4.2 }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // A top-level settings page, not a tab inside the built-in plugins page:
        // the operator needs to find it from the navigation directly.
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'support-tunnel', order: 45, label: '客户机隧道' },
          Panel,
        ));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
          { name: 'settings.section.icon', id: 'support-tunnel', order: 45, label: '客户机隧道' },
          TunnelIcon,
        ));
      },
    };
  },
});
