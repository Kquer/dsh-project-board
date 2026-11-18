window.__ModuleLoader__.load({
  id: 'dsh-project-board',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const ID = 'dsh-project-board'
    const KIND = 'project-board'
    const POLL_MS = 8000

    const CSS = `
.pb-root{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:14px;color:var(--dsw-alias-label-primary);font-size:13px;overflow:auto;scrollbar-width:thin}
.pb-head{display:flex;align-items:flex-start;gap:10px}
.pb-title{font-size:15px;font-weight:650;line-height:1.3}
.pb-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px;word-break:break-all}
.pb-refresh{margin-left:auto}
.pb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;border-radius:7px;padding:3px 9px;cursor:pointer;line-height:20px;white-space:nowrap}
.pb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pb-btn:disabled{opacity:.45;cursor:default}
.pb-primary{display:flex;align-items:center;justify-content:center;gap:7px;height:38px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color);text-decoration:none;font-weight:600;font-size:13px;border:0;cursor:pointer}
.pb-primary:hover{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-brand-primary))}
.pb-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:11px 12px}
.pb-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
.pb-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:9px;padding:8px 10px}
.pb-stat b{display:block;font-size:18px;line-height:1.25;font-weight:650}
.pb-stat span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.pb-url{display:flex;gap:6px;align-items:center;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:5px 7px}
.pb-url code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}
.pb-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.65}
.pb-error{border:1px solid var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:9px;padding:9px 11px;color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.6}
.pb-tag{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 7px}
.pb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.pb-dot.stale{background:var(--dsw-alias-state-warn-primary)}
`

    async function getJSON(url) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    function Launcher(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [index, setIndex] = useState(null)
      const [launch, setLaunch] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [copied, setCopied] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const query = sessionId === '' ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
          const [nextIndex, nextLaunch] = await Promise.all([
            getJSON(`/api/project-board.index${query}`),
            getJSON(`/api/project-board.launch${query}`),
          ])
          setIndex(nextIndex)
          setLaunch(nextLaunch)
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setLoading(false)
      }, [sessionId])

      useEffect(() => {
        load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') load()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const copy = async () => {
        if (!launch?.url) return
        try {
          await navigator.clipboard.writeText(launch.url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          setError('复制失败，请手动选中链接')
        }
      }

      const modules = index?.map?.modules || []
      const done = modules.filter(module => module.status === 'done').length
      const docs = index?.docs?.length ?? 0

      return h(
        'div',
        { className: 'pb-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'pb-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { className: 'pb-title' }, index?.projectName || '项目看板'),
            h('div', { className: 'pb-sub' }, index?.root || '正在解析当前会话的工作区…'),
          ),
          h('button', { className: 'pb-btn pb-refresh', onClick: load, disabled: loading }, loading ? '…' : '刷新'),
        ),
        error !== null ? h('div', { className: 'pb-error' }, error) : null,
        h(
          'div',
          { className: 'pb-stats' },
          [
            ['文档', docs],
            ['模块', modules.length],
            ['已完成', done],
          ].map(([label, value]) =>
            h('div', { key: label, className: 'pb-stat' },
              h('b', null, String(value)),
              h('span', null, label),
            ),
          ),
        ),
        launch?.url
          ? h('a', { className: 'pb-primary', href: launch.url, target: '_blank', rel: 'noreferrer noopener' }, '在浏览器打开看板 ↗')
          : h('button', { className: 'pb-primary', disabled: true }, '准备中…'),
        h(
          'div',
          { className: 'pb-card' },
          h('div', { className: 'pb-note' }, '主界面是独立网页：可全屏查看文档、缩放拖拽结构图、按状态筛选。DSH 侧栏只保留这个启动器。若没有自动弹出浏览器，点「复制链接」手动打开。'),
          launch?.url
            ? h(
                'div',
                { className: 'pb-url', style: { marginTop: '8px' } },
                h('code', { title: launch.url }, launch.url),
                h('button', { className: 'pb-btn', onClick: copy }, copied ? '已复制' : '复制链接'),
              )
            : null,
        ),
        index?.mapError
          ? h('div', { className: 'pb-error' }, index.mapError)
          : null,
        h(
          'div',
          { className: 'pb-note', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('i', { className: `pb-dot${error !== null ? ' stale' : ''}` }),
          error !== null ? '数据刷新失败，显示上次结果' : '只读 · 每 8 秒刷新',
        ),
      )
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const dispose = ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          keepMounted: true,
          title: () => '项目看板',
          guide: [
            {
              id: 'project-board',
              order: 12,
              title: () => '项目看板',
              description: () => '在浏览器全屏查看文档、结构图与日志',
            },
          ],
        })
        ctx.effect(() => dispose)

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Launcher),
        )

        function ComposerButton() {
          return h(
            'button',
            {
              type: 'button',
              title: '打开项目看板启动器',
              'aria-label': '打开项目看板',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                height: '24px',
                padding: '0 7px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '7px',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                font: 'inherit',
                fontSize: '11.5px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              },
              onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
              onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
              onClick: event => {
                event.preventDefault()
                try {
                  ctx.sidebarRight.openTab(KIND)
                } catch (failure) {
                  console.warn('[dsh-project-board] open launcher failed', failure)
                }
              },
            },
            h(
              'svg',
              { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
              h('rect', { x: 1, y: 1, width: 4, height: 4, rx: 1, fill: 'currentColor' }),
              h('rect', { x: 7, y: 1, width: 4, height: 4, rx: 1, fill: 'currentColor', opacity: 0.55 }),
              h('rect', { x: 1, y: 7, width: 4, height: 4, rx: 1, fill: 'currentColor', opacity: 0.55 }),
              h('rect', { x: 7, y: 7, width: 4, height: 4, rx: 1, fill: 'currentColor' }),
            ),
            '看板',
          )
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: `${ID}.open` }, ComposerButton),
        )
      },
    }
  },
})
