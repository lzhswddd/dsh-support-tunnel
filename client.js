/**
 * Settings → Plugins → Support tunnel
 *
 * The browser half has no service that can call into the Host, so everything
 * travels over the Web GUI's HTTP server: GET /api/support-tunnel/state and
 * POST /api/support-tunnel/export, both owner-only.
 */
window.__ModuleLoader__.load({
  id: '@local/support-tunnel',
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
      dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
      deviceRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 13,
      },
      deviceName: { width: 150, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      deviceId: { width: 104, flexShrink: 0, opacity: 0.65 },
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
      const [vncBusy, setVncBusy] = useState('');
      const [vncNotice, setVncNotice] = useState(null);

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

      const copy = useCallback(async (text, tag) => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(tag);
          setTimeout(() => setCopied(''), 1500);
        } catch {
          setCopied('失败');
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
                ? `${deviceName} 的画面已在新标签页打开（${data.address}）`
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

        h('div', { style: { ...S.card, marginTop: 14 } },
          h('h2', { style: S.h2 },
            devices.length ? `设备（${devices.filter((d) => d.online).length}/${devices.length} 在线）` : '设备'),
          devices.length === 0
            ? h('div', { style: S.hint }, '还没有 kit。在下面填个名字，会生成第一个。')
            : h('div', null, devices.flatMap((device) => {
              if (!device.online || !device.sessions.length) {
                return [h('div', { key: device.kitId, style: S.deviceRow },
                  h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-idle-primary)' } }),
                  h('span', { style: S.deviceName, title: device.name }, device.name),
                  h('span', { style: { ...S.mono, ...S.deviceId } }, device.kitId),
                  h('span', { style: { ...S.hint, flex: 1 } }, '离线'))];
              }
              // One row per machine, so "远程查看" always names a single session.
              return device.sessions.map((session) => h('div', { key: session.sessionKey, style: S.deviceRow },
                h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-success-primary)' } }),
                h('span', { style: S.deviceName, title: device.name }, session.clientHost || device.name),
                h('span', { style: { ...S.mono, ...S.deviceId } }, device.kitId),
                h('span', { style: { ...S.hint, flex: 1, wordBreak: 'break-all' } },
                  `${session.user || ''}　:${session.localPort}`),
                h('button', {
                  style: { ...S.ghost, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
                  disabled: vncBusy === session.sessionKey,
                  onClick: () => remoteView(
                    session.sessionKey,
                    session.clientHost || device.name,
                    hasViewer(device.kitId) ? 'stop' : 'start',
                  ),
                }, vncBusy === session.sessionKey
                    ? '开启中…'
                    : (hasViewer(device.kitId) ? '关闭远程' : '远程查看'))));
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
