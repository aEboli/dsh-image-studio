/**
 * client 半边：生图工作台（对齐参考截图：参考图 / 提示词 / 增强 / 生成 / 参数 / 当前调用 / OUTPUT PREVIEW / 胶片条）。
 *
 * 侧栏入口只画图标——宿主自己渲染「图标 + 文字 + 选中态」整行。
 * 网络只走本插件 host 的 /api/image-studio.* 同源路由，API Key 不进浏览器。
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-studio',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const { Switch, Menu, MenuItemButton, ImageLightbox } = require('@deepseek-ai/dsh-client-ui-primitives')

    const PANEL = 'image-studio'
    const BUILD = 'r18'   // 界面版本标记：显示在「当前调用」里，用来确认页面加载的是哪一版
    // 逐字对齐上游 lib/generation-size-options.mjs 的「比例 → 分辨率」档位。
    const RATIO_SIZES = {
      '1:1': ['1024x1024', '1536x1536', '2048x2048', '2560x2560', '2880x2880'],
      '4:3': ['1360x1024', '2048x1536', '2720x2048', '3312x2480'],
      '3:4': ['1024x1360', '1536x2048', '2048x2720', '2480x3312'],
      '3:2': ['1536x1024', '2304x1536', '3072x2048', '3520x2352'],
      '2:3': ['1024x1536', '1536x2304', '2048x3072', '2352x3520'],
      '5:4': ['1280x1024', '1920x1536', '2560x2048', '3200x2560'],
      '4:5': ['1024x1280', '1536x1920', '2048x2560', '2560x3200'],
      '16:9': ['1824x1024', '2736x1536', '3648x2048', '3840x2160'],
      '9:16': ['1024x1824', '1536x2736', '2048x3648', '2160x3840'],
      '21:9': ['2384x1024', '1680x720', '3584x1536', '3840x1648'],
      '9:21': ['1024x2384', '720x1680', '1536x3584', '1648x3840'],
      '2:1': ['2048x1024', '3072x1536', '3840x1920'],
      '1:2': ['1024x2048', '1536x3072', '1920x3840'],
      '3:1': ['3072x1024', '3840x1280'],
      '1:3': ['1024x3072', '1280x3840']
    }
    // 与原版一致：分辨率给具体像素值（1024 × 1024），不出现"自动"。
    const SIZES_BY_RATIO = RATIO_SIZES
    const RATIOS = Object.keys(SIZES_BY_RATIO)
    const QUALITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]
    // /images/edits 的 image 字段上限是 8 张，界面按同一上限约束。
    const MAX_REFERENCES = 8
    const MAX_IMAGES_PER_BATCH = 4
    const DEFAULT_QUALITY = 'high'
    // 单张参考图上限 4MB：base64 膨胀 4/3，8 张最坏 ~43MB，仍在 host 的 64MB 请求体限制内。
    const MAX_REFERENCE_BYTES = 4 * 1024 * 1024
    const IMAGE_COUNTS = [1, 2, 3, 4]
    /** 浏览器端并发小工具：限住同时打开的图片 fetch 数量。 */
    async function mapBounded(items, limit, mapper) {
      const list = Array.from(items || [])
      const out = new Array(list.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < list.length) {
          const index = cursor
          cursor += 1
          out[index] = await mapper(list[index], index)
        }
      }
      await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker))
      return out
    }
    const newBatchId = () => (window.crypto?.randomUUID?.()
      || `b${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

    const css = `
      .dshIs{--is-bg:#0a0a0b;--is-panel:#121214;--is-panel-2:#17171a;--is-line:rgba(255,255,255,.08);--is-line-2:rgba(255,255,255,.14);
        --is-text:#ececef;--is-dim:#8e8e96;--is-dim-2:#63636b;--is-accent:#8b7cf6;
        display:flex;flex-direction:column;height:100%;min-height:0;background:var(--is-bg);color:var(--is-text);
        font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
      .dshIs *{box-sizing:border-box}
      .dshIsBody{display:flex;flex:1;min-height:0}

      .dshIsPanel{width:312px;flex:none;display:flex;flex-direction:column;gap:12px;padding:12px 14px 12px;overflow:auto;background:var(--is-panel);border-right:1px solid var(--is-line)}
      .dshIsSec{display:flex;flex-direction:column;gap:8px}
      .dshIsHead{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--is-text);min-height:20px}
      .dshIsHead .dshIsGrow{flex:1;min-width:0}
      .dshIsMuted{color:var(--is-dim);font-size:11px}
      .dshIsGrow{flex:1;min-width:0}
      .dshIsBtn{height:26px;padding:0 9px;border:1px solid var(--is-line-2);border-radius:6px;background:transparent;color:var(--is-text);
        font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
      .dshIsBtn:hover:not(:disabled){background:rgba(255,255,255,.06)}
      .dshIsBtn:disabled{opacity:.45;cursor:not-allowed}

      .dshIsDrop{border:1px dashed var(--is-line-2);border-radius:8px;min-height:84px;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:8px;color:var(--is-dim);cursor:pointer;padding:10px}
      .dshIsDrop:hover{border-color:rgba(255,255,255,.28);color:var(--is-text)}
      .dshIsDropRow{display:flex;align-items:center;gap:8px;font-size:12px}
      .dshIsThumb{position:relative;width:56px;height:56px;border-radius:6px;overflow:hidden;border:1px solid var(--is-line-2);background:var(--is-panel-2)}
      .dshIsThumb img{width:100%;height:100%;object-fit:cover;display:block}
      .dshIsThumb button{position:absolute;top:1px;right:1px;width:16px;height:16px;border:0;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font-size:11px;line-height:16px;padding:0;cursor:pointer}
      .dshIsRefs{display:flex;flex-wrap:wrap;gap:8px}

      .dshIsTextarea{width:100%;min-height:118px;resize:vertical;padding:10px;border:1px solid var(--is-line-2);border-radius:8px;
        background:var(--is-panel-2);color:var(--is-text);font:inherit;font-size:13px;line-height:1.55;outline:none}
      .dshIsTextarea:focus{border-color:var(--is-accent)}
      .dshIsTextareaSmall{min-height:64px}
      .dshIsMeta{text-align:right;font-size:11px;color:var(--is-dim-2)}

      .dshIsCard{border:1px solid var(--is-line);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.02)}
      .dshIsCardRow{display:flex;align-items:center;gap:8px}
      .dshIsCardTitle{font-size:12px}
      .dshIsCardSub{font-size:11px;color:var(--is-dim-2)}

      .dshIsGenerate{height:38px;width:100%;border:0;border-radius:8px;background:var(--is-accent);color:#0b0b0c;
        font:inherit;font-size:13px;font-weight:600;cursor:pointer}
      .dshIsGenerate:hover:not(:disabled){filter:brightness(1.08)}
      .dshIsGenerate:disabled{opacity:.45;cursor:not-allowed}

      .dshIsGrid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
      .dshIsChip{height:28px;padding:0 2px;border:1px solid var(--is-line-2);border-radius:6px;background:transparent;color:var(--is-text);
        font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;text-align:center}
      .dshIsChip:hover{border-color:rgba(255,255,255,.3)}
      .dshIsChip[data-active="true"]{background:var(--is-text);border-color:var(--is-text);color:#111}

      .dshIsTwo{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .dshIsField{display:flex;flex-direction:column;gap:6px;min-width:0}
      .dshIsField>span{font-size:11px;color:var(--is-dim)}
      .dshIsSelect{height:30px;width:100%;padding:0 8px;border:1px solid var(--is-line-2);border-radius:6px;background:var(--is-panel-2);
        color:var(--is-text);font:inherit;font-size:12px;outline:none}
      .dshIsSelect:disabled{opacity:.55}
      .dshIsBgRow{display:flex;align-items:center;justify-content:space-between;gap:6px;height:30px;padding:0 8px;border:1px solid var(--is-line-2);
        border-radius:6px;background:var(--is-panel-2);font-size:12px}

      .dshIsInfo{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--is-line);border-radius:8px;background:rgba(255,255,255,.02)}
      .dshIsInfoRow{display:flex;gap:8px;font-size:11px;min-width:0}
      .dshIsInfoKey{width:72px;flex:none;color:var(--is-dim-2)}
      .dshIsInfoVal{flex:1;min-width:0;color:var(--is-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

      .dshIsStage{flex:1;min-width:0;display:flex;flex-direction:column;background:#050506}
      .dshIsCanvasWrap{position:relative;flex:1;min-height:0;display:flex}
      .dshIsCanvas{flex:1;min-height:0;display:flex;padding:14px;overflow:auto}
      /* margin:auto：小于容器时居中，放大到超出容器时仍能滚动到左上角 */
      .dshIsCanvas>*{margin:auto}
      .dshIsCanvas img{max-width:100%;max-height:100%;object-fit:contain;display:block;cursor:default}
      /* 生成中但画布已有图：右下角浮一个小进度徽标，不遮挡旧图 */
      .dshIsBusyBadge{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:8px;height:26px;padding:0 8px 0 10px;
        border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(12,12,14,.82);backdrop-filter:blur(6px);
        color:rgba(255,255,255,.86);font-size:11px;white-space:nowrap;z-index:2}
      .dshIsBusyBadge .dshIsSpinner{width:10px;height:10px;border-width:2px;margin-right:0}
      .dshIsBadgeCancel{height:18px;padding:0 7px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;
        color:rgba(255,255,255,.75);font:inherit;font-size:11px;cursor:pointer}
      .dshIsBadgeCancel:hover{background:rgba(255,255,255,.12)}
      .dshIsEmpty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
      .dshIsEyebrow{font-size:10px;letter-spacing:.18em;color:var(--is-dim-2)}
      .dshIsEmptyTitle{font-size:13px;color:var(--is-dim)}
      .dshIsEmptySub{font-size:11px;color:var(--is-dim-2)}

      /* 生成中：整块画布铺一张柔光背景，中间是云 + 百分比 + 状态 */
      .dshIsGenScene{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:6px}
      .dshIsGenScene::before{content:"";position:absolute;inset:-20%;
        background:
          radial-gradient(38% 34% at 42% 38%, rgba(255,186,120,.20), transparent 70%),
          radial-gradient(34% 30% at 62% 55%, rgba(150,190,140,.16), transparent 72%),
          radial-gradient(40% 40% at 50% 70%, rgba(120,120,160,.14), transparent 75%),
          linear-gradient(140deg,#171a17,#141216 60%,#101012);
        filter:blur(2px)}
      .dshIsGenInner{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--is-text)}
      .dshIsGenCloud{color:rgba(255,255,255,.92);animation:dshIsFloat 3s ease-in-out infinite}
      .dshIsGenPercent{font-size:13px;color:rgba(255,255,255,.92);margin-top:2px}
      .dshIsGenTrack{width:160px;height:4px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden;margin-top:8px}
      .dshIsGenFill{height:100%;background:linear-gradient(90deg,#8b7cf6,#c4b5fd);transition:width .5s ease}
      .dshIsCountRow{display:flex;gap:6px}
      .dshIsCountRow .dshIsChip{flex:1}
      .dshIsGenLabel{font-size:11px;color:rgba(255,255,255,.55)}
      .dshIsGenSub{font-size:11px;color:rgba(255,255,255,.34);margin-top:2px}
      .dshIsGenCancel{margin-top:10px;height:24px;padding:0 10px;border:1px solid rgba(255,255,255,.18);border-radius:6px;
        background:rgba(0,0,0,.25);color:rgba(255,255,255,.8);font:inherit;font-size:11px;cursor:pointer}
      .dshIsGenCancel:hover{background:rgba(255,255,255,.12)}
      @keyframes dshIsFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
      @keyframes dshIsSpin{to{transform:rotate(360deg)}}
      .dshIsSpinner{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;
        animation:dshIsSpin .8s linear infinite;display:inline-block;vertical-align:-2px;margin-right:6px}

      .dshIsBar{display:flex;align-items:center;gap:10px;height:44px;flex:none;padding:0 14px;background:var(--is-panel);
        border-top:1px solid var(--is-line);font-size:11px;color:var(--is-dim)}
      .dshIsPill{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:rgba(139,124,246,.18);
        color:#b9afff;font-size:11px;white-space:nowrap}
      .dshIsBarPrompt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--is-dim-2)}
      .dshIsBarAction{border:0;background:transparent;color:var(--is-dim);font:inherit;font-size:11px;cursor:pointer;padding:0 4px;white-space:nowrap}
      .dshIsBarAction:hover:not(:disabled){color:var(--is-text)}
      .dshIsBarAction:disabled{opacity:.35;cursor:not-allowed}

      .dshIsFilm{display:flex;align-items:flex-start;gap:8px;height:100px;flex:none;padding:9px 14px;overflow-x:auto;background:var(--is-panel);border-top:1px solid var(--is-line)}
      .dshIsFilmEmpty{font-size:11px;color:var(--is-dim-2);align-self:center}
      .dshIsFilmItem{width:64px;flex:none;display:flex;flex-direction:column;gap:3px;cursor:pointer}
      .dshIsFilmThumb{width:64px;height:64px;border-radius:4px;overflow:hidden;border:1px solid var(--is-line);background:var(--is-panel-2)}
      .dshIsFilmItem[data-active="true"] .dshIsFilmThumb{border-color:var(--is-accent);box-shadow:0 0 0 1px var(--is-accent)}
      .dshIsFilmThumb img{width:100%;height:100%;object-fit:cover;display:block}
      .dshIsFilmSize{font-size:10px;line-height:14px;color:var(--is-dim-2);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dshIsFilmItem[data-active="true"] .dshIsFilmSize{color:var(--is-text)}
      .dshIsFilmBusy{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:4px;
        border:1px solid var(--is-line-2);background:var(--is-panel-2);font-size:11px;color:rgba(255,255,255,.75)}

      .dshIsError{padding:8px 10px;border:1px solid rgba(255,90,90,.4);border-radius:6px;background:rgba(255,90,90,.08);
        color:#ff9b9b;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
      .dshIsToast{font-size:11px;color:var(--is-dim)}

      .dshIsOverlay{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
      .dshIsDialog{width:min(500px,calc(100vw - 40px));max-height:calc(100vh - 80px);overflow:auto;padding:18px;border-radius:12px;
        background:var(--is-panel);border:1px solid var(--is-line-2);display:flex;flex-direction:column;gap:14px;color:var(--is-text)}
      .dshIsDialogHead{display:flex;align-items:center;font-size:13px;font-weight:600}
      .dshIsDialog .dshIsField>span{font-size:11px;color:var(--is-dim)}
      .dshIsDialog input{height:32px;padding:0 9px;border:1px solid var(--is-line-2);border-radius:6px;background:var(--is-panel-2);
        color:var(--is-text);font:inherit;font-size:12px;outline:none;width:100%}
      .dshIsDialog input:focus{border-color:var(--is-accent)}
      .dshIsRowBtns{display:flex;gap:8px;align-items:center}
      .dshIsHint{font-size:11px;color:var(--is-dim-2);line-height:1.5}
      .dshIsEntryIcon{display:block;flex:none}

      .dshIsZoom{display:inline-flex;align-items:center;gap:2px;flex:none}
      .dshIsZoomValue{min-width:46px;text-align:center;color:var(--is-text);border-radius:4px}
      .dshIsZoomValue:hover:not(:disabled){background:rgba(255,255,255,.08)}

      /* 模板库：带搜索框的弹层列表（内置 10 条 + 导入的 520 条） */
      .dshIsTplDialog{width:min(560px,calc(100vw - 40px));gap:10px}
      .dshIsTplCount{font-size:11px;color:var(--is-dim-2)}
      .dshIsTplList{display:flex;flex-direction:column;gap:4px;max-height:46vh;overflow:auto;padding-right:2px}
      .dshIsTplItem{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:7px 9px;border:1px solid transparent;
        border-radius:6px;background:rgba(255,255,255,.03);color:var(--is-text);font:inherit;cursor:pointer;min-width:0}
      .dshIsTplItem:hover{border-color:var(--is-line-2);background:rgba(255,255,255,.07)}
      .dshIsTplName{font-size:12px}
      .dshIsTplBody{font-size:11px;color:var(--is-dim-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    `

    // 目录选择由宿主 uiWorkspace 服务提供；取不到时退化为手动粘贴路径。
    let pickDirectory = async () => null
    let pickerAvailable = false

    const api = path => `/api/image-studio${path}`
    async function request(path, body, signal) {
      const response = await fetch(path, body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' }, signal }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
      const raw = await response.text()
      let payload = null
      try { payload = JSON.parse(raw) } catch { payload = null }
      if (!response.ok) {
        const detail = payload?.error || raw?.slice(0, 300) || '(空响应)'
        const error = new Error(`HTTP ${response.status} · ${path}\n${detail}`)
        error.status = response.status
        throw error
      }
      return payload
    }
    async function call(pathWithQuery, body, signal) {
      // 查询串与路径分开处理：斜杠兜底要把「.assets」变成「/assets」，
      // 直接对整串 replaceAll('.') 会把 ?batch=a.b 这种值也改坏。
      const queryIndex = pathWithQuery.indexOf('?')
      const pathname = queryIndex < 0 ? pathWithQuery : pathWithQuery.slice(0, queryIndex)
      const query = queryIndex < 0 ? '' : pathWithQuery.slice(queryIndex)
      try {
        return await request(api(pathname + query), body, signal)
      } catch (cause) {
        // 点号路径未被宿主匹配时，退到斜杠路径再试一次。
        if (cause?.status === 404) {
          const slash = pathname.replace(/^\./, '/').replaceAll('.', '/')
          return await request(`/api/image-studio${slash}${query}`, body, signal)
        }
        throw cause
      }
    }
    // 同源静态图需要登录态，<img> 带不上；统一用带凭据的 fetch 取字节再转 Blob URL。
    // 缓存做 LRU：以前只增不减，长时间用下来 Blob URL 会一直占内存。
    const BLOB_CACHE_MAX = 80
    const imageBlobs = new Map()
    const blobKeyOf = item => item?.relPath || item?.name || item?.url
    function blobCachePut(key, url) {
      if (imageBlobs.has(key)) imageBlobs.delete(key)
      imageBlobs.set(key, url)
      while (imageBlobs.size > BLOB_CACHE_MAX) {
        const [oldestKey, oldestUrl] = imageBlobs.entries().next().value
        imageBlobs.delete(oldestKey)
        if (isBlobUrl(oldestUrl)) URL.revokeObjectURL(oldestUrl)
      }
    }
    async function hydrateImages(list) {
      const next = (list || []).map(item => (item ? { ...item } : item))
      // 30 张缩略图并行拉会打满浏览器同域连接数（也会挤掉正在轮询的进度请求），限到 6。
      await mapBounded(next, 6, async item => {
        if (!item?.name || item.localUrl) return
        const key = blobKeyOf(item)
        const cached = key ? imageBlobs.get(key) : null
        if (cached) {
          // LRU touch
          imageBlobs.delete(key); imageBlobs.set(key, cached)
          item.localUrl = cached
          return
        }
        try {
          // 必须用 relPath：日期子目录里的图用裸文件名会 404。
          const target = item.relPath || item.name
          const response = await fetch(`/api/image-studio.image?file=${encodeURIComponent(target)}`)
          if (!response.ok) return
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          if (key) blobCachePut(key, url)
          item.localUrl = url
        } catch {
          /* 单张失败不影响其它图 */
        }
      })
      return next.filter(Boolean)
    }
    const srcOf = image => image?.localUrl
      || (image?.kind === 'url' ? image.url : `data:${image?.mime || 'image/png'};base64,${image?.data || ''}`)

    // ---- 参数持久化（localStorage）------------------------------------------------
    const STORAGE_KEY = 'dsh-image-studio:v1'
    const ZOOM_MIN = 0.2
    const ZOOM_MAX = 4
    const clampZoom = value => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(value) ? value : 1))

    /** 恢复上次的参数；localStorage 不可用时静默退回默认值。 */
    function loadStoredState() {
      let raw = null
      try {
        const text = window.localStorage.getItem(STORAGE_KEY)
        raw = text ? JSON.parse(text) : null
      } catch {
        raw = null
      }
      if (!raw || typeof raw !== 'object') raw = {}
      const ratio = RATIOS.includes(raw.ratio) ? raw.ratio : '1:1'
      const sizes = RATIO_SIZES[ratio] || []
      // 比例与尺寸必须自洽：不属于该比例的档位回落到首档。
      const size = sizes.includes(raw.size) ? raw.size : (sizes[0] || '')
      const quality = QUALITIES.some(([value]) => value === raw.quality) ? raw.quality : DEFAULT_QUALITY
      return {
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        enhancerId: typeof raw.enhancerId === 'string' ? raw.enhancerId : '',
        enhanceEnabled: raw.enhanceEnabled === true,
        enhanceText: typeof raw.enhanceText === 'string' ? raw.enhanceText : '',
        ratio,
        size,
        quality,
        transparent: raw.transparent === true,
        imageCount: IMAGE_COUNTS.includes(Number(raw.imageCount)) ? Number(raw.imageCount) : 1,
        // 只有用户没在界面上选过张数时，才用「设置里的默认张数」覆盖。
        hasImageCount: IMAGE_COUNTS.includes(Number(raw.imageCount))
      }
    }
    const restored = loadStoredState()

    let persistTimer = 0
    let persistPending = null
    function flushPersist() {
      if (persistTimer) { window.clearTimeout(persistTimer); persistTimer = 0 }
      if (!persistPending) return
      const payload = persistPending
      persistPending = null
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      } catch {
        /* 隐私模式 / 配额满：不影响生图 */
      }
    }
    function schedulePersist(payload) {
      persistPending = payload
      if (persistTimer) window.clearTimeout(persistTimer)
      persistTimer = window.setTimeout(flushPersist, 300)
    }

    // ---- 小工具 -------------------------------------------------------------------
    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error || new Error('读取参考图失败'))
        reader.readAsDataURL(blob)
      })
    }
    const isBlobUrl = value => typeof value === 'string' && value.startsWith('blob:')
    const seconds = ms => `${Math.round(Number(ms) / 1000)}s`
    /** 「上游 62s（JSON 58s / 取图 2s）· 总计 63s」——缺哪个字段就不显示哪段。 */
    function timingText(meta) {
      const upstream = Number(meta?.upstreamMs)
      if (!Number.isFinite(upstream) || upstream <= 0) return '—'
      const details = []
      if (meta.jsonMs !== null && meta.jsonMs !== undefined && Number.isFinite(Number(meta.jsonMs))) details.push(`JSON ${seconds(meta.jsonMs)}`)
      if (meta.fileMs !== null && meta.fileMs !== undefined && Number.isFinite(Number(meta.fileMs))) details.push(`取图 ${seconds(meta.fileMs)}`)
      const total = Number.isFinite(Number(meta?.totalMs)) ? Number(meta.totalMs) : upstream
      // 有拆分括号时紧接「·」，没有括号时留一个空格：上游 62s（JSON 58s / 取图 2s）· 总计 63s
      const head = `上游 ${seconds(upstream)}${details.length > 0 ? `（${details.join(' / ')}）` : ''}`
      return `${head}${details.length > 0 ? '' : ' '}· 总计 ${seconds(total)}`
    }
    const timingTitle = meta => Number(meta?.upstreamMs) > 0
      ? `upstream ${Math.round(meta.upstreamMs)}ms · json ${Math.round(Number(meta.jsonMs) || 0)}ms · file ${Math.round(Number(meta.fileMs) || 0)}ms · total ${Math.round(Number(meta.totalMs) || Number(meta.upstreamMs))}ms`
      : ''
    const sizeLabel = image => image?.width && image?.height ? `${image.width}×${image.height}` : '—'
    /** 进度百分比：有真实批次进度用真实值，否则退回按时间估算的“软进度”。 */
    function progressPercent(progress, elapsed) {
      if (progress && Number.isFinite(Number(progress.percent))) return Math.min(99, Math.max(2, Number(progress.percent)))
      return Math.min(95, Math.max(1, Math.round(elapsed / 0.9)))
    }
    function progressSub(progress, ratioLabel, sizeLabel2, elapsed) {
      if (progress) return `${progress.completed}/${progress.requested} 张已完成 · 已用 ${elapsed}s · ${ratioLabel} · ${sizeLabel2}`
      if (elapsed < 8) return '排队中：已提交到服务队列，等待后台生成'
      return `已提交，等待上游返回 · 已用 ${elapsed}s · ${ratioLabel} · ${sizeLabel2}`
    }

    function PickerMenu({ label, options, onSelect }) {
      const [open, setOpen] = React.useState(false)
      const trigger = h('button', { type: 'button', className: 'dshIsBtn', onClick: () => setOpen(v => !v) }, label)
      if (!open) return trigger
      return h(Menu, {
        open, anchor: trigger, align: 'start', side: 'bottom', portal: true,
        onClose: () => setOpen(false),
        children: options.map(option => h(MenuItemButton, {
          key: option.id,
          onSelect: () => { setOpen(false); onSelect(option.id) }
        }, option.name))
      })
    }

    /**
     * 模板库弹层：内置 10 条与导入的 520 条一视同仁，按 name / body 过滤。
     * 用自绘 overlay（官方 Menu 不适合放搜索框和长列表）。
     */
    function TemplatePicker({ templates, onSelect, onClose }) {
      const [query, setQuery] = React.useState('')
      const inputRef = React.useRef(null)
      React.useEffect(() => { inputRef.current?.focus() }, [])
      React.useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      const needle = query.trim().toLowerCase()
      const matched = needle
        ? templates.filter(item => `${item?.name || ''}\n${item?.body || ''}`.toLowerCase().includes(needle))
        : templates
      // 520 条全量挂到 DOM 会卡顿，最多渲染 300 条，其余用搜索缩小范围。
      const shown = matched.slice(0, 300)
      return h('div', {
        className: 'dshIsOverlay',
        onClick: event => { if (event.target === event.currentTarget) onClose() }
      },
        h('div', { className: 'dshIsDialog dshIsTplDialog' },
          h('div', { className: 'dshIsDialogHead' },
            h('span', { className: 'dshIsGrow' }, '模板库'),
            h('button', { type: 'button', className: 'dshIsBtn', onClick: onClose }, '关闭')
          ),
          h('input', {
            ref: inputRef,
            className: 'dshIsTplSearch',
            value: query,
            placeholder: '搜索模板名称或内容…',
            onChange: event => setQuery(event.target.value)
          }),
          h('div', { className: 'dshIsTplCount' },
            needle
              ? `匹配 ${matched.length} / 共 ${templates.length} 条`
              : `共 ${templates.length} 条`
          ),
          h('div', { className: 'dshIsTplList' },
            shown.length === 0
              ? h('div', { className: 'dshIsHint' }, '没有匹配的模板')
              : shown.map(item => h('button', {
                  key: item.id,
                  type: 'button',
                  className: 'dshIsTplItem',
                  title: item.name || item.id,
                  onClick: () => { onClose(); onSelect(item.id) }
                },
                  h('div', { className: 'dshIsTplName' }, item.name || item.id),
                  h('div', { className: 'dshIsTplBody' }, String(item.body || '').replace(/\s+/gu, ' ').slice(0, 160))
                ))
          ),
          matched.length > shown.length
            ? h('div', { className: 'dshIsHint' }, `列表只显示前 ${shown.length} 条，继续输入关键字可缩小范围。`)
            : null
        )
      )
    }

    // 工作台状态放在组件外：切走再切回来不会丢提示词、参数和已生成的图。
    const persisted = {
      prompt: restored.prompt,
      enhancerId: restored.enhancerId,
      enhanceEnabled: restored.enhanceEnabled,
      enhanceText: restored.enhanceText,
      ratio: restored.ratio,
      size: restored.size,
      quality: restored.quality,
      transparent: restored.transparent,
      imageCount: restored.imageCount,
      references: [],
      images: [],
      activeImage: 0,
      busy: false,
      startedAt: 0,
      batchId: '',
      progress: null,
      lastTiming: null
    }

    function StudioPage() {
      const [settings, setSettings] = React.useState(null)
      const [assets, setAssets] = React.useState({ templates: [], enhancers: [] })
      const [prompt, setPrompt] = React.useState(persisted.prompt)
      const [enhancerId, setEnhancerId] = React.useState(persisted.enhancerId)
      const [enhanceEnabled, setEnhanceEnabled] = React.useState(persisted.enhanceEnabled)
      const [enhanceText, setEnhanceText] = React.useState(persisted.enhanceText)
      const [ratio, setRatio] = React.useState(persisted.ratio)
      const [size, setSize] = React.useState(persisted.size)
      const [quality, setQuality] = React.useState(persisted.quality)
      const [transparent, setTransparent] = React.useState(persisted.transparent)
      const [imageCount, setImageCount] = React.useState(persisted.imageCount)
      const [progress, setProgress] = React.useState(persisted.progress)
      const [saving, setSaving] = React.useState(false)
      const [references, setReferences] = React.useState(persisted.references)
      const [busy, setBusy] = React.useState(persisted.busy)
      const [elapsed, setElapsed] = React.useState(
        persisted.busy && persisted.startedAt ? Math.round((Date.now() - persisted.startedAt) / 1000) : 0
      )
      const abortRef = React.useRef(null)
      const [error, setError] = React.useState('')
      const [composed, setComposed] = React.useState('')
      const [images, setImages] = React.useState(persisted.images)
      const [activeImage, setActiveImage] = React.useState(persisted.activeImage)
      const [lightbox, setLightbox] = React.useState(null)
      // 生成中默认铺生成动画；只有用户主动点了旧图才显示图（可一键回到生成）。
      const [viewDuringBusy, setViewDuringBusy] = React.useState(false)
      const [showSettings, setShowSettings] = React.useState(false)
      const [showTemplates, setShowTemplates] = React.useState(false)
      const [lastTiming, setLastTiming] = React.useState(persisted.lastTiming)
      const [draft, setDraft] = React.useState({ baseUrl: '', apiKey: '', imageModel: '', outputDir: '', maxConcurrentImages: 3, defaultImageCount: 1 })
      const [models, setModels] = React.useState([])
      const [modelsBusy, setModelsBusy] = React.useState(false)
      const [toast, setToast] = React.useState('')
      const [zoom, setZoom] = React.useState(1)
      const [stage, setStage] = React.useState({ w: 0, h: 0 })
      const [natural, setNatural] = React.useState(null)
      const fileRef = React.useRef(null)
      const progressTimerRef = React.useRef(0)
      const canvasRef = React.useRef(null)
      const generatingRef = React.useRef(false)
      // 切图/换比例时自动回到「适配」；用户手动缩放后不再自动改。
      const fitRef = React.useRef(true)
      const referencesRef = React.useRef(references)

      const notify = message => { setToast(message); window.setTimeout(() => setToast(''), 1800) }

      // 每次渲染后把界面状态写回模块级快照（切面板卸载也不会丢）。
      React.useEffect(() => {
        Object.assign(persisted, {
          prompt, enhancerId, enhanceEnabled, enhanceText, ratio, size, quality,
          transparent, imageCount, references, images, activeImage, lastTiming, progress
        })
      })
      referencesRef.current = references

      // 参数落 localStorage（防抖 300ms，切走时立即刷盘）。
      React.useEffect(() => {
        schedulePersist({ prompt, ratio, size, quality, transparent, enhanceEnabled, enhanceText, enhancerId, imageCount })
      }, [prompt, ratio, size, quality, transparent, enhanceEnabled, enhanceText, enhancerId, imageCount])

      React.useEffect(() => () => {
        flushPersist()
        // 卸载就回收 Blob URL；File 对象仍在内存里，下次挂载会重建 URL。
        for (const item of referencesRef.current) {
          if (isBlobUrl(item?.url)) URL.revokeObjectURL(item.url)
        }
        for (const item of persisted.references) {
          if (item && isBlobUrl(item.url)) item.url = null
        }
      }, [])

      // 从模块级快照恢复回来时，blob: URL 已在卸载时被 revoke，这里按 File 重建。
      React.useEffect(() => {
        setReferences(list => {
          let changed = false
          const next = list.map(item => {
            if (!item || item.url || !item.blob) return item
            changed = true
            return { ...item, url: URL.createObjectURL(item.blob) }
          })
          return changed ? next : list
        })
      }, [])

      const mergeImages = list => {
        const map = new Map()
        for (const item of [...list, ...persisted.images]) {
          if (!item) continue
          const key = item.url || item.name || `${item.kind}-${map.size}`
          if (!map.has(key)) map.set(key, item)
        }
        return [...map.values()]
      }

      /**
       * 拉画廊并合并进当前列表（不粗暴覆盖，用户正在看的那张不会闪掉）。
       * fresh=true 时以磁盘为准整体替换（初始化/删除后用）。
       */
      const loadGallery = async (options = {}) => {
        try {
          const payload = await call('.gallery')
          const list = await hydrateImages(payload.images || [])
          if (options.fresh) {
            persisted.images = list
            setImages(list)
            if (options.resetActive) setActiveImage(0)
            return list
          }
          setImages(prev => {
            const seen = new Set(prev.map(item => item.relPath || item.name))
            const added = list.filter(item => !seen.has(item.relPath || item.name))
            if (added.length === 0) return prev
            const next = [...added, ...prev]
            persisted.images = next
            return next
          })
          return list
        } catch {
          /* 画廊加载失败不影响生成 */
          return []
        }
      }

      /** 生成中轮询真实进度：完成后停止；失败/取消不打断界面。 */
      const startProgressPolling = batchId => {
        stopProgressPolling()
        if (!batchId) return
        let misses = 0
        progressTimerRef.current = window.setInterval(async () => {
          try {
            const data = await call(`.progress?batch=${encodeURIComponent(batchId)}`)
            if (data?.code) throw new Error(data.error || 'no progress')
            misses = 0
            const done = Number(data.completed) || 0
            const total = Number(data.requested) || 1
            const next = {
              completed: done,
              requested: total,
              generated: Number(data.generated) || 0,
              elapsedMs: Number(data.elapsedMs) || (Date.now() - (persisted.startedAt || Date.now())),
              percent: Math.min(96, Math.max(2, Math.round(((done + 0.5) / total) * 100))),
              real: done >= total
            }
            persisted.progress = next
            setProgress(next)
            if (data.finished) stopProgressPolling()
          } catch {
            // host 明确说批次不存在才停；瞬时错误继续轮询，避免生成中途进度条突然死掉。
            if (++misses > 8) stopProgressPolling()
          }
        }, 900)
      }
      const stopProgressPolling = () => {
        if (progressTimerRef.current) {
          window.clearInterval(progressTimerRef.current)
          progressTimerRef.current = 0
        }
      }
      React.useEffect(() => stopProgressPolling, [])

      React.useEffect(() => {
        let alive = true
        Promise.all([call('.settings'), call('.assets')])
          .then(([config, library]) => {
            if (!alive) return
            setSettings(config)
            setDraft({
              baseUrl: config.baseUrl || '',
              apiKey: '',
              imageModel: config.imageModel || '',
              outputDir: config.outputDir || '',
              maxConcurrentImages: config.maxConcurrentImages || 3,
              defaultImageCount: config.defaultImageCount || 1
            })
            if (!restored.hasImageCount && IMAGE_COUNTS.includes(config.defaultImageCount)) setImageCount(config.defaultImageCount)
            setAssets({ templates: library.templates || [], enhancers: library.enhancers || [] })
            // 有持久化的增强文本就尊重用户的，不再被第一个预设覆盖。
            const first = (library.enhancers || [])[0]
            const saved = restored.enhancerId
              ? (library.enhancers || []).find(item => item.id === restored.enhancerId)
              : null
            if (saved && !restored.enhanceText) setEnhanceText(saved.text)
            else if (first && !saved && !restored.enhancerId) { setEnhancerId(first.id); setEnhanceText(first.text) }
            if (config.configured) void refreshModels({ silent: true })
            else if (!config.keyPresent) setShowSettings(true)
            void loadGallery({ fresh: true, resetActive: true })
          })
          .catch(cause => { if (alive) setError(String(cause.message || cause)) })
        return () => { alive = false }
      }, [])

      // 切走再回来：上一批还在 host 里跑（abortRef 属于旧实例），这里接回它的进度轮询。
      React.useEffect(() => {
        if (persisted.busy && persisted.batchId && !abortRef.current) startProgressPolling(persisted.batchId)
      }, [])

      // 生成期间计时，配合画布上的动效显示已用时间（切走再回来接着算）。
      React.useEffect(() => {
        if (!busy) { setElapsed(0); return undefined }
        const started = persisted.startedAt || Date.now()
        persisted.startedAt = started
        const tick = () => setElapsed(Math.round((Date.now() - started) / 1000))
        tick()
        const timer = window.setInterval(tick, 500)
        return () => window.clearInterval(timer)
      }, [busy])

      React.useEffect(() => {
        const parts = []
        if (prompt.trim()) parts.push(prompt.trim())
        parts.push(`Aspect ratio: ${ratio}.`)
        if (transparent) parts.push('背景透明。')
        if (enhanceEnabled && enhanceText.trim()) parts.push(enhanceText.trim())
        setComposed(parts.join('\n\n'))
      }, [prompt, ratio, enhanceEnabled, enhanceText, transparent])

      const refreshModels = async (options = {}) => {
        setModelsBusy(true)
        try {
          const payload = await call('.models', { baseUrl: draft.baseUrl || undefined, apiKey: draft.apiKey || undefined })
          setModels(payload.models || [])
          if (!options.silent) notify(payload.models?.length ? `拿到 ${payload.models.length} 个模型` : '没有拉到模型')
          return payload.models || []
        } catch (cause) {
          if (!options.silent) setError(String(cause.message || cause))
          return []
        } finally {
          setModelsBusy(false)
        }
      }

      // 参考图预览用 Blob URL（不把几 MB 的 dataURL 常驻内存），提交时才转 base64。
      const absorb = async files => {
        const accepted = []
        let rejected = 0
        for (const item of files) {
          if (!String(item?.type || '').startsWith('image/')) continue
          // 参考图按 base64 直传（上限 8 张 / 64MB 请求体），单张超 4MB 直接挡在浏览器，省一次失败往返。
          if (item.size > MAX_REFERENCE_BYTES) { rejected += 1; continue }
          accepted.push(item)
          if (references.length + accepted.length >= MAX_REFERENCES) break
        }
        if (accepted.length > 0) {
          // 上限判断放在函数式更新里：连点两次上传也不会超 8 张。
          setReferences(list => {
            const room = Math.max(0, MAX_REFERENCES - list.length)
            if (room === 0) { notify(`参考图最多 ${MAX_REFERENCES} 张`); return list }
            if (accepted.length > room) notify(`参考图最多 ${MAX_REFERENCES} 张，已保留前 ${room} 张`)
            return [
              ...list,
              ...accepted.slice(0, room).map((item, offset) => ({
                id: `${Date.now()}-${list.length + offset}`,
                name: item.name || 'reference.png',
                mime: item.type || 'image/png',
                blob: item,
                url: URL.createObjectURL(item)
              }))
            ]
          })
        }
        if (rejected > 0) setError(`有 ${rejected} 张图超过 ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)}MB，已跳过（可先在外部压缩）`)
      }

      const removeReference = id => {
        const target = references.find(item => item.id === id)
        if (isBlobUrl(target?.url)) URL.revokeObjectURL(target.url)
        setReferences(list => list.filter(item => item.id !== id))
      }

      /** 把画布当前这张图拉成 Blob 加进参考图（同源 URL → Blob URL，编辑走 multipart）。 */
      const addCurrentAsReference = async () => {
        if (!current) return
        if (references.length >= MAX_REFERENCES) { notify(`参考图最多 ${MAX_REFERENCES} 张`); return }
        try {
          const response = await fetch(srcOf(current))
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const blob = await response.blob()
          // 与拖拽上传同一套上限：8 张 / 单张 4MB，别把超限的图塞进 multipart。
          if (blob.size > MAX_REFERENCE_BYTES) { setError(`这张图 ${Math.round(blob.size / 1024 / 1024)}MB，超过参考图上限 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB`); return }
          setReferences(list => list.length >= MAX_REFERENCES ? list : [...list, {
            id: `img-${Date.now()}`,
            name: current.name || 'generated.png',
            mime: blob.type || 'image/png',
            blob,
            url: URL.createObjectURL(blob)
          }])
          notify('已加入参考图')
        } catch (cause) {
          setError(`添加到参考图失败：${cause?.message || cause}`)
        }
      }

      /** 提交前才把 Blob 转成 dataURL；单张失败不拖垮整次生成。 */
      const collectReferenceImages = async () => {
        // 8 张各读 FileReader 串行会等好几秒；限 4 路并发，结果按原顺序保留。
        const picked = references.slice(0, MAX_REFERENCES)
        const mapped = await mapBounded(picked, 4, async item => {
          try {
            const dataUrl = item.blob ? await blobToDataUrl(item.blob) : item.dataUrl
            return dataUrl ? { name: item.name || 'reference.png', dataUrl } : null
          } catch {
            /* 跳过读不出来的那张 */
            return null
          }
        })
        return mapped.filter(Boolean)
      }

      const applyTemplate = async id => {
        try {
          const preview = await call('.compose', { templateId: id, ratio, enhancerId: enhanceEnabled ? enhancerId : undefined })
          setPrompt(preview.prompt.replace(/\n\nAspect ratio: [^\n]+\.$/u, '').replace(/\n\nQuality only[\s\S]*$/u, ''))
          notify('已套用模板')
        } catch (cause) {
          setError(String(cause.message || cause))
        }
      }

      const generate = async () => {
        // 同步防重：双击或状态未刷新时不再发第二个请求。
        if (generatingRef.current || persisted.busy) return
        generatingRef.current = true
        setBusy(true); setError('')
        setViewDuringBusy(false)
        persisted.busy = true
        persisted.startedAt = Date.now()
        persisted.progress = null
        setProgress(null)
        const controller = new AbortController()
        abortRef.current = controller
        const batchId = newBatchId()
        // 记进模块级快照：切走再回来（组件重挂载）还能继续轮询这一批的进度、也能取消。
        persisted.batchId = batchId
        let timedOut = false
        const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 330000)
        startProgressPolling(batchId)
        try {
          if (!configured) throw new Error('尚未配置通道：点「设置」填 Base URL / Key 并保存')
          const referenceImages = await collectReferenceImages()
          const payload = await request(api('.generate'), {
            prompt: prompt.trim() || undefined,
            ratio,
            size,
            quality,
            transparent,
            n: imageCount,
            concurrency: settings?.maxConcurrentImages || undefined,
            batchId,
            enhancerId: enhanceEnabled ? enhancerId : undefined,
            enhance: enhanceEnabled,
            enhanceText: enhanceEnabled && enhanceText.trim() ? enhanceText.trim() : undefined,
            referenceImages
          }, controller.signal)
          const nextImages = await hydrateImages(payload.images || [])
          // 新图放最前；保留旧画廊里的其它图（增量合并，不整表替换）。
          setImages(prev => {
            const seen = new Set(nextImages.map(item => item.relPath || item.name))
            const kept = prev.filter(item => !seen.has(item.relPath || item.name))
            const merged = [...nextImages, ...kept]
            persisted.images = merged
            return merged
          })
          persisted.activeImage = 0
          setActiveImage(0)
          setViewDuringBusy(false)
          const savedCount = (payload.saved || []).length
          const failedCount = Number(payload.meta?.failed) || 0
          if (savedCount > 0) notify(`已保存 ${savedCount} 张到 ${payload.saved[0].path}`)
          if (failedCount > 0) notify(`${failedCount} 张失败，其余已保存`)
          if (payload.meta?.upstreamMs) {
            persisted.lastTiming = payload.meta
            setLastTiming(payload.meta)
            setToast(`完成：${timingText(payload.meta)}`)
            window.setTimeout(() => setToast(''), 4000)
          }
          void loadGallery()
        } catch (cause) {
          setError(cause?.name === 'AbortError' || timedOut
            ? (timedOut ? '生成超时（超过 330 秒未返回），可稍后重试' : '已取消')
            : String(cause.message || cause))
        } finally {
          window.clearTimeout(timer)
          stopProgressPolling()
          abortRef.current = null
          generatingRef.current = false
          persisted.batchId = ''
          persisted.busy = false
          persisted.startedAt = 0
          persisted.progress = null
          setProgress(null)
          setBusy(false)
        }
      }

      /**
       * 取消当前批次。
       * 本组件还持有 fetch 时直接断开请求（宿主会把 abort 传到上游）；
       * 切走再回来的情况下 fetch 属于上一个实例，只能走 host 的按 batchId 取消。
       */
      const cancelGenerate = async () => {
        if (abortRef.current) {
          abortRef.current.abort()
          notify('已取消')
          return
        }
        const id = persisted.batchId
        if (!id) { notify('没有可取消的批次'); return }
        try {
          await call('.cancel', { batchId: id })
          notify('已取消')
        } catch (cause) {
          // 409 = 批次其实已经跑完；404 = 进度表里已经过期回收。都不是错误。
          const code = cause?.status === 409 ? 'BATCH_DONE' : null
          notify(code ? '这一批已经完成了' : String(cause.message || cause))
        }
      }

      const saveSettings = async () => {
        // 用独立的 saving 态：以前借用 busy，导致“保存设置”期间整个界面当成正在生成。
        setSaving(true); setError('')
        try {
          const next = await call('.settings', {
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
            imageModel: draft.imageModel,
            outputDir: draft.outputDir,
            maxConcurrentImages: draft.maxConcurrentImages,
            defaultImageCount: draft.defaultImageCount,
            revision: settings?.revision
          })
          setSettings(next)
          setShowSettings(false)
          notify('已保存')
          if (next.configured) void refreshModels({ silent: true })
          else if (!next.configured) notify('配置已保存，但还缺 Base URL 或 Key')
        } catch (cause) {
          if (cause?.status === 409) {
            // 别处改过配置：拉最新再提示，用户不必自己关窗重开。
            setError('配置已在别处修改，已重新拉取最新设置，请确认后再保存')
            try {
              const latest = await call('.settings')
              setSettings(latest)
              setDraft({
                baseUrl: latest.baseUrl || '',
                apiKey: '',
                imageModel: latest.imageModel || '',
                outputDir: latest.outputDir || '',
                maxConcurrentImages: latest.maxConcurrentImages || 3,
                defaultImageCount: latest.defaultImageCount || 1
              })
            } catch { /* 拉不到就保留当前草稿 */ }
          } else {
            setError(String(cause.message || cause))
          }
        } finally {
          setSaving(false)
        }
      }

      const current = images[activeImage]
      const showImage = Boolean(current) && (!busy || viewDuringBusy)
      const configured = Boolean(settings?.configured)
      const modelOptions = models.length > 0 ? models : (settings?.imageModel ? [settings.imageModel] : [])
      const sizes = RATIO_SIZES[ratio] || []
      const effectiveSize = size || sizes[0] || ''

      // ---- 画布缩放 -----------------------------------------------------------------
      const currentKey = current ? (current.url || current.name || '') : ''
      const fitZoom = natural && natural.w > 0 && stage.w > 0
        ? clampZoom(Math.min((stage.w - 28) / natural.w, (stage.h - 28) / natural.h))
        : 1
      const zoomPercent = Math.round(zoom * 100)
      const imageStyle = natural && natural.w > 0
        ? {
            width: `${Math.max(1, Math.round(natural.w * zoom))}px`,
            height: `${Math.max(1, Math.round(natural.h * zoom))}px`,
            maxWidth: 'none',
            maxHeight: 'none'
          }
        : undefined

      // 容器尺寸变化 → 重新计算「适配」比例（ResizeObserver 不可用时退回 window.resize）。
      React.useEffect(() => {
        const el = canvasRef.current
        if (!el) return undefined
        const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
        measure()
        if (typeof ResizeObserver === 'undefined') {
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
      }, [])

      // 换图：清掉上一张的自然尺寸，并标记「下一次按适配显示」。
      React.useEffect(() => {
        fitRef.current = true
        setNatural(null)
      }, [currentKey])

      React.useEffect(() => {
        if (!fitRef.current || !natural || stage.w <= 0) return
        setZoom(fitZoom)
      }, [natural, fitZoom])

      // 滚轮缩放：React 的 onWheel 走 passive 监听，preventDefault 无效，这里挂原生监听。
      React.useEffect(() => {
        const el = canvasRef.current
        if (!el) return undefined
        const onWheel = event => {
          if (!current) return
          event.preventDefault()
          fitRef.current = false
          setZoom(value => clampZoom(value * (event.deltaY > 0 ? 1 / 1.12 : 1.12)))
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      }, [currentKey])

      const zoomTo = value => { fitRef.current = false; setZoom(clampZoom(value)) }
      const fitToView = () => { fitRef.current = true; setZoom(fitZoom) }
      const resetZoom = () => { fitRef.current = false; setZoom(1) }

      const changeRatio = value => {
        setRatio(value)
        // 比例变了但尺寸不属于该比例时才回落到首档，避免每次点比例都重置尺寸。
        const list = SIZES_BY_RATIO[value] || []
        if (!list.includes(size)) setSize(list[0] || '')
      }

      /** 删除：确认 → 调 .delete → 成功再从列表移除，选中项落到相邻那张。 */
      const deleteCurrent = async () => {
        if (!current) return
        if (!window.confirm(`删除「${current.name || '当前图片'}」？\n\n文件会从输出目录里删除，操作无法撤销。`)) return
        const index = images.indexOf(current)
        try {
          const target = current.relPath || current.name
        if (target) await call('.delete', { name: target })
        } catch (cause) {
          // 404 = 文件已经不在了，按删除成功处理（列表里那张本来就是死的）。
          if (cause?.status !== 404) {
            setError(`删除失败：${cause?.message || cause}`)
            return
          }
        }
        const key = current.relPath || current.name
        if (key && imageBlobs.has(key)) {
          const stale = imageBlobs.get(key)
          imageBlobs.delete(key)
          if (isBlobUrl(stale)) URL.revokeObjectURL(stale)
        }
        if (isBlobUrl(current.localUrl)) URL.revokeObjectURL(current.localUrl)
        const rest = images.filter(item => item !== current)
        const nextIndex = rest.length === 0 ? 0 : Math.max(0, Math.min(index < 0 ? 0 : index, rest.length - 1))
        setImages(rest)
        setActiveImage(nextIndex)
        notify('已删除')
      }

      return h('div', { className: 'dshIs' },
        h('div', { className: 'dshIsBody' },
          h('aside', { className: 'dshIsPanel' },
            // 参考图
            h('div', { className: 'dshIsSec' },
              h('div', { className: 'dshIsHead' },
                h('span', { className: 'dshIsGrow' }, '参考图'),
                h('span', { className: 'dshIsMuted' }, `${references.length} / ${MAX_REFERENCES}`)
              ),
              references.length === 0
                ? h('div', {
                    className: 'dshIsDrop',
                    onClick: () => fileRef.current?.click(),
                    onDragOver: event => event.preventDefault(),
                    onDrop: event => { event.preventDefault(); void absorb([...event.dataTransfer.files]) }
                  },
                  h('div', { className: 'dshIsDropRow' }, '拖入图片或点击上传'),
                  h('button', { type: 'button', className: 'dshIsBtn' }, '上传参考图')
                )
                : h('div', { className: 'dshIsRefs' },
                    references.map(item => h('div', { key: item.id, className: 'dshIsThumb' },
                      h('img', { src: item.url || item.dataUrl, alt: item.name }),
                      h('button', { type: 'button', title: '移除', onClick: () => removeReference(item.id) }, '×')
                    )),
                    h('button', { type: 'button', className: 'dshIsBtn', onClick: () => fileRef.current?.click() }, '+')
                  ),
              h('input', {
                ref: fileRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' },
                onChange: event => { const files = [...(event.target.files || [])]; event.target.value = ''; void absorb(files) }
              })
            ),
            // 提示词
            h('div', { className: 'dshIsSec' },
              h('div', { className: 'dshIsHead' },
                h('span', { className: 'dshIsGrow' }, '提示词'),
                assets.templates.length > 0
                  ? h('button', {
                      type: 'button',
                      className: 'dshIsBtn',
                      title: `共 ${assets.templates.length} 条模板，可搜索`,
                      onClick: () => setShowTemplates(true)
                    }, '模板库')
                  : null
              ),
              h('textarea', {
                className: 'dshIsTextarea',
                value: prompt,
                placeholder: '写下你要生成的画面，也可以先上传参考图说明修改方向。',
                onChange: event => setPrompt(event.target.value)
              }),
              h('div', { className: 'dshIsMeta' }, `${prompt.trim().length} 字`)
            ),
            // 增强模式
            h('div', { className: 'dshIsCard' },
              h('div', { className: 'dshIsCardRow' },
                h('div', { className: 'dshIsGrow' },
                  h('div', { className: 'dshIsCardTitle' }, '增强模式'),
                  h('div', { className: 'dshIsCardSub' }, enhanceEnabled ? '开启' : '关闭')
                ),
                h(Switch, { checked: enhanceEnabled, onChange: setEnhanceEnabled, label: '增强模式' })
              ),
              enhanceEnabled
                ? h(React.Fragment, null,
                    h('textarea', {
                      className: 'dshIsTextarea dshIsTextareaSmall',
                      value: enhanceText,
                      onChange: event => setEnhanceText(event.target.value)
                    }),
                    assets.enhancers.length > 0
                      ? h(PickerMenu, {
                          label: '增强预设',
                          options: assets.enhancers.map(item => ({ id: item.id, name: item.name })),
                          onSelect: id => {
                            setEnhancerId(id)
                            const found = assets.enhancers.find(item => item.id === id)
                            if (found) setEnhanceText(found.text)
                          }
                        })
                      : null
                  )
                : null
            ),
            // 开始生成（按截图放在参数之前）
            h('button', {
              type: 'button', className: 'dshIsGenerate', disabled: busy || !configured, onClick: generate
            }, busy
              ? (progress ? `生成中 ${progress.completed}/${progress.requested}…` : '生成中…')
              : imageCount > 1 ? `开始生成 ${imageCount} 张` : '开始生成'),
            error ? h('div', { className: 'dshIsError' }, error) : null,
            toast ? h('div', { className: 'dshIsToast' }, toast) : null,
            // 参数
            h('div', { className: 'dshIsSec' },
              h('div', { className: 'dshIsHead' },
                h('span', { className: 'dshIsGrow' }, '参数设置'),
                h('span', { className: 'dshIsMuted', style: { color: 'var(--is-accent)' } }, ratio)
              ),
              h('div', { className: 'dshIsGrid' },
                RATIOS.map(value => h('button', {
                  key: value, type: 'button', className: 'dshIsChip',
                  'data-active': String(value === ratio),
                  onClick: () => changeRatio(value)
                }, value))
              )
            ),
            h('div', { className: 'dshIsTwo' },
              h('div', { className: 'dshIsField' },
                h('span', null, '生成张数'),
                h('div', { className: 'dshIsCountRow' },
                  IMAGE_COUNTS.map(value => h('button', {
                    key: value, type: 'button', className: 'dshIsChip',
                    'data-active': String(value === imageCount), disabled: busy,
                    title: value === 1 ? '单张' : `并发 ${Math.min(value, settings?.maxConcurrentImages || 2)} 路出 ${value} 张`,
                    onClick: () => setImageCount(value)
                  }, value))
                )
              ),
              h('label', { className: 'dshIsField' },
                h('span', null, '品质'),
                h('select', { className: 'dshIsSelect', value: quality, onChange: event => setQuality(event.target.value) },
                  QUALITIES.map(([value, label]) => h('option', { key: value, value }, label))
                )
              )
            ),
            h('div', { className: 'dshIsTwo' },
              h('label', { className: 'dshIsField' },
                h('span', null, '分辨率'),
                h('select', {
                  className: 'dshIsSelect',
                  value: sizes.includes(size) ? size : (sizes[0] || ''),
                  onChange: event => setSize(event.target.value)
                },
                  sizes.map(value => h('option', { key: value, value }, value.replace('x', ' × ')))
                )
              ),
              h('label', { className: 'dshIsField' },
                h('span', null, '输出格式'),
                h('select', { className: 'dshIsSelect', disabled: true, value: 'png' },
                  h('option', { value: 'png' }, 'PNG')
                )
              )
            ),
            h('div', { className: 'dshIsField' },
              h('span', null, '背景'),
              h('div', { className: 'dshIsBgRow' },
                h('span', null, '透明'),
                h(Switch, { checked: transparent, onChange: setTransparent, label: '透明背景' })
              )
            ),
            // 当前调用
            h('div', { className: 'dshIsInfo' },
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '当前调用'), h('span', { className: 'dshIsInfoVal' }, configured ? '已连接' : '未配置')),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '生图模型'), h('span', { className: 'dshIsInfoVal' }, settings?.imageModel || '—')),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '比例 / 尺寸'), h('span', { className: 'dshIsInfoVal' }, `${ratio} · ${effectiveSize}`)),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '请求地址'), h('span', { className: 'dshIsInfoVal', title: settings?.baseUrl || '' }, settings?.baseUrl || '—')),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '输出目录'), h('span', { className: 'dshIsInfoVal', title: settings?.outputDir || '' }, settings?.outputDir || '未设置（只预览）')),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '并发上限'), h('span', { className: 'dshIsInfoVal' }, `${settings?.maxConcurrentImages || 3} 路 · 本批 ${imageCount} 张`)),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '界面版本'), h('span', { className: 'dshIsInfoVal' }, BUILD)),
              h('div', { className: 'dshIsInfoRow' }, h('span', { className: 'dshIsInfoKey' }, '上次耗时'), h('span', {
                className: 'dshIsInfoVal',
                title: timingTitle(lastTiming)
              }, timingText(lastTiming))),
              h('div', { className: 'dshIsInfoRow' },
                h('span', { className: 'dshIsInfoKey' }, '设置'),
                h('div', { className: 'dshIsRowBtns' },
                  h('button', { type: 'button', className: 'dshIsBtn', onClick: () => setShowSettings(true) }, '打开设置'),
                  h('button', {
                    type: 'button',
                    className: 'dshIsBtn',
                    disabled: !settings?.outputDir,
                    onClick: async () => {
                      try {
                        const result = await call('.openDir', {})
                        notify(`已打开：${result.path}`)
                      } catch (cause) {
                        setError(String(cause.message || cause))
                      }
                    }
                  }, '打开文件夹')
                )
              )
            )
          ),
          // 画布
          h('section', { className: 'dshIsStage' },
            h('div', { className: 'dshIsCanvasWrap' },
              h('div', {
                className: 'dshIsCanvas',
                ref: canvasRef,
                onDoubleClick: () => { if (current) resetZoom() }
              },
                // 生成中默认显示生成场景；用户主动点旧图才切过去（角标可切回）。
                showImage
                  ? h('img', {
                      src: srcOf(current),
                      alt: 'preview',
                      style: imageStyle,
                      draggable: false,
                      onLoad: event => {
                        const img = event.currentTarget
                        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                          setNatural({ w: img.naturalWidth, h: img.naturalHeight })
                        }
                      }
                    })
                  : busy
                    ? h('div', { className: 'dshIsGenScene' },
                        h('div', { className: 'dshIsGenInner' },
                          h('svg', {
                            className: 'dshIsGenCloud', width: 34, height: 34, viewBox: '0 0 24 24', fill: 'none'
                          },
                            h('path', {
                              d: 'M6.8 18.2h10.1a3.6 3.6 0 0 0 .3-7.2 5.4 5.4 0 0 0-10.3-1.2 3.9 3.9 0 0 0-.1 8.4Z',
                              stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round'
                            })
                          ),
                          h('div', { className: 'dshIsGenPercent' }, `${progressPercent(progress, elapsed)}%`),
                          h('div', { className: 'dshIsGenTrack' }, h('div', { className: 'dshIsGenFill', style: { width: `${progressPercent(progress, elapsed)}%` } })),
                          h('div', { className: 'dshIsGenLabel' }, '生成中…'),
                          h('div', { className: 'dshIsGenSub' }, progressSub(progress, ratio, effectiveSize, elapsed)),
                          h('button', { type: 'button', className: 'dshIsGenCancel', onClick: cancelGenerate }, '取消')
                        )
                      )
                    : h('div', { className: 'dshIsEmpty' },
                        h('div', { className: 'dshIsEyebrow' }, 'OUTPUT PREVIEW'),
                        h('div', { className: 'dshIsEmptyTitle' }, '生成结果会在这里实时更新。'),
                        h('div', { className: 'dshIsEmptySub' }, '生成日志可在设置中查看，底部胶片条可快速切换查看。'),
                        !configured
                          ? h('button', { type: 'button', className: 'dshIsBtn', onClick: () => setShowSettings(true) }, '先配置生图通道')
                          : null
                      )
              ),
              // 生成中画布还留着旧图：右下角浮进度徽标（百分比 + 秒数 + 取消）。
              busy && current
                ? h('div', { className: 'dshIsBusyBadge' },
                    h('span', { className: 'dshIsSpinner' }),
                    h('span', null, progress
                      ? `${progress.completed}/${progress.requested} 张 · ${progressPercent(progress, elapsed)}%`
                      : `${progressPercent(progress, elapsed)}% · ${elapsed}s`),
                    h('button', { type: 'button', className: 'dshIsBadgeCancel', onClick: () => setViewDuringBusy(false) }, '回到生成'),
                    h('button', { type: 'button', className: 'dshIsBadgeCancel', onClick: cancelGenerate }, '取消')
                  )
                : null
            ),
            h('div', { className: 'dshIsBar' },
              h('span', { className: 'dshIsPill' }, settings?.imageModel || 'GPT Image'),
              h('span', { className: 'dshIsMuted' }, busy
                ? (progress ? `生成中 ${progress.completed}/${progress.requested} · ${elapsed}s` : `生成中… ${elapsed}s`)
                : '等待生成'),
              h('span', { className: 'dshIsMuted', title: '队列：运行中 / 排队中' }, busy ? '队列: ●' : 'ID: --'),
              h('span', { className: 'dshIsZoom' },
                h('button', {
                  type: 'button', className: 'dshIsBarAction', disabled: !current, title: '缩小',
                  onClick: () => zoomTo(zoom / 1.25)
                }, '−'),
                h('button', {
                  type: 'button', className: 'dshIsBarAction dshIsZoomValue', disabled: !current,
                  title: `当前缩放 ${zoomPercent}%（画布滚轮缩放，双击复位到 100%）`,
                  onClick: resetZoom
                }, `${zoomPercent}%`),
                h('button', {
                  type: 'button', className: 'dshIsBarAction', disabled: !current, title: '放大',
                  onClick: () => zoomTo(zoom * 1.25)
                }, '+'),
                h('button', {
                  type: 'button', className: 'dshIsBarAction', disabled: !current, title: '按容器尺寸自适应',
                  onClick: fitToView
                }, '适配')
              ),
              h('span', { className: 'dshIsBarPrompt' }, composed),
              h('button', { type: 'button', className: 'dshIsBarAction', disabled: !current, onClick: addCurrentAsReference }, '添加到参考图'),
              h('button', { type: 'button', className: 'dshIsBarAction', disabled: !current, onClick: () => {
                if (!current) return
                const link = document.createElement('a')
                link.href = srcOf(current)
                link.download = current.name || `image-studio-${Date.now()}.png`
                link.click()
              } }, '下载'),
              h('button', { type: 'button', className: 'dshIsBarAction', disabled: !current, onClick: () => current && setLightbox(srcOf(current)) }, '查看'),
              h('button', { type: 'button', className: 'dshIsBarAction', disabled: !current, onClick: deleteCurrent }, '删除')
            )
          )
        ),
        // 胶片条（缩略图下显示尺寸；生成中也能点开旧图）
        h('div', { className: 'dshIsFilm' },
          busy && images.length === 0
            ? h('div', { className: 'dshIsFilmBusy' }, progress ? `${progress.completed}/${progress.requested}` : `${progressPercent(progress, elapsed)}%`)
            : null,
          images.length === 0 && !busy
            ? h('span', { className: 'dshIsFilmEmpty' }, '还没有图片')
            : images.map((image, index) => h('div', {
                key: `${index}-${image.url || image.name || image.kind}`,
                className: 'dshIsFilmItem',
                'data-active': String(index === activeImage),
                title: image.name || '',
                onClick: () => { setActiveImage(index); if (busy) setViewDuringBusy(true) }
              },
                h('div', { className: 'dshIsFilmThumb' }, h('img', { src: srcOf(image), alt: '' })),
                h('div', { className: 'dshIsFilmSize' }, sizeLabel(image))
              ))
        ),
        // 设置
        showSettings
          ? h('div', { className: 'dshIsOverlay', onClick: event => { if (event.target === event.currentTarget) setShowSettings(false) } },
            h('div', { className: 'dshIsDialog' },
              h('div', { className: 'dshIsDialogHead' }, h('span', { className: 'dshIsGrow' }, '通道设置')),
              h('label', { className: 'dshIsField' },
                h('span', null, 'Base URL'),
                h('input', {
                  value: draft.baseUrl,
                  placeholder: 'https://api.example.com/v1',
                  onChange: event => setDraft({ ...draft, baseUrl: event.target.value })
                })
              ),
              h('label', { className: 'dshIsField' },
                h('span', null, `API Key${settings?.keyPresent ? `（已保存 ${settings.keyHint}）` : ''}`),
                h('input', {
                  type: 'password',
                  value: draft.apiKey,
                  placeholder: settings?.keyPresent ? '••••••••' : 'sk-…',
                  onChange: event => setDraft({ ...draft, apiKey: event.target.value })
                })
              ),
              h('div', { className: 'dshIsField' },
                h('span', null, '模型'),
                h('div', { className: 'dshIsRowBtns' },
                  h('select', {
                    className: 'dshIsSelect',
                    value: draft.imageModel || '',
                    onChange: event => setDraft({ ...draft, imageModel: event.target.value })
                  },
                    h('option', { value: '' }, '— 选择模型 —'),
                    modelOptions.map(id => h('option', { key: id, value: id }, id))
                  ),
                  h('button', { type: 'button', className: 'dshIsBtn', disabled: modelsBusy, onClick: () => void refreshModels() },
                    modelsBusy ? '拉取中…' : '拉取模型')
                )
              ),
              h('div', { className: 'dshIsTwo' },
                h('label', { className: 'dshIsField' },
                  h('span', null, '并发上限'),
                  h('select', {
                    className: 'dshIsSelect',
                    value: String(draft.maxConcurrentImages || 3),
                    onChange: event => setDraft({ ...draft, maxConcurrentImages: Number(event.target.value) })
                  },
                    [1, 2, 3, 4, 5, 6, 7, 8].map(value => h('option', { key: value, value: String(value) }, `${value} 路`))
                  )
                ),
                h('label', { className: 'dshIsField' },
                  h('span', null, '默认张数'),
                  h('select', {
                    className: 'dshIsSelect',
                    value: String(draft.defaultImageCount || 1),
                    onChange: event => setDraft({ ...draft, defaultImageCount: Number(event.target.value) })
                  },
                    IMAGE_COUNTS.map(value => h('option', { key: value, value: String(value) }, `${value} 张`))
                  )
                )
              ),
              h('div', { className: 'dshIsHint' }, '并发上限是所有窗口/Agent 工具共享的上游请求数；默认张数是每次点「开始生成」的张数。'),
              h('div', { className: 'dshIsField' },
                h('span', null, '输出图片位置'),
                h('div', { className: 'dshIsRowBtns' },
                  h('input', {
                    value: draft.outputDir,
                    placeholder: '可粘贴路径，如 D:\\images\\studio；留空则不落盘',
                    onChange: event => setDraft({ ...draft, outputDir: event.target.value })
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dshIsBtn',
                    onClick: async () => {
                      if (!pickerAvailable) { notify('当前环境不支持选择文件夹，请直接粘贴路径'); return }
                      const picked = await pickDirectory()
                      if (picked) setDraft(current => ({ ...current, outputDir: picked }))
                    }
                  }, '选择文件夹'),
                  h('button', {
                    type: 'button',
                    className: 'dshIsBtn',
                    disabled: !draft.outputDir,
                    onClick: async () => {
                      try {
                        await navigator.clipboard.writeText(draft.outputDir)
                        notify('路径已复制')
                      } catch {
                        notify('复制失败，请手动选中复制')
                      }
                    }
                  }, '复制'),
                  h('button', {
                    type: 'button',
                    className: 'dshIsBtn',
                    disabled: !draft.outputDir,
                    onClick: async () => {
                      try {
                        const result = await call('.openDir', {})
                        notify(`已打开：${result.path}`)
                      } catch (cause) {
                        setError(String(cause.message || cause))
                      }
                    }
                  }, '打开文件夹')
                )
              ),
              h('div', { className: 'dshIsHint' }, '每次生成会把 PNG 存到这个目录（文件名带时间戳，不会覆盖）；留空则只在界面里预览。'),
              h('div', { className: 'dshIsHint' }, '只走 Images API（/v1/images/generations）。Key 存在 host 侧凭据存储，不下发浏览器。'),
              h('div', { className: 'dshIsRowBtns' },
                h('button', { type: 'button', className: 'dshIsGenerate', style: { flex: 1 }, disabled: saving, onClick: saveSettings }, saving ? '保存中…' : '保存'),
                h('button', { type: 'button', className: 'dshIsBtn', onClick: () => setShowSettings(false) }, '取消')
              )
            )
          )
          : null,
        showTemplates
          ? h(TemplatePicker, {
              templates: assets.templates,
              onSelect: applyTemplate,
              onClose: () => setShowTemplates(false)
            })
          : null,
        lightbox
          ? h(ImageLightbox, { src: lightbox, alt: 'preview', onClose: () => setLightbox(null), labels: { dialog: '查看图片', close: '关闭' } })
          : null
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        // 目录选择器是可选能力：用嵌套 inject，拿不到也不影响插件其余部分。
        try {
          ctx.inject?.(['uiWorkspace'], scoped => {
            const workspace = scoped?.uiWorkspace
            if (workspace?.pickDirectory) {
              pickerAvailable = true
              pickDirectory = () => workspace.pickDirectory()
            }
          })
        } catch {
          /* 保留手动粘贴路径 */
        }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-image-studio'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'image-studio styles')

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL }, () => h(StudioPage))
        )

        // 只提供图标：宿主自己渲染行、文字与选中态。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL, order: 20, label: () => '生图工作台'
          }, function EntryIcon(props) {
            const size = Number(props?.size) > 0 ? Number(props.size) : 16
            return h('svg', { className: 'dshIsEntryIcon', width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
              h('rect', { x: 1.6, y: 2.6, width: 12.8, height: 8.8, rx: 1.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.1 }),
              h('circle', { cx: 5.2, cy: 5.6, r: 1, fill: 'currentColor' }),
              h('path', { d: 'M2.6 10.1 L6.1 7.1 L8.9 9.4 L11.1 7.5 L13.4 9.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' })
            )
          })
        )
      }
    }
  }
})
