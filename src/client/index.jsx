/**
 * dsh-lyin-sessions-manager — browser half: renders a single "会话管理" settings
 * section (settings.section list slot) that unifies archived-session
 * management and cross-workspace moving. It talks to the host half's
 * /archived-sessions/* JSON routes by fetch, showing every conversation with
 * its archive state and offering archive / restore / delete / move (and batch)
 * actions. All DOM/runtime wiring failures are logged, never thrown — a thrown
 * plugin apply takes down the whole web-shell boot.
 *
 * @module dsh-lyin-sessions-manager/client
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { aliveSessionCount, applyTagFilter, ascPriority, canDropOnWorkspace, collapsedVisibleTotal, countRenderedVisible, dotStateFor, dragAutoScrollStep, effectiveTitleOf, filterShapeFromSaved, filterSnapshotOf, foldActivityItems, foldBranches, foldOrphanSubagents, foldSubagentRows, foldSubagents, groupQuickAccess, isWorkspaceSentinel, markedRowsByKind, matchWorkspaceFilter, shouldHideEmptyGroup, WS_GONE, WS_UNGROUPED, mergeActivityItems, normalizeCollapsed, noticeToastPlan, QA_MARKED_KIND_HINT, QA_MARKED_KIND_LABEL, QA_MARKED_KINDS, QA_RECENT_WINDOW_MS, recentActiveRows, stateFromSessionStatus, summaryCounts, openSubagentToast, overflowPlan, pathTail, priorityOf, remainingRows, reviewOf, sessionForNodes, shortId, starredOf, tagDeleteConfirm, titleBackfillDecision, toastDurationFor, workspaceForNodes } from './logic.js'

import { markUnreadLabel, menuChannelOf, moveCapabilityOf, moveTargets } from './logic.js'
import { visibleItemsAfterWorkspaceFold, workspaceKeyOf } from '../workspace-archive-core.js'
import { JOB_BADGE_MAX_ROWS, jobBadgeText, jobDurationLabel } from '../background-jobs.js'
import { CAPSULE_COLOR_KEY, CAPSULE_DISPLAY_KEY, CAPSULE_EVENTS, CAPSULE_NOTICE_KEY, FOLLOW_PRESET, QA_STYLE_VAR_KEYS, capsuleFollowInfo, qaVarsFromCapsule } from './capsule-link.js'

export const inject = ['slots']

// v3.17.0：面板内设置菜单的分组。顺序 = 用户从「最常改」到「最少动」的直觉顺序；
// 「宿主集成」放最后，因为那三项都改本机配置文件、且 MCP 改完还要重启。
// v3.18.0：顶部统一导航只保留 5 格。已收藏 / 待回看 / 空白 移进「设置 → 会话筛选」，
// 与用户「其他的请移动到【设置】下」的要求一致；回收站是高频操作，留在顶层。
const DSM_SETTINGS_GROUPS = [
  { id: 'appearance', label: '外观' },
  { id: 'filters', label: '会话筛选' },
  { id: 'archive', label: '归档' },
  { id: 'storage', label: '存储与标签' },
  { id: 'host', label: '宿主集成' },
]


// v3.17.0：设置导航的滑块指示器。绝对定位 + transform 横向移动，切换时是滑动
// 而不是整块闪一下；位置取自被选中 tab 的 offsetLeft/offsetWidth（导航会换行，
// 所以纵向 top 也一并跟随，避免第二行时滑块停在第一行）。
// v3.18.0：顶部导航（全部/活动/已归档/设置/回收站）与设置内导航共用同一个滑块。
// 两处的差别只有容器选择器与 data 属性名，所以做成参数。
function DsmNavGlider({ active, rootSel = '.dsm-nav', attr = 'data-dsm-nav', cls = 'dsm-navglider' }) {
  const [box, setBox] = useState(null)
  useEffect(() => {
    const pick = () => {
      const root = document.querySelector(rootSel)
      const node = root && root.querySelector('[' + attr + '="' + active + '"]')
      if (!node) { setBox(null); return }
      setBox({ left: node.offsetLeft, width: node.offsetWidth, top: node.offsetTop })
    }
    pick()
    let ro = null
    try {
      // 字体加载完成 / 语言切换都会改变宽度，靠 ResizeObserver 兜住。
      if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(pick); ro.observe(document.body) }
    } catch (e) { /* 无 ResizeObserver：只靠 resize 事件 */ }
    window.addEventListener('resize', pick)
    return () => {
      window.removeEventListener('resize', pick)
      if (ro) { try { ro.disconnect() } catch (e) { /* 已断开 */ } }
    }
  }, [active, rootSel, attr])
  if (!box) return null
  return (
    <span
      className={cls}
      aria-hidden="true"
      style={{ transform: 'translateX(' + box.left + 'px)', width: box.width + 'px', top: box.top + 'px' }}
    />
  )
}

const PANEL_PREFS_KEY = 'dsm-panel-prefs-v1'
function loadPanelPrefs() {
  try { return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || '{}') || {} } catch (e) { return {} }
}

const CSS = `
/* 兼容 shim（2026-09-30 对 0.2.0-rc.2 实测）：当前 runtime 的设计令牌不再提供
   fill-elevated / fill-subtle / fill-secondary / label-inverted / state-warning-primary
   这几个 alias，缺位会让输入框、下拉框、卡片、徽标整体回退成透明。这里把它们重映射
   到 runtime 现有 token（官方 Input/Pill 分别用 bg-layer-1 / bg-layer-2）。选择器用
   :where(:root)（零特异性）：runtime 将来恢复官方定义时自动胜出，shim 只在缺位时兜底。
   state-warning-primary 是旧名，现名为 state-warn-primary。 */
:where(:root){--dsw-alias-fill-elevated:var(--dsw-alias-bg-layer-2);--dsw-alias-fill-subtle:var(--dsw-alias-bg-layer-1);--dsw-alias-fill-secondary:var(--dsw-alias-bg-layer-2);--dsw-alias-label-inverted:var(--dsw-alias-label-primary-foreground);--dsw-alias-state-warning-primary:var(--dsw-alias-state-warn-primary)}
/* 原生 <select> 的弹出列表由 Chromium 按 color-scheme 绘制，不声明时暗色主题下
   仍是白底，叠加未适配的文字色导致不可读；跟随 DSH 的暗色主题标记切换。 */
.archv{color-scheme:light}
body[data-ds-dark-theme] .archv{color-scheme:dark}
/* 兜底：原生弹层行的配色直接写在 option 上（Chromium 按 option 自身的
   background/color 绘制弹层），即使 color-scheme 判定被扩展或环境干扰，
   暗色下也不会出现白底配浅色文字的不可读组合。 */
.archv option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.archv{--dsm-radius-tag:9px;--dsm-radius-ctl:9px;--dsm-radius-sheet:10px;--dsm-radius-card:12px;display:flex;flex-direction:column;gap:4px;max-width:800px;padding:8px 2px 28px}
.archv-head{display:flex;align-items:center;gap:10px;margin:0 0 2px}
.archv-title{font-size:16px;font-weight:650;color:var(--dsw-alias-label-primary);letter-spacing:-0.01em;margin:0}
.archv-stamp{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 8px;white-space:nowrap;cursor:pointer;transition:color .15s ease,border-color .15s ease}
.archv-stamp:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.archv-count{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-subtle);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;flex:none}
.archv-err{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:var(--dsm-radius-sheet);color:var(--dsw-alias-state-error-primary);font-size:12px;margin-bottom:10px}
.archv-errretry{appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:transparent;color:inherit;border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer;flex:none}
/* 低频分类（已收藏/空白/回收站）横向收纳：默认 max-width:0 隐藏，点按箭头
   （sess-fmore-open）或低频分类处于选中态（sess-fsec-on）时向右展开；
   max-width 过渡做横向滑出动画，overflow 裁剪回缩过程。 */
/* 箭头默认紧跟三个主 tab 右边（悬停筛选行才浮现）；展开组撑开后把它推到
   行尾。无外圈底色，只渲染 svg 本体。隐藏态用 pointer-events:none 挡住
   误点；展开态（含选中低频分类的兜底）常驻——收起入口不能消失。 */
.sess-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:0 0 8px}
.sess-tools-4{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}
/* T4 起搜索行有 5 个字段（搜索/工作区/标签/排序/分组）：固定 5 列 + minmax(0,1fr)
   一行排满——auto-fit(minmax(124px,…)) 在面板宽度不足 5×124+gap 时会把最后
   一列挤到第二行（分组孤行）。minmax(0,1fr) 允许列均分收缩，select/input
   各自截断；<640px 仍由下方断点收成单列。 */
.sess-tools-5{grid-template-columns:repeat(5,minmax(0,1fr))}
.dsm-kids{display:flex;flex-direction:column;gap:6px;margin:10px 0 2px;margin-left:43px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l3)}
.dsm-kid .dsm-kids{margin-left:8px;margin-top:6px}
.dsm-kids-toggle{appearance:none;min-height:22px;padding:0 9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);border-radius:var(--dsm-radius-tag);font:inherit;font-size:11px;font-weight:500;cursor:pointer;flex:none;white-space:nowrap}
.dsm-kids-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.dsm-src-head{display:flex;align-items:center;gap:8px;padding:5px 9px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-ctl);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-src-head .dsm-src-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-kid{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsm-kid-row{display:flex;align-items:center;gap:8px;min-width:0}
.dsm-kid-name{flex:1 1 auto;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-kid-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none;white-space:nowrap}
.dsm-kid-acts{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
.dsm-kid-acts .archv-btn{min-height:26px;padding:0 9px;font-size:11px}
.sess-results{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0 0 4px}
/* T4 后计数行右侧挂了「保存筛选」控件组，正文独占左侧可收缩。 */
.sess-results-main{flex:1 1 auto;min-width:0}
.archv button:focus-visible,.archv input:focus-visible,.archv select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.sess-batch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 2px 4px;margin-bottom:4px}
/* issue #7：勾选后批量操作栏吸顶——列表再长，操作按钮也一直在手边。 */
.sess-batch-pin{position:sticky;top:0;z-index:30;margin:0 -2px 4px;padding:8px 4px 6px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 14px rgb(0 0 0/.08)}
.sess-btntext{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none}
.archv-list{display:flex;flex-direction:column;gap:8px}
.archv-card{display:flex;flex-direction:column;align-items:stretch;gap:0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-card);background:var(--dsw-alias-fill-elevated);transition:border-color .15s ease,background-color .15s ease}
.archv-card:hover{border-color:var(--dsw-alias-border-l4)}
.archv-card-exp{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1)}
.archv-row{display:flex;align-items:center;gap:14px;width:100%;min-width:0}
.archv-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.archv-titlerow{display:flex;align-items:center;gap:8px;min-width:0}
.archv-name{font-size:13px;font-weight:550;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
.archv-meta{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;min-width:0;overflow:hidden}
.archv-wtag{display:inline-flex;align-items:center;gap:4px;min-width:0;flex:0 1 auto;font-size:11px;font-weight:500;line-height:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-subtle);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-tag);padding:3px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.archv-wgone{border-style:dashed;color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.archv-active{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.archv-date{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none}
.dsm-branch-chip{display:inline-flex;align-items:center;flex:none;min-height:22px;padding:0 9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);border-radius:var(--dsm-radius-tag);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
.dsm-empty-chip{display:inline-flex;align-items:center;flex:none;min-height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-tag);background:var(--dsw-alias-fill-subtle);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
/* 3.7.0 T4 标签 chip 系：卡片标题行内、分支/空白 chip 之后。警示色系区别于
   分支（绿）/空白（灰），名字超长省略号；+N 计数 chip 中性色。 */
.dsm-tagchip{display:inline-flex;align-items:center;flex:none;max-width:9em;min-height:22px;padding:0 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#EAB308) 45%,transparent);border-radius:var(--dsm-radius-tag);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#EAB308) 10%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-tagchip-more{max-width:none;color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-subtle)}
.archv-id{appearance:none;border:none;background:none;padding:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex:none;margin-left:auto;white-space:nowrap;cursor:pointer;transition:color .12s ease}
.archv-id:hover{color:var(--dsw-alias-label-secondary)}
.archv-id-copied{color:var(--dsw-alias-state-business-primary)}
.archv-dot{color:var(--dsw-alias-border-l3);flex:none}
.archv-check{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary);flex:none;cursor:pointer}
.archv-star{appearance:none;width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;padding:0;line-height:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:50%;transition:color .15s ease,transform .12s ease}
.archv-star:hover{background:0 0;color:var(--dsw-alias-label-secondary);transform:scale(1.12)}
.archv-star:active{transform:scale(.92)}
.archv-star svg{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;display:block}
.archv-star-on,.archv-star-on:hover{color:var(--dsw-alias-state-business-primary)}
.archv-star-on svg{fill:currentColor}
.archv-review{appearance:none;width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;padding:0;line-height:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:50%;transition:color .15s ease,transform .12s ease}
.archv-review:hover{background:0 0;color:var(--dsw-alias-label-secondary);transform:scale(1.12)}
.archv-review:active{transform:scale(.92)}
.archv-review svg{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;display:block}
.archv-review-on,.archv-review-on:hover{color:var(--dsw-alias-state-business-primary)}
.archv-review-on svg{fill:currentColor}
.archv-prio{appearance:none;flex:none;height:22px;border:1px solid var(--dsw-alias-stroke-border-default,transparent);background:0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;padding:0 2px;border-radius:6px;cursor:pointer}
.archv-prio:hover{color:var(--dsw-alias-label-primary)}
.archv-prio-set{color:var(--dsw-alias-state-business-primary);font-weight:600}
.archv-note{width:100%;box-sizing:border-box;resize:vertical;font:inherit;font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-stroke-border-default,rgba(127,127,127,.35));background:0 0;color:inherit}
.archv-note:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsm-qa-root{position:relative;display:contents}
.dsm-qa-btn{width:100%;text-align:left}
.dsm-qa-btn-on{color:var(--dsw-alias-state-business-primary)}
.dsm-qa-backdrop{position:fixed;inset:0;z-index:9990;background:transparent}
/* v0.2.1 面板样式升级（参考 dsh-netease-lyrics 的浮层风格）：深色半透明卡 +
   backdrop 模糊 + 细描边 + 大圆角，与官方 UI 的 surface token 对齐。
   v0.2.2：可调参数全部抽为 CSS 变量（--dsmqa-*），由 applyQaStyle() 按
   localStorage 里用户偏好/主题预设注入 :root；缺省值 = 原硬编码值。 */
.dsm-qa-panel{position:fixed;left:12px;bottom:56px;z-index:9991;width:min(360px,calc(100vw - 24px));max-height:min(60vh,480px);overflow:auto;padding:12px;border-radius:var(--dsmqa-radius,14px);border:1px solid var(--dsmqa-border,rgba(127,127,127,.22));background:var(--dsmqa-bg,rgba(24,24,26,.86));backdrop-filter:blur(var(--dsmqa-blur,14px));-webkit-backdrop-filter:blur(var(--dsmqa-blur,14px));color:var(--dsmqa-fg,#F1EFE8);box-shadow:0 12px 32px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3)}
.dsm-qa-panel .dtl-note{color:var(--dsmqa-note,rgba(241,239,232,.55))}
.dsm-qa-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(127,127,127,.16)}
.dsm-qa-title{font-size:13px;font-weight:600;letter-spacing:.2px}
.dsm-qa-panel .mv-sheet-close{color:rgba(241,239,232,.6)}
.dsm-qa-group{margin-top:10px;min-width:0}
.dsm-qa-group-t{font-size:11px;opacity:.65;margin-bottom:6px;display:flex;align-items:center;gap:6px;text-transform:uppercase;letter-spacing:.4px}
.dsm-qa-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.dsm-qa-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0;box-sizing:border-box;text-align:left;padding:7px 10px;border:none;background:0 0;color:inherit;font-size:12.5px;border-radius:9px;cursor:pointer;transition:background .12s ease}
.dsm-qa-row:hover{background:rgba(255,255,255,.08)}
.dsm-qa-row:active{background:rgba(255,255,255,.12)}
.dsm-qa-row:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#5B8DEF);outline-offset:-1px}
.dsm-qa-row-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-qa-kids{flex:none;font-size:10.5px;line-height:1;padding:3px 6px;border-radius:999px;border:1px solid rgba(127,127,127,.3);opacity:.75;white-space:nowrap}
.dsm-qa-err{color:#F87171}
/* v0.5.0 顶部摘要条：一行四组计数，列表很短时面板也不显空。 */
.dsm-qa-sum{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;margin:-4px 0 12px;padding-bottom:9px;border-bottom:1px solid rgba(127,127,127,.16);font-size:11.5px}
.dsm-qa-sum-i{display:inline-flex;align-items:center;gap:6px;opacity:.45;white-space:nowrap}
.dsm-qa-sum-i .dsm-qa-dot{width:6px;height:6px;opacity:.85}
.dsm-qa-sum-on{opacity:.92}
.dsm-qa-sum-all{margin-left:auto;opacity:.4}
/* v0.5.0 次级区（最近活跃 / 已标记）。与上方关注区同构，但用细分隔线区分层次。 */
.dsm-qa-sec{margin-top:14px;padding-top:11px;border-top:1px solid rgba(127,127,127,.13)}
.dsm-qa-sec-h{text-transform:none;letter-spacing:0;gap:8px}
.dsm-qa-sec-label{font-weight:600;opacity:.85;letter-spacing:.2px}
.dsm-qa-sec-hint{opacity:.45;font-weight:400;font-size:10.5px}
.dsm-qa-badge{flex:none;font-size:10px;line-height:1;padding:3px 5px;border-radius:5px;border:1px solid rgba(127,127,127,.32);opacity:.8;white-space:nowrap}
.dsm-qa-ws{flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.45}
.dsm-qa-ago{margin-left:auto;flex:none;font-size:11px;opacity:.5;white-space:nowrap}
/* v3.14.1 面板里的后台任务：行首小三角 + 就地展开的「任务名 + 已经跑了多久」。 */
.dsm-qa-jobs-t{flex:none;appearance:none;display:inline-flex;align-items:center;padding:0 4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-state-warn-primary,#EAB308);font:inherit;font-size:10px;font-weight:700;line-height:15px;letter-spacing:.5px;cursor:pointer;white-space:nowrap}
.dsm-qa-jobs-t:hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#EAB308) 16%,transparent)}
.dsm-qa-jobs-t:focus-visible{outline:1px solid var(--dsw-alias-state-warn-primary,#EAB308);outline-offset:1px}
.dsm-qa-jobs{margin:1px 0 3px 14px;padding:2px 0 2px 9px;border-left:1px solid rgba(127,127,127,.25);display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%;overflow:hidden}
.dsm-qa-job{display:flex;align-items:center;gap:8px;padding:2px 4px;font-size:11.5px;opacity:.72;min-width:0}
.dsm-qa-job-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-qa-job-age{margin-left:auto;flex:none;font-size:10.5px;opacity:.75;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-qa-job-more{opacity:.45;font-size:10.5px}
.dsm-qa-rail .dsm-qa-jobs{margin-left:11px}
.dsm-qa-rail .dsm-qa-job{font-size:11px}
.dsm-qa-rail .dsm-qa-sum{gap:3px 10px;margin-bottom:9px;padding-bottom:7px;font-size:10.5px}
.dsm-qa-rail .dsm-qa-sum-all{margin-left:0}
.dsm-qa-rail .dsm-qa-sec{margin-top:10px;padding-top:8px}
.dsm-qa-rail .dsm-qa-sec-hint{font-size:10px}
.dsm-qa-rail .dsm-qa-ws{max-width:80px}
.dsm-qa-rail .dsm-qa-ago{font-size:10.5px}
/* v0.2.1 内联状态点：显示在会话名称左侧（paint 循环注入）。 */
.dsm-inline-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;margin-right:7px;vertical-align:middle;box-shadow:0 0 4px rgba(0,0,0,.25)}
.dsm-inline-dot-wrap{display:inline-flex;align-items:center;min-width:0}
/* v0.2.1 全局面板（panellist + main）形态。 */
/* v0.5.3 滚动：分区变多后面板可能比容器还高，两个形态各自成为滚动容器。
   max-height:100% 只在宿主给定了容器高度时生效——宿主若本来就是整页滚动，
   这条不产生任何变化（不会出现「滚动条里还有滚动条」的并排双条）。 */
.dsm-qa-main{padding:18px 22px;box-sizing:border-box;min-width:0;max-width:var(--dsmqa-width,760px);margin:0 auto;font-size:13px;color:var(--dsmqa-fg,#F1EFE8);max-height:100%;overflow-y:auto}
.dsm-qa-main-head{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
.dsm-qa-main-title{font-size:16px;font-weight:700;letter-spacing:.3px}
.dsm-qa-main-count{font-size:12px;opacity:.6}
.dsm-qa-search{width:100%;box-sizing:border-box;padding:8px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.28);background:rgba(255,255,255,.05);color:inherit;font-size:12.5px;margin-bottom:12px}
.dsm-qa-search:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#5B8DEF)}
.dsm-qa-main .dsm-qa-row{padding:9px 12px;font-size:13px}
/* v0.3.0 右侧栏形态：窄布局（右栏 ~320px），去大内边距、行更紧凑。
   v0.5.3：同样自成滚动容器（右栏高度有限，分区多了必须能滚）。 */
.dsm-qa-rail{padding:10px 12px;box-sizing:border-box;min-width:0;max-width:100%;margin:0;font-size:12.5px;color:var(--dsmqa-fg,#F1EFE8);max-height:100%;overflow-y:auto}
.dsm-qa-rail .dsm-qa-main-head{margin-bottom:8px;gap:8px}
.dsm-qa-rail .dsm-qa-main-title{font-size:13px;font-weight:600}
.dsm-qa-rail .dsm-qa-main-count{font-size:11px;opacity:.6}
.dsm-qa-rail .dsm-qa-search{padding:6px 10px;font-size:12px;margin-bottom:8px}
.dsm-qa-rail .dsm-qa-row{padding:6px 8px;font-size:12.5px;gap:8px}
.dsm-qa-rail .dsm-qa-group{margin-top:8px}
.dsm-qa-rail .dsm-qa-group-t{font-size:10.5px;opacity:.6;margin-bottom:4px}
/* v0.5.4 吸顶标题条：标题 + 摘要条固定在滚动容器顶部。负外边距让吸顶条铺满面板
   内边距——否则内容会从两侧和上方的空隙里露出来。底色优先用 dsmFitPanel 实测到的
   宿主页面底色（--dsmqa-head-bg），测不到时退回当前外观预设的不透明色。 */
.dsm-qa-sticky{position:sticky;top:0;z-index:3;background:var(--dsmqa-head-bg,var(--dsmqa-solid,#18181A));margin:-18px -22px 0;padding:18px 22px 12px}
.dsm-qa-rail .dsm-qa-sticky{margin:-10px -12px 0;padding:10px 12px 10px}
/* v3.13.2 搜索框搬进吸顶条后自己不再留底边距，改用吸顶条的 padding-bottom 收口，
   否则那 12px 落在吸顶条外面，滚动时内容会从缝里露出来。 */
.dsm-qa-sticky .dsm-qa-search{margin-bottom:0}
/* v3.13.0 胶囊联动：只有「跟随歌词胶囊」时面板本体才自己上材质——普通预设仍按
   v0.2.2 起的既有行为由宿主供背景，不吃 --dsmqa-bg，避免老用户升级后视觉突变。
   wash（罩染）与 grain（颗粒）都走 background-image 的两层：这两层随元素固定、
   不跟着滚动内容跑（用绝对定位的伪元素做会随内容滚走，露出没材质的下半截）。
   grain 的浓度是数字，直接当 alpha 用（rgb(255 255 255 / var(--dsmqa-grain))）。
   不跟随时 applyQaStyle 把 wash 写 none、grain 写 0，视觉与 v3.12.0 完全一致。 */
:root[data-dsmqa-follow="1"] .dsm-qa-main,
:root[data-dsmqa-follow="1"] .dsm-qa-rail{position:relative;box-sizing:border-box;margin-top:calc(-1 * var(--dsmqa-gap-top,0px));padding-top:0;min-height:var(--dsmqa-avail,auto);border-radius:var(--dsmqa-radius,14px);border:1px solid var(--dsmqa-border,transparent);background-color:var(--dsmqa-bg,transparent);background-image:repeating-radial-gradient(circle at 0 0,rgb(255 255 255 / calc(var(--dsmqa-grain,0) * .34)) 0 .5px,transparent .5px 2.5px),var(--dsmqa-wash,none);backdrop-filter:blur(var(--dsmqa-blur,0px)) saturate(var(--dsmqa-sat,1));-webkit-backdrop-filter:blur(var(--dsmqa-blur,0px)) saturate(var(--dsmqa-sat,1));box-shadow:0 10px 30px var(--dsmqa-glow,transparent)}
/* v3.13.1 吸顶条不再用不透明 --dsmqa-solid：那会在半透明材质顶上盖一条实色深条，
   与下方明显分层（用户实测反馈）。改成「同一色的淡版 + 同参数背景模糊」：色相与
   面板一致，alpha 压到 62% 只够让滚过去的内容变浑浊，不会形成色块。
   不用全透明是因为 backdrop-filter 嵌套时未必生效，万一失效会变成文字叠字。
   --dsmqa-solid 仍留给普通预设（不跟随时那条规则不变）。 */
:root[data-dsmqa-follow="1"] .dsm-qa-sticky{margin-top:0;border-radius:var(--dsmqa-radius,14px) var(--dsmqa-radius,14px) 0 0;background:color-mix(in srgb,var(--dsmqa-bg,transparent) 62%,transparent);backdrop-filter:blur(var(--dsmqa-blur,0px)) saturate(var(--dsmqa-sat,1));-webkit-backdrop-filter:blur(var(--dsmqa-blur,0px)) saturate(var(--dsmqa-sat,1))}
/* v0.5.4 分组可收起（替代「按上限截断」）：表头即开关，收起后只留标题与计数。 */
.dsm-qa-fold{width:100%;box-sizing:border-box;background:0 0;border:0;padding:2px 0;color:inherit;font:inherit;cursor:pointer;text-align:left}
.dsm-qa-fold:hover{opacity:.95}
.dsm-qa-caret{flex:none;width:9px;display:inline-block;opacity:.7}
/* v0.2.2 外观设置滑杆（原生 range 即可，宽度对齐 mv-field）。 */
.mv-field input[type="range"]{width:100%;accent-color:var(--dsmqa-fg,#F1EFE8)}
.archv-body{flex:1;min-width:0;display:flex;align-items:center;gap:12px}
.archv-actions{display:flex;gap:8px;flex:none;flex-wrap:nowrap;justify-content:flex-end}
.archv-btn{appearance:none;min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-subtle);color:var(--dsw-alias-label-secondary);border-radius:var(--dsm-radius-ctl);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-align:center;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.archv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.archv-btn:disabled{opacity:.5;cursor:default}
.archv-del{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.archv-del:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.archv-go{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent)}
.archv-go:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}
.archv-empty{display:flex;align-items:center;gap:10px;padding:20px 14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-card);color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.archv-skel{display:flex;flex-direction:column;gap:8px}
.archv-skel-card{height:58px;border-radius:var(--dsm-radius-card);background:var(--dsw-alias-fill-subtle);position:relative;overflow:hidden}
.archv-skel-card::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-fill-elevated) 75%,transparent),transparent);animation:archv-shimmer 1.4s infinite}
.archv-status{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483601;background:linear-gradient(var(--dsw-alias-fill-elevated),var(--dsw-alias-fill-elevated)),var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);padding:9px 16px;border-radius:999px;font-size:12px;line-height:1.5;text-align:center;box-shadow:0 8px 24px rgb(0 0 0/.25);display:flex;align-items:center;gap:8px;animation:archv-pop .18s ease-out;max-width:min(92vw,480px);cursor:pointer}
.archv-status-long{border-radius:14px;text-align:left}
.archv-spin{width:12px;height:12px;border:2px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:archv-rot .8s linear infinite;flex:none}
@keyframes archv-shimmer{100%{transform:translateX(100%)}}
@keyframes archv-rot{to{transform:rotate(360deg)}}
@keyframes archv-pop{from{opacity:0;transform:translateX(-50%) translateY(10px)}}
/* 失败提示用警示色 + 加粗，并停留更久（需要用户读完去做下一步操作）。 */
.archv-status-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:500}
@media (prefers-reduced-motion:reduce){.archv-skel-card::after{animation:none}.archv-card,.archv-btn,.archv-star{transition:none}.archv-star:hover,.archv-star:active{transform:none}.archv-status,.archv-spin{animation:none}}
@media (max-width:640px){.archv-card{flex-direction:column;align-items:stretch;gap:10px}.archv-actions{justify-content:flex-end}.sess-tools,.sess-tools-4,.sess-tools-5{grid-template-columns:1fr}.archv-btn{min-height:40px}.archv-star{width:30px;height:30px}.archv-star svg{width:22px;height:22px}.dsm-kids{margin-left:10px}.archv-titlerow{flex-wrap:wrap}.dsm-kid-row{flex-wrap:wrap}.dsm-kid-acts{margin-left:0}}
.mv-sheet{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;margin-top:12px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-sheet);background:var(--dsw-alias-fill-subtle)}
.mv-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.mv-sheet-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.mv-sheet-close{appearance:none;width:26px;height:26px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:16px;line-height:1}
.mv-sheet-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ws-arch-list{display:flex;flex-direction:column;max-height:320px;overflow:auto}
.ws-arch-row{display:flex;align-items:center;gap:12px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.ws-arch-row:first-child{border-top:none}
.ws-arch-name{min-width:0;flex:1;font-size:12.5px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcp-list{display:flex;flex-direction:column}
.mcp-row{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.mcp-row:first-child{border-top:none}
.mcp-meta{min-width:0;flex:1}
.mcp-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcp-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcp-sw{min-width:76px}
.mcp-sw-on{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.mcp-note{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mcp-err{color:var(--dsw-alias-state-error-primary)}
.skill-row{flex-wrap:wrap;gap:8px}
.skill-seg{width:auto;flex:none}
.skill-seg .mv-segbtn{min-height:26px;padding:0 9px;font-size:11.5px}
.skill-act{min-width:auto;padding:0 9px;font-size:11.5px}
.skill-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.skill-tag{margin-left:6px;padding:1px 5px;border-radius:5px;font-size:10px;font-weight:500;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-fill-elevated)}
.skill-import{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.skill-root{min-height:28px;max-width:100%;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11.5px}
.skill-broken{font-size:11px}
.skill-broken summary{cursor:pointer}
.skill-broken-row{padding-left:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* v3.15.0 模型路由：候选链是横排的，每一步都可能很长，所以每一环都得能缩。
   否则一个长模型名会把整个 sheet 顶宽（与 v3.14.2 面板那次的坑同一个）。 */
.router-row{flex-wrap:wrap}
.router-id{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.router-chain{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;white-space:normal}
.router-hop{display:inline-flex;align-items:center;gap:2px;min-width:0}
.router-hop-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}
.router-arrow{color:var(--dsw-alias-label-tertiary);opacity:.7}
.router-hop-acts{display:inline-flex;gap:0}
.router-mini{appearance:none;flex:none;padding:0 3px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:15px;cursor:pointer}
.router-mini:hover:not(:disabled){background:var(--dsw-alias-fill-elevated)}
.router-mini:disabled{opacity:.3;cursor:default}
.router-over{margin-left:2px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.router-acts{display:flex;flex:none;gap:6px}
.router-acts .archv-btn{padding:0 9px;font-size:11.5px}
.router-del:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.router-edit{flex:1 1 100%;display:flex;flex-direction:column;gap:6px;padding:8px 0 2px}
.router-edit-foot{display:flex;justify-content:flex-end;gap:6px}
.router-new{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.router-tier{display:inline-block;padding:0 4px;border-radius:4px;font-size:10px;font-weight:600;background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-secondary)}
.router-tier-heavy{color:var(--dsw-alias-state-warn-primary,#EAB308)}
.router-warn{margin-left:6px;padding:0 4px;border-radius:4px;font-size:10px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.mv-row-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.mv-inline-label{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mv-inline-label input[type="number"]{width:58px;min-height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11.5px}
.mv-inline-label input[type="text"],.mv-inline-label textarea{width:100%;min-height:26px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11.5px;font-family:var(--dsm-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);resize:vertical}
.router-edit .mv-inline-label{display:flex;flex-direction:column;align-items:stretch;gap:4px}
.mv-seg{display:flex;gap:2px;padding:2px;background:var(--dsw-alias-fill-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-sheet);width:100%}
.mv-segbtn{appearance:none;flex:1;min-height:30px;padding:0 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.mv-segbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mv-segbtn-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgb(0 0 0/.08)}
.mv-field{display:flex;flex-direction:column;gap:6px}
.mv-field label.mv-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.mv-field select,.mv-field input[type=text]{box-sizing:border-box;appearance:none;width:100%;min-height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-ctl);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}
.mv-field select:focus-visible,.mv-field input[type=text]:focus-visible,.mv-sheet-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.mv-browse-row{display:flex;align-items:center;gap:8px}
.mv-browse-row input[type=text]{flex:1;min-width:0}
.mv-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:2px}
@media (max-width:640px){.archv-row{flex-wrap:wrap}.mv-sheet{padding:12px}}
.dtl-sheet{margin-top:12px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-sheet);background:var(--dsw-alias-fill-subtle)}
.dtl-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dtl-sheet-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.dtl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:10px}
.dtl-cell{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-fill-elevated);min-width:0}
.dtl-k{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dtl-v{font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}
.dtl-sec{margin-top:12px}
.dtl-export{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dtl-export .archv-btn{text-decoration:none}
.dtl-note{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.dtl-sec-t{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}
.dtl-tags{display:flex;flex-wrap:wrap;gap:6px}
.dtl-tag{display:inline-flex;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-tag);padding:2px 8px}
.dtl-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dtl-list code,.dtl-paths code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary);word-break:break-all}
.dtl-filetool{color:var(--dsw-alias-label-tertiary)}
.dtl-paths{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.more-wrap{position:relative;flex:none}
.more-btn{appearance:none;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1}
.more-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.more-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:60;min-width:160px;padding:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-sheet);box-shadow:0 10px 32px rgb(0 0 0/.24);display:flex;flex-direction:column;gap:1px}
.more-item{appearance:none;display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;background:transparent;color:var(--dsw-alias-label-primary);border-radius:7px;font-size:12.5px;cursor:pointer;white-space:nowrap;text-align:left}
.more-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.more-item-danger{color:var(--dsw-alias-state-error-primary)}
.more-item-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dlg-backdrop{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.dlg{width:min(420px,92vw);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:14px;padding:18px;box-shadow:0 16px 48px rgb(0 0 0/.28);display:flex;flex-direction:column;gap:12px}
.dlg-title{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary);margin:0}
.dlg-text{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0;word-break:break-all}
/* issue #18 第 4 条：删除确认框里的「连带子代理」勾选行。与面板其它勾选项
   同一套视觉语言（13px / 中性标签色 / 8px 间距），不自造按钮样式。 */
.dlg-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dlg-check input{margin:2px 0 0;flex:none}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
/* ---- T4 标签编辑/管理 sheet 与筛选保存控件（全部走 --dsw token） ---- */
.dsm-taglist{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto}
.dsm-tagcheck{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 2px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:7px}
.dsm-tagcheck:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-tagcheck input{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;flex:none}
.dsm-tagcheck-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-tagrow{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsm-tagrow:last-child{border-bottom:none}
.dsm-tag-name{flex:0 1 auto;min-width:0;font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-tag-input{box-sizing:border-box;flex:1 1 auto;min-width:0;min-height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-ctl);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}
.dsm-tag-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsm-tag-acts{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
.dsm-tag-acts .archv-btn{min-height:26px;padding:0 9px;font-size:11px}
.dsm-tag-acts select{appearance:none;min-height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-ctl);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;max-width:10em}
.dsm-fbar{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto;flex-wrap:wrap}
.dsm-fbar .archv-btn{min-height:24px;padding:0 8px;font-size:11px}
.dsm-fbar select{appearance:none;min-height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-ctl);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;max-width:12em}
.dsm-fbar input{box-sizing:border-box;min-width:9em;min-height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-ctl);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-primary);font-size:11px;font-family:inherit}
@media (max-width:640px){.dsm-fbar{margin-left:0;width:100%;justify-content:flex-end}.dsm-tag-acts{margin-left:auto;flex-wrap:wrap;justify-content:flex-end}}
`

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
  } catch {
    return String(iso)
  }
}

function fmtBytes(n) {
  if (!n && n !== 0) return null
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do { v /= 1024; u++ } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`
}

function pathName(p) {
  if (!p) return null
  const parts = String(p).replace(/\\+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

// 服务端 409 错误码：会话正被 DSH 占用写权限（0.1.3 单写者机制）。切走会话后
// 原地重试即可，所以这类失败要给用户一个「重试」入口。
const BUSY_CODE = 'DSM_SESSION_BUSY'

async function postJSON(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data) {
    // 保留服务端错误码：UI 需要据此区分「可重试」的失败（如 DSM_SESSION_BUSY
    // —— 会话正被 DSH 占用写权限，切走会话后原地重试即可）与重试也无用的错误。
    const error = new Error((data && (data.error || data.message)) || `request failed (${res.status})`)
    if (data && data.code) error.code = data.code
    throw error
  }
  return data
}

// GET 版：只读路由（如 /mcp/rows）用，错误处理与 postJSON 同口径。
async function getJSON(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data) {
    const error = new Error((data && (data.error || data.message)) || `request failed (${res.status})`)
    if (data && data.code) error.code = data.code
    throw error
  }
  return data
}

// 打开一个会话（尤其是侧栏不渲染的子代理会话）。
//
// 只走官方公开契约，按方法存在性分支、不写死核心版本：
//   旧核心（≤0.1.6）  ctx.get('sessions') 自带
//     sessions.open(id)                 —— 选中会话为当前
//     sessions.refreshSubagents(parent) —— 刷新某父会话的直接子代理目录
//     sessions.openSubagent(address)    —— 用「直接父 + 子」地址打开目录里的子代理
//   新核心（0.1.7+ / 0.2.0+）sessions 退化为会话数据流服务（retain/release/
//     readPage…，没有 open），切换会话的公开入口是 uiWorkspace.openSession(target)：
//     target 为会话 id 字符串，或 {parentSessionId, childSessionId, mode} 子代理
//     地址（与旧 openSubagent 契约同形，replaceMain 经 sessions.retain 原生支持；
//     id 命中已加载目录的子代理时核心会自动解析地址）。核心侧栏点会话走的就是
//     这条路径（dsh-workspace-kit 0.1.12 起同样从 ctx.sessions.open 迁移过来）。
// 拿不到任何服务时返回 null，由调用方给出降级提示，绝不触碰私有内部状态。
// —— v0.2 快捷访问：侧栏底部「进行中」按钮 + 聚合弹出面板 ——————————————
// 数据源 = 侧栏 adapter 在 paint 时登记的状态行（quickAccessRegistry，与状态点
// 同源，见 paint 循环写入点）。已知限制：折叠工作区组内的会话行不渲染、不入
// 登记，展开对应组后自然出现；adapter 熔断时 registry 停止更新（面板显示「暂
// 无」，不影响官方侧栏）。条目跳转走 dsmSessionsService()（新旧核心双兼容）。
const quickAccessRegistry = new Map()
// v0.2.8：本次进程内「曾进入 running」的会话集合——快捷面板据此区分
// 「刚跑完（曾是 running，现已停）」与「一直空闲」。进入会话时删除，
// 表示用户已经看过它的终态。
// v0.4.0：**权威数据源切换**。翻 app.asar 发现客户端服务 `uiSession`
// （@deepseek-ai/dsh-client-ui-session）已经维护了同一套状态：
//   sessionStatus = { getSnapshot(), subscribe() }
//   Map<sessionId, { running, pendingInteraction, completionUnread }>
// 且 observeRunning() 内建「running→停止 = 完成未读」语义（正是我们手写的
// 状态机），并覆盖**全部会话**（含折叠分组）——比 DOM 采集更准、更全，
// 还能少掉 1 秒轮询与宿主日志解码。此处优先用它，旧宿主回退 DOM 采集。
let dsmUiSessionStatus = null // { getSnapshot, subscribe } | null
// v0.5.1：客户端会话商店 `uiSession.sessions.list`（快照 {phase, ids, byId}）。
// **本机唯一可靠的「最后活动时间」来源**——实证（~/.dsh/sessions-manager/debug.log）：
//   store:probe phase=ready ids=455 row={id,displayTitle,running,retainedBy,blank,
//               updatedAt,formatStatus,projectionValues,title,cwd} updatedAt=1794358791738
// 而宿主 /archived-sessions/sessions 在 SessionHandle 世代恒无 updatedAt
// （host-list:probe items=455 withUpdatedAt=0，根因见 src/index.js:593 提前 return）。
// 核心侧栏行显示「5 分钟前」用的就是这个数值型 updatedAt（epoch ms）。
let dsmSessionListStore = null
// v0.5.0：由「只存标题」升级为**整行缓存**（sid → 宿主列表条目）。标题仍取
// it.title（补 uiSession 的缺口），新增的 updatedAt / starred / priority /
// review / workspaceTitle 供面板次级区（最近活跃 / 已标记）使用——同一份载荷，
// 零额外请求。上限 = 会话数（数百量级），不额外裁剪。
const dsmMetaCache = new Map()
const dsmTitleOf = (id) => (dsmMetaCache.get(String(id)) || {}).title || ''
let dsmHostListAt = 0
let dsmHostListLogged = false
// 列表来源：宿主 /archived-sessions/sessions（请求路径零解码，成本低）。
// 15 秒节流；失败则清空时间戳以便下次重试。
// v0.5.2：force=true 强制刷新——面板每次打开都拉一次最新标注，否则刚打的标记
// 会被 15s 节流挡住，用户得「关掉再点开」才看得见（用户反馈）。
function dsmEnsureHostTitles(force = false) {
  if (!force && Date.now() - dsmHostListAt < 15000) return
  dsmHostListAt = Date.now()
  try {
    fetch('/archived-sessions/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const items = (data && data.items) || []
        // 整表替换，而不是只 add：会话被删/被移走后旧条目必须消失，
        // 否则「共 N 个会话」永远只增不减，已标记/最近活跃还会列出已删除的会话。
        const live = new Set()
        for (const it of items) {
          if (it && it.sessionId != null) {
            const key = String(it.sessionId)
            live.add(key)
            dsmMetaCache.set(key, it)
          }
        }
        for (const key of [...dsmMetaCache.keys()]) if (!live.has(key)) dsmMetaCache.delete(key)
        if (!dsmHostListLogged) {
          dsmHostListLogged = true
          const ups = items.map((it) => it && it.updatedAt).filter((v) => typeof v === 'number')
          dsmDebugLog('host-list:loaded',
            'items=' + items.length,
            'withUpdatedAt=' + ups.length,
            'keys=' + JSON.stringify(Object.keys(items[0] || {})))
        }
        if (typeof dsmRepaintDots === 'function') dsmRepaintDots()
      })
      .catch(() => { dsmHostListAt = 0 })
  } catch (e) { dsmHostListAt = 0 }
}
// 由 uiSession 快照构造面板行。返回 null 表示「该数据源不可用」→ 调用方回退
// 到 DOM 采集；返回数组（可能为空）表示权威结果。
function dsmRowsFromUiSession() {
  if (!dsmUiSessionStatus) return null
  let snap = null
  try { snap = dsmUiSessionStatus.getSnapshot() } catch (e) { return null }
  if (!snap || typeof snap.forEach !== 'function') return null
  const manual = dsmLoadManual()
  const out = []
  snap.forEach((st, sid) => {
    const id = String(sid)
    let state = stateFromSessionStatus(st, { manualUnread: manual.has(id), turnKind: dsmTurnKind.get(id) })
    // v3.14.1：回合已结束、也已读，但宿主 jobs 里还有活作业 —— 仍然留在「刚完成」，
    // 否则用户点进去看一眼就再也找不到是谁还在跑后台任务。
    if (!state && (dsmJobMap.get(id) || []).length) state = 'done'
    if (!state) return
    out.push({ sessionId: id, state, title: dsmTitleOf(id) })
  })
  return out
}

// v0.5.1：次级区（最近活跃 / 已标记）的数据行。以**客户端会话商店**为主——
// 它是本机唯一带「最后活动时间」的来源；标题优先取商店行（displayTitle/title，
// 与核心侧栏显示一致），标注字段（starred/priority/review/tags）与工作区名仍取自
// 宿主载荷 dsmMetaCache；商店不可用时整体退回宿主载荷（旧宿主可能自带 updatedAt）。
function dsmActivityItems() {
  let snap = null
  try { snap = dsmSessionListStore ? dsmSessionListStore.getSnapshot() : null } catch (e) { snap = null }
  if (snap && snap.byId) {
    const ids = Array.isArray(snap.ids) ? snap.ids : Object.keys(snap.byId)
    const storeRows = []
    for (const rawId of ids) {
      const row = snap.byId[rawId]
      if (!row) continue
      storeRows.push({ ...row, id: row.id != null ? row.id : rawId })
    }
    // 合成逻辑是纯函数（logic.mergeActivityItems），此处只负责取快照。
    return mergeActivityItems(storeRows, dsmMetaCache)
  }
  return [...dsmMetaCache.values()].map((it) => ({ ...it, sessionId: String(it.sessionId) }))
}

const dsmRunSeen = new Set()
// v0.3.3 诊断通道：把关键步骤 POST 到宿主 /archived-sessions/debug-log，
// 落盘到 ~/.dsh/sessions-manager/debug.log（GUI 无 console 时的排障手段）。
function dsmDebugLog(...parts) {
  try {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
    fetch('/archived-sessions/debug-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: [line] }),
    }).catch(() => {})
  } catch (e) { /* 诊断失败无副作用 */ }
}

// v0.3.0：右栏标签页的打开入口（apply 时由右栏可用性决定是否赋值）。
let dsmOpenQuickAccessTab = null
// v0.5.4：右栏 tab 的目标会话 id。
// `sidebar.right.pane.tab` 是 `kind:"keyed", scope:"session"`——标签必须挂在**某个
// 会话**的右栏里，所以「在右栏打开」失败的真实原因往往是「没探到当前会话 id」，
// 而不是真的没有会话（原来的提示语会误导）。这里按
// 「当前选中 → 面板里已有的会话」顺序取目标；右栏标签体是全局列表，挂在谁的右栏
// 里都一样，故面板首行是合法兜底。把走过的路径一并返回，失败时落盘便于排查。
function dsmRailTarget() {
  const tried = []
  const idOf = (v) => {
    if (typeof v === 'string') return v
    if (v && typeof v.id === 'string') return v.id
    if (v && typeof v.sessionId === 'string') return v.sessionId
    return ''
  }
  try {
    const ui = dsmClientCtx && dsmClientCtx.get && dsmClientCtx.get('uiWorkspace')
    const snap = ui && typeof ui.getSnapshot === 'function' ? ui.getSnapshot() : null
    if (snap) {
      for (const path of ['current', 'activeId', 'mainId', 'selection.current', 'selection.activeId']) {
        const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), snap)
        const id = idOf(v)
        if (id) return { id, via: 'uiWorkspace.' + path, tried }
        tried.push('ws:' + path)
      }
    } else tried.push('ws:no-snapshot')
  } catch (e) { tried.push('ws:err') }
  try {
    const s = dsmClientCtx && dsmClientCtx.get && dsmClientCtx.get('uiSession')
    const id = idOf(s && s.current)
    if (id) return { id, via: 'uiSession.current', tried }
    tried.push('us:current')
  } catch (e) { tried.push('us:err') }
  try {
    const sels = [
      '[role="treeitem"][aria-selected="true"][data-row-key^="session:"]',
      '[data-row-key^="session:"][aria-selected="true"]',
      '[data-session-id][aria-selected="true"]',
      '[data-session-id][aria-current="true"]',
    ]
    for (const q of sels) {
      const el = document.querySelector(q)
      if (!el) { tried.push('dom:' + q.slice(0, 20)); continue }
      const raw = String(el.getAttribute('data-row-key') || el.getAttribute('data-session-id') || '')
      const id = raw.indexOf('session:') === 0 ? raw.slice('session:'.length) : raw
      if (id) return { id, via: 'dom', tried }
    }
  } catch (e) { tried.push('dom:err') }
  try {
    const rows = dsmRowsFromUiSession() || [...quickAccessRegistry.values()]
    const folded = foldSubagentRows(rows, dsmLineage, (id) => dsmTitleOf(id))
    if (folded.length && folded[0] && folded[0].sessionId) {
      return { id: String(folded[0].sessionId), via: 'panel-row', tried }
    }
    tried.push('panel:empty')
    const items = dsmActivityItems()
    if (items.length && items[0] && items[0].sessionId) {
      return { id: String(items[0].sessionId), via: 'activity-row', tried }
    }
    tried.push('activity:empty')
  } catch (e) { tried.push('panel:err') }
  return { id: '', via: '', tried }
}
// v0.2.8：会话最近一次 turn/end 的 reason.kind（'completed' / 'error' /
// 'aborted' / 'interrupted' / ...）。由 host 的 /archived-sessions/turn-kind
// 按需返回（仅在「刚停止」的少数会话上请求一次），用于区分「刚完成」与
// 「出错」——DSH 侧栏本身没有 error 态。
const dsmTurnKind = new Map() // sid → kind | 'pending'
// v0.3.5：改为**惰性 + 串行小批**。turn-kind 需要宿主解码整本会话日志，多个
// 大日志同时解码会占满宿主事件循环（可能让模型流式响应卡到超时）——所以只在
// 面板打开时处理「待分类」条目，且同一时刻至多一批（≤4 个）。
let dsmTurnKindBatchBusy = false
function dsmFetchTurnKindBatch(ids) {
  if (dsmTurnKindBatchBusy || !ids.length) return
  dsmTurnKindBatchBusy = true
  const batch = ids.slice(0, 4)
  fetch('/archived-sessions/turn-kind', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionIds: batch }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      for (const sid of batch) {
        const kind = data && data.ok && data.kinds ? data.kinds[sid] : null
        if (typeof kind === 'string') dsmTurnKind.set(sid, kind)
        else dsmTurnKind.delete(sid) // 查不到 → 下一拍再试
      }
      if (typeof dsmRepaintDots === 'function') dsmRepaintDots()
    })
    .catch(() => { for (const sid of batch) dsmTurnKind.delete(sid) })
    .finally(() => { dsmTurnKindBatchBusy = false })
}

// —— v0.2.2 快捷面板外观设置（netease-lyrics 同款模式）———————————————
// 存储：localStorage['dsm-qa-style-v1']，形状 { preset, radius, blur, opacity,
// width }。preset ∈ PRESET 键；细参数存在时**叠加**于预设之上（调一个滑杆不
// 抹掉其他偏好）。缺省 preset = 'dark-glass'（即 v0.2.1 的原样式）。
const QA_STYLE_KEY = 'dsm-qa-style-v1'

// `--dsmqa-solid` = 同一预设的**不透明**底色，供吸顶标题条使用（半透明的 --dsmqa-bg
// 挡不住从下面滚过的内容）。运行时若能在宿主里测到真正的页面底色，会用它覆盖
// --dsmqa-head-bg，那时这一项只作为兜底（见 dsmFitPanel）。
const QA_STYLE_PRESETS = {
  'dark-glass': { label: '深色玻璃（默认）', vars: {
    '--dsmqa-bg': 'rgba(24,24,26,.86)', '--dsmqa-solid': '#18181A', '--dsmqa-fg': '#F1EFE8',
    '--dsmqa-border': 'rgba(127,127,127,.22)', '--dsmqa-blur': '14px',
    '--dsmqa-radius': '14px', '--dsmqa-width': '760px',
    '--dsmqa-note': 'rgba(241,239,232,.55)',
  } },
  light: { label: '浅色纸面', vars: {
    '--dsmqa-bg': 'rgba(255,253,248,.92)', '--dsmqa-solid': '#FFFDF8', '--dsmqa-fg': '#26241F',
    '--dsmqa-border': 'rgba(120,113,95,.28)', '--dsmqa-blur': '14px',
    '--dsmqa-radius': '14px', '--dsmqa-width': '760px',
    '--dsmqa-note': 'rgba(38,36,31,.55)',
  } },
  ocean: { label: '海洋（青蓝）', vars: {
    '--dsmqa-bg': 'rgba(16,30,42,.88)', '--dsmqa-solid': '#101E2A', '--dsmqa-fg': '#D7ECF7',
    '--dsmqa-border': 'rgba(96,165,250,.28)', '--dsmqa-blur': '14px',
    '--dsmqa-radius': '14px', '--dsmqa-width': '760px',
    '--dsmqa-note': 'rgba(215,236,247,.55)',
  } },
  neon: { label: '霓虹（品红）', vars: {
    '--dsmqa-bg': 'rgba(24,14,28,.88)', '--dsmqa-solid': '#180E1C', '--dsmqa-fg': '#F6D5FF',
    '--dsmqa-border': 'rgba(217,70,239,.35)', '--dsmqa-blur': '16px',
    '--dsmqa-radius': '16px', '--dsmqa-width': '760px',
    '--dsmqa-note': 'rgba(246,213,255,.55)',
  } },
  mono: { label: '黑白（极简）', vars: {
    '--dsmqa-bg': 'rgba(18,18,18,.92)', '--dsmqa-solid': '#121212', '--dsmqa-fg': '#F2F2F2',
    '--dsmqa-border': 'rgba(255,255,255,.18)', '--dsmqa-blur': '8px',
    '--dsmqa-radius': '6px', '--dsmqa-width': '700px',
    '--dsmqa-note': 'rgba(242,242,242,.5)',
  } },
}

function readQaStyle() {
  try {
    const raw = JSON.parse(localStorage.getItem(QA_STYLE_KEY) || '{}') || {}
    const out = {}
    // v3.13.0：FOLLOW_PRESET（跟随歌词胶囊）不在 QA_STYLE_PRESETS 里，
    // 要单独放行，否则用户选了跟随再刷新就被打回 dark-glass。
    out.preset = raw.preset === FOLLOW_PRESET || QA_STYLE_PRESETS[raw.preset] ? raw.preset : 'dark-glass'
    // 细参数（合法域夹逼）：radius 0-24px / blur 0-28px / opacity 0.3-1（面板
    // 不透明度，作用于背景色 alpha 重写）/ width 480-1200px。
    out.radius = Number.isFinite(Number(raw.radius)) && raw.radius >= 0 && raw.radius <= 24 ? Number(raw.radius) : null
    out.blur = Number.isFinite(Number(raw.blur)) && raw.blur >= 0 && raw.blur <= 28 ? Number(raw.blur) : null
    out.opacity = Number.isFinite(Number(raw.opacity)) && raw.opacity >= 0.3 && raw.opacity <= 1 ? Number(raw.opacity) : null
    out.width = Number.isFinite(Number(raw.width)) && raw.width >= 480 && raw.width <= 1200 ? Number(raw.width) : null
    return out
  } catch (e) { return { preset: 'dark-glass', radius: null, blur: null, opacity: null, width: null } }
}

// v3.13.0 胶囊联动：把 netease-lyrics 的三个 localStorage 键读成一份快照。
// 读取失败（键不存在 / JSON 坏了 / 对方插件没装）一律返回 null——这时的行为是
// 「跟随态回落 dark-glass」，不能让面板因为隔壁插件的数据坏掉而变白板。
function readCapsuleSnapshot() {
  if (typeof localStorage === 'undefined') return null
  const parse = (key) => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const obj = JSON.parse(raw)
      return obj && typeof obj === 'object' ? obj : null
    } catch (e) { return null }
  }
  const display = parse(CAPSULE_DISPLAY_KEY)
  const notice = parse(CAPSULE_NOTICE_KEY)
  const colors = parse(CAPSULE_COLOR_KEY)
  if (!display && !notice && !colors) return null
  return { display: display || {}, notice: notice || {}, colors: colors || {} }
}

function writeQaStyle(next) {
  try {
    const cur = readQaStyle()
    localStorage.setItem(QA_STYLE_KEY, JSON.stringify({ ...cur, ...next }))
  } catch (e) { /* 存储不可用时静默：样式回落预设 */ }
  applyQaStyle()
}

// 把预设 + 细参数合成为最终 CSS 变量集合，写进 :root。每次调用整体重写
// （变量表封闭，无残留风险）；opacity 细参数改写背景色的 alpha 通道。
function applyQaStyle() {
  if (typeof document === 'undefined' || !document.documentElement) return
  const prefs = readQaStyle()
  const root = document.documentElement
  const following = prefs.preset === FOLLOW_PRESET
  const vars = { ...QA_STYLE_PRESETS['dark-glass'].vars }
  if (following) {
    // v3.13.0 跟随态：材质完全来自歌词胶囊快照；面板自己的四个滑杆仍优先
    // （detail 覆盖 capsule），否则用户在跟随下拖滑杆会没反应。
    const detail = { radius: prefs.radius, blur: prefs.blur, opacity: prefs.opacity, width: prefs.width }
    Object.assign(vars, qaVarsFromCapsule(readCapsuleSnapshot(), detail))
    // v3.13.1：跟随态默认铺满整块区域（用户实测反馈「不该是 760px 居中的窄卡」）。
    // 只有用户显式拖过宽度滑杆才用那个值——所以这里不是「胶囊给什么用什么」。
    vars['--dsmqa-width'] = prefs.width != null ? prefs.width + 'px' : 'none'
  } else {
    const preset = QA_STYLE_PRESETS[prefs.preset] || QA_STYLE_PRESETS['dark-glass']
    Object.assign(vars, preset.vars)
    if (prefs.radius != null) vars['--dsmqa-radius'] = prefs.radius + 'px'
    if (prefs.blur != null) vars['--dsmqa-blur'] = prefs.blur + 'px'
    if (prefs.width != null) vars['--dsmqa-width'] = prefs.width + 'px'
    if (prefs.opacity != null) {
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(String(vars['--dsmqa-bg'] || ''))
      if (m) vars['--dsmqa-bg'] = `rgba(${m[1]},${m[2]},${m[3]},${prefs.opacity})`
    }
  }
  // 清空走 QA_STYLE_VAR_KEYS 而不是某一个预设的键：跟随态会写 wash/grain/glow
  // 这类普通预设没有的变量，只清普通预设的键会把这些留在 :root 上。
  for (const key of QA_STYLE_VAR_KEYS) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(vars)) {
    if (value == null || value === '') continue
    root.style.setProperty(key, value)
  }
  // 面板本体是否自己上材质，由这个属性开关（见 CSS 里 :root[data-dsmqa-follow="1"]）。
  if (following) root.setAttribute('data-dsmqa-follow', '1')
  else root.removeAttribute('data-dsmqa-follow')
}

// v0.2.4 问题3修复：状态点颜色是**语义常量**（黄=进行中/琥珀=待处理/红=出错/
// 绿=刚完成），不随面板主题预设换色——否则切主题会丢失「什么颜色代表什么」的
// 指示意义（用户实测反馈）。外观设置只管面板容器样式。
const QA_GROUP_META = [
  { key: 'running', label: '进行中', color: '#EAB308' },
  { key: 'feedback', label: '待你处理', color: '#F59E0B' },
  { key: 'error', label: '出错', color: '#EF4444' },
  { key: 'done', label: '刚完成 · 未读', color: '#22C55E' },
]

// 面板本体：全局面板形态（经 main slot 挂载，IG5 逆向工作台同款入口）。
// 轻量轮询 quickAccessRegistry（1s）——面板按需挂载，不打开就不耗。
// v0.3.0：同一组件服务两种容器——全局面板（main slot，宽布局）与右侧栏
// 标签页（sidebar.right.pane.tab，窄布局）。compact=true 时去掉大标题与
// 内边距，适配右栏 ~320px 宽度。
// v0.5.3 诊断（每次页面加载一行）：面板能否滚动取决于宿主容器有没有给定高度，
// 而 GUI 没有 console——这里把自身与祖先的滚动能力一次性记进 debug.log：
// oy=overflow-y，ch=clientHeight，sh=scrollHeight（ch < sh 且 oy 可滚 = 真的能滚）。
// 保留一行成本极低，且下次「面板滚不动」时不用再从头推断。
let dsmScrollProbeDone = false
function dsmProbeScroll(el) {
  if (dsmScrollProbeDone || !el) return
  dsmScrollProbeDone = true
  try {
    const parts = []
    let cur = el
    for (let i = 0; i < 7 && cur; i += 1) {
      const cs = window.getComputedStyle(cur)
      const cls = String(cur.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      parts.push(`${i}:${cur.tagName.toLowerCase()}${cls ? '.' + cls : ''} oy=${cs.overflowY} ch=${cur.clientHeight} sh=${cur.scrollHeight}`)
      cur = cur.parentElement
    }
    dsmDebugLog('panel:scroll', parts.join(' | '))
  } catch (e) { /* best-effort */ }
}

// v0.5.4：分组可收起（替代「按上限截断」）。收起状态按 group key 记在
// localStorage，刷新界面或重开面板后保持。搜索时一律展开——搜到的条目若藏在
// 收起的组里，用户会以为「没搜到」。
const QA_COLLAPSE_KEY = 'dsm-qa-collapsed-v1'
function readQaCollapsed() {
  try {
    return normalizeCollapsed(JSON.parse(window.localStorage.getItem(QA_COLLAPSE_KEY) || '{}'))
  } catch (e) { return {} }
}
function writeQaCollapsed(next) {
  try { window.localStorage.setItem(QA_COLLAPSE_KEY, JSON.stringify(next)) } catch (e) { /* 忽略 */ }
}

// v0.5.4：让面板自己成为滚动容器——先实测宿主可用高度，再写 max-height。
// 为什么不能只写 `max-height:100%`：panel:scroll 取证显示面板紧邻的父节点是
// 0 高、height:auto 的 div，百分比高度对 auto 高度的父级解析为 none，等于没设；
// 而吸顶标题条需要一个确定的滚动上下文才稳定。
// 吸顶条底色同样不猜主题令牌：向上找第一个**真正画了底色**的祖先，用它同色，
// 内容从下面滚过时就看不出来。两条都落盘一行，便于下次直接看数据。
let dsmFitLogged = false
function dsmFitPanel(el) {
  if (!el || typeof window === 'undefined') return
  try {
    let anc = el.parentElement
    while (anc && anc !== document.body && anc !== document.documentElement && anc.clientHeight <= 0) {
      anc = anc.parentElement
    }
    let avail = 0
    if (anc && anc !== document.body && anc !== document.documentElement) {
      const ar = anc.getBoundingClientRect()
      const offset = el.getBoundingClientRect().top - ar.top + anc.scrollTop
      // v3.13.2：面板顶到容器顶这段视觉空隙（宿主的 tabBody 内边距，或面板上方那个
      // 0 高兄弟节点带来的外边距）。跟随胶囊时面板是张材质卡片，这段空隙会让卡片和
      // 上方导航之间露出一条宿主底色——用户实测反馈「距离侧边栏顶部导航还有一截距离」。
      // 写成变量后由 CSS 用负 margin 吃掉；上限 40px，避免宿主布局异常时把面板拉飞。
      // v3.13.3：负 margin 一旦生效，el.top - ar.top 恒为 0 —— 每次重算都把自己抹平，
      // 面板弹回原位，用户看到的就是「修了但空隙还在」。所以先把上一次已经吃掉的量
      // 加回来，得到未被 margin 干预的「自然位置」，再据此决定吃多少（幂等）。
      const appliedGap = Number.parseFloat(el.style.getPropertyValue('--dsmqa-gap-top')) || 0
      const naturalTop = el.getBoundingClientRect().top - ar.top + appliedGap
      const gapTop = Math.max(0, Math.min(40, Math.round(naturalTop)))
      const following = document.documentElement.getAttribute('data-dsmqa-follow') === '1'
      avail = Math.max(200, Math.floor(anc.clientHeight - (offset + appliedGap) - 6))
      // 跟随态顶部被负 margin 抬高了 gapTop，高度要等量加回来，否则底边会空出同样一截。
      const height = avail + (following ? gapTop : 0)
      el.style.maxHeight = height + 'px'
      // v3.13.1：同样把可用高度写成变量。跟随胶囊时面板要「铺满整块区域」而不是
      // 只包住内容高度——否则内容短时材质只覆盖上半截，下面露出宿主底色（用户实测
      // 反馈）。不跟随时没有规则消费这个变量，行为与 v3.12.0 完全一致。
      el.style.setProperty('--dsmqa-avail', height + 'px')
      el.style.setProperty('--dsmqa-gap-top', gapTop + 'px')
    }
    let cur = el.parentElement
    let bg = ''
    while (cur && !bg) {
      const c = window.getComputedStyle(cur).backgroundColor
      if (c && c !== 'transparent' && !/,\s*0(\.0+)?\)$/.test(c)) bg = c
      cur = cur.parentElement
    }
    if (bg) el.style.setProperty('--dsmqa-head-bg', bg)
    if (!dsmFitLogged) {
      dsmFitLogged = true
      const cls = anc ? String(anc.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
      // v3.13.2：把几何写全，便于判断「顶部那截空隙」究竟在面板外还是面板内——
      // pt = 面板顶相对容器顶的距离（也就是我们无法用负 margin 吃掉的那段），
      // st = 吸顶条自身高度，stTop = 吸顶条顶相对面板顶，sh = 面板内容高。
      const ar = anc ? anc.getBoundingClientRect() : null
      const pr = el.getBoundingClientRect()
      const st = el.querySelector('.dsm-qa-sticky')
      const stRect = st ? st.getBoundingClientRect() : null
      dsmDebugLog('panel:fit', `avail=${avail} anc=${anc ? anc.tagName.toLowerCase() : '-'}${cls ? '.' + cls : ''} ch=${anc ? anc.clientHeight : 0} head-bg=${bg || '(none)'} pt=${ar ? Math.round(pr.top - ar.top) : '?'} st=${stRect ? Math.round(stRect.height) : 0} stTop=${stRect && ar ? Math.round(stRect.top - pr.top) : '?'} sh=${el.scrollHeight} chh=${el.clientHeight} stv=${el.scrollTop}`)
    }
  } catch (e) { /* best-effort */ }
}

function DsmQuickAccessPanel({ compact = false } = {}) {
  // v0.5.0：view = { rows（关注区，子代理已折叠）, attentionIds（关注区**折叠前**的
  // 全部会话 id）}。attentionIds 用于把关注区已列出的会话从次级区排除——折叠掉的
  // 子代理也算「已在上方出现」，否则它们会用自己的名字出现在「最近活跃」里。
  const [view, setView] = React.useState({ rows: [], attentionIds: new Set() })
  const rows = view.rows
  // v0.5.3：记录一次面板与宿主容器的滚动能力（见 dsmProbeScroll）。
  const rootRef = React.useRef(null)
  React.useEffect(() => {
    // v0.5.3 诊断 + v0.5.4 实测：把面板高度撑到宿主可用高度（面板自身成为滚动
    // 容器，吸顶条才有确定上下文），并把宿主页面底色写进 --dsmqa-head-bg。
    dsmProbeScroll(rootRef.current)
    dsmFitPanel(rootRef.current)
    const onResize = () => dsmFitPanel(rootRef.current)
    window.addEventListener('resize', onResize)
    // 面板刚插入时祖先可能还没完成布局，落定后再量一次。
    const late = window.setTimeout(() => dsmFitPanel(rootRef.current), 1200)
    return () => { window.removeEventListener('resize', onResize); window.clearTimeout(late) }
  }, [])
  // v0.5.4：分组收起状态（见 readQaCollapsed）。
  const [collapsed, setCollapsed] = React.useState(readQaCollapsed)
  const toggleFold = (key) => setCollapsed((cur) => {
    const next = { ...cur }
    if (next[key]) delete next[key]
    else next[key] = true
    writeQaCollapsed(next)
    return next
  })
  // v0.3.3 诊断：本体一旦渲染即记录（只记一次），用于判断 slot 是否命中。
  React.useEffect(() => { dsmDebugLog('rail:body-rendered', 'compact=' + !!compact) }, [compact])
  const [jumpErr, setJumpErr] = React.useState('')
  const [query, setQuery] = React.useState('')
  // v3.14.1：面板里展开/收起后台任务时强制重渲染（真源仍是模块级 dsmJobsOpen，
  // 与侧栏那套共用，所以两处开关是同一个状态）。
  const [, setJobsVer] = React.useState(0)
  React.useEffect(() => {
    // v0.4.0：优先 uiSession（全量、权威），不可用时回退 DOM 采集。
    const collect = () => {
      const viaUi = dsmRowsFromUiSession()
      const rows = viaUi !== null ? viaUi : [...quickAccessRegistry.values()]
      // 注：分类在折叠前做（子代理也需要判定成败），折叠只影响展示层。
      // 「刚完成」需要判定成败（turn-kind），惰性处理：面板可见时一次一批。
      const pending = []
      for (const r of rows) {
        if (r.state !== 'done') continue
        if (dsmTurnKind.has(r.sessionId)) continue
        dsmTurnKind.set(r.sessionId, 'pending')
        pending.push(r.sessionId)
      }
      for (const [sid, kind] of dsmTurnKind.entries()) {
        if (kind === 'pending' && !pending.includes(sid)) pending.push(sid)
      }
      if (pending.length) dsmFetchTurnKindBatch(pending)
      return {
        rows: foldSubagentRows(rows, dsmLineage, (id) => dsmTitleOf(id)),
        attentionIds: new Set(rows.map((r) => String(r.sessionId))),
      }
    }
    const tick = (force = false) => {
      // v0.5.2：打开面板时强制拉一次（force=true），此后按 15s 节流；
      // 否则刚在管理面板打的标记会被节流挡住，必须关掉再点开才出现。
      dsmEnsureHostTitles(force) // 标题/元数据补齐（15s 节流）
      setView(collect())
    }
    tick(true)
    const timer = window.setInterval(tick, 1000)
    // uiSession 是响应式 store：状态一变立刻刷新（不必等下一拍）。
    let unsub = null
    if (dsmUiSessionStatus && typeof dsmUiSessionStatus.subscribe === 'function') {
      try { unsub = dsmUiSessionStatus.subscribe(() => setView(collect())) } catch (e) { unsub = null }
    }
    return () => { window.clearInterval(timer); if (typeof unsub === 'function') unsub() }
  }, [])
  const groups = React.useMemo(() => groupQuickAccess(rows), [rows])
  // v0.5.0 顶部摘要条：一行给出四组计数，列表很短时面板也不显空。
  const summary = React.useMemo(() => summaryCounts(rows), [rows])
  const needle = query.trim().toLocaleLowerCase()
  // 收起状态：搜索时强制展开（见 QA_COLLAPSE_KEY 注释）。
  const isFolded = (key) => !needle && !!collapsed[key]
  const matchRow = (row) => !needle
    || String(row.title || '').toLocaleLowerCase().includes(needle)
    || String(row.state || '').includes(needle)
    || String(row.workspaceTitle || '').toLocaleLowerCase().includes(needle)
  // v0.5.0 次级区：与关注区**不同维度**（时间维度 / 标记维度）。
  // 数据直接取自面板已在拉的宿主列表（dsmMetaCache）与客户端会话商店，不新增请求；
  // 渲染期现算，配合 1s tick 保证「多久以前」这类相对时间始终新鲜。
  // v0.5.2：先折叠子代理——子代理不单独成行，时间与标记归并到父会话（与关注区同）。
  const metaItems = foldActivityItems(dsmActivityItems(), dsmLineage, dsmTitleOf)
  const now = Date.now()
  const recentSec = recentActiveRows(metaItems, { now, exclude: view.attentionIds })
  const recentShown = recentSec.rows.filter(matchRow)
  // 已标记区再排除「刚在最近活跃里出现过」的，同一会话依旧只出现一次。
  // v0.7.0（用户决定）：拆成三小行——★收藏 / 待回看 / 高优先级，各自可独立折叠。
  const markedByKind = markedRowsByKind(metaItems, {
    now,
    exclude: new Set([...view.attentionIds, ...recentSec.rows.map((r) => r.sessionId)]),
  })
  const markedShownByKind = {}
  for (const kind of QA_MARKED_KINDS) markedShownByKind[kind] = markedByKind[kind].rows.filter(matchRow)
  const markedShown = QA_MARKED_KINDS.flatMap((kind) => markedShownByKind[kind])
  const shownGroups = QA_GROUP_META
    .map(({ key, label, color }) => ({ key, label, color, list: (groups[key] || []).filter(matchRow) }))
    .filter((g) => g.list.length > 0)
  const hasAny = shownGroups.length > 0 || recentShown.length > 0 || markedShown.length > 0
  const jump = (row) => {
    const svc = dsmSessionsService()
    if (!svc || typeof svc.open !== 'function') {
      setJumpErr('当前运行环境未开放会话切换接口，请在侧栏手动查找该会话')
      return
    }
    try {
      svc.open(row.sessionId)
      setJumpErr('')
      // v0.2.7：跳转 = 用户去亲眼确认了 → 即时移出面板（paint 的 active 转变沿
      // 也会删一次，这里先删是为了计数不闪）。
      quickAccessRegistry.delete(String(row.sessionId))
    } catch (e) {
      setJumpErr('跳转失败：' + String((e && e.message) || e))
    }
  }
  // —— v3.14.1 后台任务（面板侧）——
  // 数据来自宿主 jobs 服务，随 sidebar-state 一起下发（模块级 dsmJobMap）。
  // 面板只回答「谁还在跑 / 跑了多久」，不提供 kill——那属于宿主自己的 job 入口。
  const jobsOf = (row) => (row && row.sessionId != null ? (dsmJobMap.get(String(row.sessionId)) || []) : [])
  const toggleJobsOf = (row) => {
    const sid = String(row.sessionId)
    if (dsmJobsOpen.has(sid)) dsmJobsOpen.delete(sid)
    else dsmJobsOpen.add(sid)
    dsmSaveJobsOpen()
    setJobsVer((n) => n + 1)
  }
  const renderJobsBadge = (row) => {
    const jobs = jobsOf(row)
    if (!jobs.length) return null
    const open = dsmJobsOpen.has(String(row.sessionId))
    return (
      <button
        type="button"
        className="dsm-qa-jobs-t"
        title={jobs.length + ' 个后台任务还在跑（点击' + (open ? '收起' : '展开') + '）'}
        aria-expanded={open}
        aria-label={(open ? '收起' : '展开') + '该会话的 ' + jobs.length + ' 个后台任务'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleJobsOf(row) }}
      >{jobBadgeText(jobs.length, open)}</button>
    )
  }
  const renderJobList = (row) => {
    const jobs = jobsOf(row)
    if (!jobs.length || !dsmJobsOpen.has(String(row.sessionId))) return null
    const head = jobs.slice(0, JOB_BADGE_MAX_ROWS)
    const rest = jobs.length - head.length
    const nowMs = Date.now()
    return (
      <div className="dsm-qa-jobs">
        {head.map((j) => (
          <div key={j.id} className="dsm-qa-job">
            <span className="dsm-qa-job-name">{j.label || j.kind || shortId(j.id)}</span>
            <span className="dsm-qa-job-age">{jobDurationLabel(nowMs - (j.startedAt || nowMs))}</span>
          </div>
        ))}
        {rest > 0 && <div className="dsm-qa-job dsm-qa-job-more">还有 {rest} 个后台任务未列出</div>}
      </div>
    )
  }
  // 次级区共用渲染：左侧可选徽标（已标记区）→ 标题 → 工作区 → 相对时间。
  // v0.5.4：表头改为可收起的按钮（key 形如 sec:recent / sec:marked）。
  const renderSec = (key, label, hint, shown, total) => {
    if (!shown.length) return null
    const hidden = Math.max(0, Number(total || 0) - shown.length)
    const off = isFolded(key)
    return (
      <div key={key} className="dsm-qa-group dsm-qa-sec">
        <button
          type="button"
          className="dsm-qa-group-t dsm-qa-sec-h dsm-qa-fold"
          aria-expanded={!off}
          title={off ? '展开这一组' : '收起这一组'}
          onClick={() => toggleFold(key)}
        >
          <span className="dsm-qa-caret">{off ? '▸' : '▾'}</span>
          <span className="dsm-qa-sec-label">{label}（{shown.length}）</span>
          {hint && <span className="dsm-qa-sec-hint">{hint}</span>}
          {hidden > 0 && <span className="dsm-qa-sec-hint">另有 {hidden} 个未显示</span>}
        </button>
        {!off && shown.map((row) => (
          <React.Fragment key={row.sessionId}>
          <div
            role="button"
            tabIndex={0}
            className="dsm-qa-row"
            title={(row.title || row.sessionId)
              + (row.subagentCount ? `（含 ${row.subagentCount} 个子代理，已折叠）` : '')
              + (row.workspaceTitle ? `（${row.workspaceTitle}）` : '')
              + (row.ago ? ` · ${row.ago}` : '')
              + '（点击跳转）'}
            onClick={() => jump(row)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              jump(row)
            }}
          >
            {(row.badges || []).map((b) => <span key={b} className="dsm-qa-badge">{b}</span>)}
            {renderJobsBadge(row)}
            <span className="dsm-qa-row-t">{row.title || shortId(row.sessionId)}</span>
            {row.subagentCount > 0 && (
              <span className="dsm-qa-kids" title={`${row.subagentCount} 个子代理已折叠在父会话下`}>
                ▸ {row.subagentCount} 子代理
              </span>
            )}
            {row.workspaceTitle && <span className="dsm-qa-ws">{row.workspaceTitle}</span>}
            {row.ago && <span className="dsm-qa-ago">{row.ago}</span>}
          </div>
          {renderJobList(row)}
          </React.Fragment>
        ))}
      </div>
    )
  }
  return (
    <div ref={rootRef} className={compact ? 'dsm-qa-rail' : 'dsm-qa-main'}>
      {/* v0.5.4：标题 + 摘要条一起吸顶（底色见 .dsm-qa-sticky 与 dsmFitPanel）。 */}
      <div className="dsm-qa-sticky">
      <div className="dsm-qa-main-head">
        <span className="dsm-qa-main-title">进行中的会话</span>
        <span className="dsm-qa-main-count">{groups.count > 0 ? `${groups.count} 个` : '暂无'}</span>
        {!compact && dsmOpenQuickAccessTab && (
          <button
            type="button"
            className="archv-btn"
            title="在右侧栏打开（可与会话并列查看）"
            onClick={() => {
              const t = dsmRailTarget()
              if (t.id && dsmOpenQuickAccessTab(t.id)) { setJumpErr(''); return }
              dsmDebugLog('rail:open-fail', JSON.stringify({ id: t.id, via: t.via, tried: t.tried || [] }))
              setJumpErr(t.id
                ? '右栏接口不可用，已保留全局面板'
                : '还没有可用的会话：先在左侧选中或打开一个会话再试')
            }}
          >在右栏打开</button>
        )}
      </div>
      <div className="dsm-qa-sum" role="status" title="进行中的会话面板统计（共 N 个 = 插件索引到的会话总数）">
        {QA_GROUP_META.map(({ key, label, color }) => (
          <span key={key} className={'dsm-qa-sum-i' + (summary[key] ? ' dsm-qa-sum-on' : '')}>
            <span className="dsm-qa-dot" style={{ background: color }} />{label} {summary[key]}
          </span>
        ))}
        <span className="dsm-qa-sum-i dsm-qa-sum-all">共 {dsmMetaCache.size} 个会话</span>
      </div>
      {/* v3.13.2 筛选框移进吸顶条内部：原先它是吸顶条后面的兄弟节点，面板一滚动就
          从下面滑过去、被吸顶条盖掉（用户实测反馈「吸顶条会挡住搜索栏位」）。放进
          吸顶条后它随吸顶条一起固定，永远可点。 */}
      <input
        className="dsm-qa-search"
        type="text"
        value={query}
        placeholder="筛选（标题 / 状态 / 工作区）"
        aria-label="筛选进行中的会话"
        onChange={(e) => setQuery(e.target.value)}
      />
      </div>
      {jumpErr && <div className="dtl-note dsm-qa-err">{jumpErr}</div>}
      {!hasAny && (
        <div className="dtl-note">
          {needle ? '没有匹配的会话。' : '暂无进行中 / 待处理 / 出错 / 刚完成的会话。'}
          {!needle && !metaItems.length && (dsmUiSessionStatus ? '' : '（折叠分组里的会话要展开后才会出现在这里）')}
        </div>
      )}
      {shownGroups.map(({ key, label, color, list }) => {
        const off = isFolded(key)
        return (
        <div key={key} className="dsm-qa-group">
          <button
            type="button"
            className="dsm-qa-group-t dsm-qa-fold"
            aria-expanded={!off}
            title={off ? '展开这一组' : '收起这一组'}
            onClick={() => toggleFold(key)}
          >
            <span className="dsm-qa-caret">{off ? '▸' : '▾'}</span>
            <span className="dsm-qa-dot" style={{ background: color }} />
            {label}（{list.length}）
          </button>
          {!off && list.map((row) => (
            <React.Fragment key={row.sessionId}>
            <div
              role="button"
              tabIndex={0}
              className="dsm-qa-row"
              title={(row.title || row.sessionId)
                + (row.subagentCount ? `（含 ${row.subagentCount} 个子代理，已折叠）` : '')
                + '（点击跳转）'}
              onClick={() => jump(row)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                jump(row)
              }}
            >
              <span className="dsm-qa-dot" style={{ background: color }} />
              {renderJobsBadge(row)}
              <span className="dsm-qa-row-t">{row.title || shortId(row.sessionId)}</span>
              {row.subagentCount > 0 && (
                <span className="dsm-qa-kids" title={`${row.subagentCount} 个子代理已折叠在父会话下`}>
                  ▸ {row.subagentCount} 子代理
                </span>
              )}
            </div>
            {renderJobList(row)}
            </React.Fragment>
          ))}
        </div>
        )
      })}
      {/* v0.5.0 次级区①：时间维度——「我刚才在忙什么」。窗口 = 宿主列表的
          updatedAt（日志 mtime），故运行中的会话也会在这里，但关注区已列出的
          一律被排除，不会与上方重复。 */}
      {renderSec(
        'sec:recent',
        '最近活跃',
        `近 ${Math.round(QA_RECENT_WINDOW_MS / 3600000)} 小时有更新`,
        recentShown,
        recentSec.total,
      )}
      {/* v0.5.0 次级区②：标记维度——「我自己标过要看的」（v0.1 元数据层）。
          v0.7.0（用户决定）：拆成三小行，各带一句说明、可独立折叠。空类不渲染
          （renderSec 内 shown.length === 0 即返回 null），所以没标记时这一带整段消失。 */}
      {QA_MARKED_KINDS.map((kind) => renderSec(
        `sec:marked:${kind}`,
        QA_MARKED_KIND_LABEL[kind],
        QA_MARKED_KIND_HINT[kind],
        markedShownByKind[kind],
        markedByKind[kind].total,
      ))}
    </div>
  )
}

// v0.2.3：footer 弹层按钮入口已按用户要求移除（全局面板入口为唯一入口，
// 见 apply() 里的 sidebar.panellist + main 注册）；本组件与 .dsm-qa-panel
// 弹层 CSS 保留给样式参考，不再注册。

let dsmClientCtx = null
function dsmSessionsService() {
  try {
    if (!dsmClientCtx || typeof dsmClientCtx.get !== 'function') return null
    const native = dsmClientCtx.get('sessions')
    if (native && (typeof native.open === 'function' || typeof native.openSubagent === 'function')) return native
    const ui = dsmClientCtx.get('uiWorkspace')
    if (!ui || typeof ui.openSession !== 'function') return native
    let lastOpened = null
    const bridge = {
      open(id) {
        if (id === null || id === undefined) return
        const target = String(id)
        // 地址未加载的子代理会在这里被核心拒绝（unknown session），调用方
        // 依赖抛错落回 openSubagent 地址路径，因此不吞异常。
        ui.openSession(target)
        lastOpened = target
      },
      openSubagent(address) {
        if (address === null || address === undefined) return
        if (typeof address === 'object') {
          // 逐字段原样透传（parentSessionId / childSessionId / mode），新核心
          // 的 retain 直接以该地址解析历史路由。
          ui.openSession(address)
          lastOpened = String(address.childSessionId)
        } else {
          bridge.open(address)
        }
      },
      // 新核心的子代理目录由投影自动维护，无需手动刷新。
      refreshSubagents() {},
    }
    // dsmCurrentSessionId 走 list.getSnapshot().current 校验切换结果；桥接下
    // 核心未公开等价快照，以自己最近一次成功提交的目标为准。
    Object.defineProperty(bridge, 'list', {
      configurable: true,
      get() { return { getSnapshot: () => ({ current: lastOpened }) } },
    })
    return bridge
  } catch (e) { return null }
}
function dsmCurrentSessionId(svc) {
  try {
    const snap = svc && svc.list && typeof svc.list.getSnapshot === 'function' ? svc.list.getSnapshot() : null
    return snap && snap.current != null ? String(snap.current) : null
  } catch (e) { return null }
}
// 返回 Promise<'ok' | 'no-service' | 'failed'>：只回 true/false 的话，调用方
// 只能给出一句「打不开」的笼统提示——用户既不知道为什么，也不知道下一步该
// 怎么办。区分原因后提示才能说清「去哪儿、做什么」。
async function dsmOpenSessionById(childId, directParentId) {
  const sid = String(childId || '')
  if (!sid) return 'failed'
  const svc = dsmSessionsService()
  if (!svc) return 'no-service'
  const parent = directParentId ? String(directParentId) : null
  // 1) 直接选中（对仍在会话列表里的子代理最省事）。
  if (typeof svc.open === 'function') {
    try {
      svc.open(sid)
      await new Promise((r) => setTimeout(r, 350))
      if (dsmCurrentSessionId(svc) === sid) return 'ok'
    } catch (e) { /* 落到目录地址路径 */ }
  }
  // 2) 官方子代理目录路径：父会话头部的目录是 DSH 为子代理准备的导航入口，
  //    这里复用同一个地址契约（parentSessionId 必须是「直接父」，孙代也一样）。
  if (parent && typeof svc.openSubagent === 'function') {
    try {
      if (typeof svc.refreshSubagents === 'function') await svc.refreshSubagents(parent)
      svc.openSubagent({ parentSessionId: parent, childSessionId: sid, mode: 'continuable' })
      await new Promise((r) => setTimeout(r, 350))
      if (dsmCurrentSessionId(svc) === sid) return 'ok'
      // openSubagent 是同步 void，无法从返回值判断成败：地址已提交、当前会话
      // 可能因父会话上下文尚未就绪而稍后才切换，这里按成功处理避免重复触发。
      return 'ok'
    } catch (e) { /* 落到失败提示 */ }
  }
  return 'failed'
}

// ---- 活跃会话上报：host 判定「用户正在看哪个会话」的唯一来源 ----------------
//
// 0.1.7+ / 0.2.x 的 host 进程里没有 activeSession / currentSession /
// sessions.active 任何一个访问器（实测三个探测全部落空），它根本无从判断用户在
// 看哪个会话——但必须判断，否则两条保护形同虚设：
//   * 移动：活跃会话被写锁持有，硬动盘要排队（409 / queued）
//   * 自动归档：正在看的会话不该被默默归档掉
// 能看到 UI 状态的是客户端，所以由它周期性上报；host 只在心跳新鲜期内采信
// （见 src/active-session.js 的 TTL 说明：过期即失效，宁可漏判也不误判）。
//
// 探测顺序：uiWorkspace 的 selection 快照（持久化在 dsh.sessions.current，即
// 启动时恢复的那个选中项，最权威）→ uiWorkspace 的 mainView 引用（mainReference）
// → 旧核心 sessions.list.getSnapshot().current。
// 前两者是客户端服务对象上的字段，全部 try/catch 包裹：上游改名/重构只会退化成
// 「探测不到」（放行移动，移动路径本身有写锁 + 备份回滚兜底），不会抛错。
const DSM_CLIENT_ID = (() => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch (e) { /* 非安全上下文没有 randomUUID */ }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
})()

export function dsmActiveSessionId() {
  try {
    if (!dsmClientCtx || typeof dsmClientCtx.get !== 'function') return null
    const ui = dsmClientCtx.get('uiWorkspace')
    if (ui) {
      const snap = ui.selection && typeof ui.selection.getSnapshot === 'function' ? ui.selection.getSnapshot() : null
      if (snap && snap.sessionId != null) return String(snap.sessionId)
      const ref = ui.mainReference
      if (ref && ref.sessionId != null) return String(ref.sessionId)
    }
    const native = dsmClientCtx.get('sessions')
    if (native && native.list && typeof native.list.getSnapshot === 'function') {
      const snap = native.list.getSnapshot()
      if (snap && snap.current != null) return String(snap.current)
    }
  } catch (e) { /* 服务不可用/字段不存在 */ }
  return null
}

const DSM_ACTIVE_HEARTBEAT_MS = 15000
const DSM_ACTIVE_MIN_REPORT_MS = 30000
let dsmLastActiveReport = { id: null, at: 0 }

/**
 * 上报当前会话。心跳（force=false）在「值没变 + 距上次不足 30s」时跳过网络请求；
 * force=true 用于移动前强制同步——用户在心跳间隔内刚切过会话时，host 手里还是旧值。
 */
async function reportActiveSession(force) {
  const id = dsmActiveSessionId()
  const now = Date.now()
  if (!force && id === dsmLastActiveReport.id && now - dsmLastActiveReport.at < DSM_ACTIVE_MIN_REPORT_MS) return
  dsmLastActiveReport = { id, at: now }
  try {
    await postJSON('/archived-sessions/active-session', { clientId: DSM_CLIENT_ID, sessionId: id })
  } catch (e) { /* host 未就绪 / 路由缺失：静默，下个心跳再试 */ }
}

// 移动类请求：先同步一次活跃会话，再发真正的移动请求。否则 host 拿旧值放行，
// 移动中的会话恰好是用户刚切过去的那个（写锁持有 → 只能排队，UI 上表现为「排队」
// 而不是「已移动」——不算错，但用户点之前本可以选别的会话）。
async function postActiveAware(path, body) {
  await reportActiveSession(true).catch(() => null)
  return postJSON(path, body)
}

// Left-nav icon swap: DSH's settings shell renders a shared fallback gear for
// every custom section and settings.section has no per-section icon field.
// Like dsh-better-sidebar, we mark our own row by matching its visible label
// text, then CSS swaps the gear for an archive-box glyph. The marker owns no
// shell structure and is removed on fiber disposal (HMR-safe, ships with the
// plugin).
const NAV_CSS = `
[data-dsh-nav-sessions] > svg:first-child { display: none; }
[data-dsh-nav-sessions]::before {
  content: ''; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D'http://www.w3.org/2000/svg'%20width%3D'24'%20height%3D'24'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'black'%20stroke-width%3D'2'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Cpath%20d%3D'M21%208v13H3V8'/%3E%3Cpath%20d%3D'M1%203h22v5H1z'/%3E%3Cpath%20d%3D'M10%2012h4'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D'http://www.w3.org/2000/svg'%20width%3D'24'%20height%3D'24'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'black'%20stroke-width%3D'2'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Cpath%20d%3D'M21%208v13H3V8'/%3E%3Cpath%20d%3D'M1%203h22v5H1z'/%3E%3Cpath%20d%3D'M10%2012h4'/%3E%3C/svg%3E") center / contain no-repeat;
}
`

function markSettingsNav() {
  const LABEL = '会话管理'
  let disposed = false
  let frame = 0
  const run = () => {
    frame = 0
    if (disposed) return
    // 廉价早退：设置面板没打开时整页只有一个 dialog 查询的开销，不遍历按钮。
    if (!document.querySelector('[role="dialog"]')) return
    const buttons = document.querySelectorAll('[role="dialog"] nav button')
    for (const b of buttons) {
      const t = (b.textContent || '').trim()
      if (t === LABEL) b.setAttribute('data-dsh-nav-sessions', '')
      else b.removeAttribute('data-dsh-nav-sessions')
    }
  }
  // rAF 合并：整页 MutationObserver 在一个渲染帧里可能触发成百上千次回调，
  // 每帧最多真正同步一次。
  const sync = () => { if (!frame && !disposed) frame = requestAnimationFrame(run) }
  run()
  // 刻意**不**监听 characterData：流式回复逐 token 改文本，会把整页观察器打成
  // 高频回调；导航按钮的标签只在 childList（面板重渲染）时变化，够用。
  const obs = new MutationObserver(sync)
  obs.observe(document.body, { childList: true, subtree: true })
  return () => {
    disposed = true
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    obs.disconnect()
    document.querySelectorAll('[data-dsh-nav-sessions]').forEach((e) => e.removeAttribute('data-dsh-nav-sessions'))
  }
}

function installSettingsNavIcons(ctx) {
  const styleEl = document.createElement('style')
  styleEl.textContent = NAV_CSS
  document.head.appendChild(styleEl)
  const dispose = markSettingsNav()
  ctx.effect(() => () => {
    dispose()
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
  })
}

function SessionPanel({ workspacesSvc }) {
  const [sessions, setSessions] = useState(null)
  const [workspaces, setWorkspaces] = useState([])
  const [capabilities, setCapabilities] = useState(null)
  const initialPrefs = useRef(loadPanelPrefs()).current
  // 注意：'storage' 已从可持久化取值中移除（它不再是视图），旧版残留的
  // filter='storage' 会自动回落到 'all'，避免落到一个已不存在的界面。
  const [filter, setFilter] = useState(() => ['all', 'active', 'archived', 'starred', 'review', 'empty', 'trash'].includes(initialPrefs.filter) ? initialPrefs.filter : 'all')
  // 低频分类折叠区：挂载时若选中的就是低频分类（偏好恢复/上次停留）则展开，
  // 保证激活 tab 始终可见；平时由箭头 hover/点按控制。
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState(() => initialPrefs.workspaceFilter || 'all')
  const [sortBy, setSortBy] = useState(() => ['newest', 'oldest', 'title', 'priority'].includes(initialPrefs.sortBy) ? initialPrefs.sortBy : 'newest')
  const [selected, setSelected] = useState({})
  const [delTarget, setDelTarget] = useState(null)
  // issue #18 第 4 条：删除父会话默认连带回收它的子代理（生命周期绑定），
  // 取消勾选则保留——保留的子代理会落进「未归属子代理」卡片，仍可单独处理。
  const [cascadeSub, setCascadeSub] = useState(true)
  useEffect(() => { if (delTarget) setCascadeSub(true) }, [delTarget])
  const [confirmBatch, setConfirmBatch] = useState(false)
  const [batchMoveOpen, setBatchMoveOpen] = useState(false)
  // v0.1 批量标注 sheet（优先级 / 待回看）：与批量移动 sheet 同型。
  const [batchMetaOpen, setBatchMetaOpen] = useState(false)
  const [batchPrio, setBatchPrio] = useState('')
  // 详情面板的备注草稿：按 sessionId 隔离（Map 形状 {sessionId: text}）——切换到
  // 另一个会话的详情不会丢掉前一个的未保存草稿（复核建议 5）。保存成功后删除
  // 该键，textarea 回落到乐观更新后的 it.note；纯内存态，随面板卸载重置。
  const [noteDrafts, setNoteDrafts] = useState({})
  const [busy, setBusy] = useState(null)
  const [openMove, setOpenMove] = useState(null)
  const [moveMode, setMoveMode] = useState('existing')
  const [targetWs, setTargetWs] = useState('')
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState(null)
  // 可重试的失败：{ run } —— run 是「把刚才那一步原样再做一次」的闭包。存对象
  // 而非裸函数，避免被 useState 当成更新函数吃掉。没有它时错误条的「重试」退回
  // 刷新列表（refresh）。
  const [retry, setRetry] = useState(null)
  const [toast, setToast] = useState(null)
  const [picking, setPicking] = useState(false)
  const [trash, setTrash] = useState([])
  // T2：待移动队列小节（D4 拍板随本期）——README 承诺了查看/取消，路由早就有，
  // 缺的只是入口。刷新尽力而为：失败=没队列，绝不打扰列表主流程。
  const [pendingQueue, setPendingQueue] = useState([])
  const cancelQueuedMove = async (sid) => {
    try {
      await postJSON('/archived-sessions/pending-moves/cancel', { sessionIds: [sid] })
      showToast('已取消排队，会话留在原工作区', 'ok')
      setPendingQueue((q) => q.filter((x) => String(x.sessionId) !== String(sid)))
    } catch (e) { showToast('取消失败：' + String((e && e.message) || e), 'err') }
  }
  const [trashBusy, setTrashBusy] = useState(null)
  const [trashSettings, setTrashSettings] = useState({ retentionDays: 0 })
  const [trashCheck, setTrashCheck] = useState(null)
  const [purgeTarget, setPurgeTarget] = useState(null)
  const [details, setDetails] = useState({})
  const detailsAt = useRef({})
  const [openDetails, setOpenDetails] = useState(null)
  const [detailsLoading, setDetailsLoading] = useState(null)
  const [mdBusy, setMdBusy] = useState(null)
  const [zipOk, setZipOk] = useState(true)
  const [storage, setStorage] = useState(null)
  const [storageBusy, setStorageBusy] = useState(false)
  // 存储统计要 stat 每条会话日志，开销不小：面板默认收起、按需加载，
  // 且展开状态刻意不持久化——否则每次打开设置面板都会触发一次全量扫描。
  const [storageOpen, setStorageOpen] = useState(false)
  const [storageError, setStorageError] = useState(null)
  const [aa, setAa] = useState({ settings: { inactiveDays: 0, skipStarred: true }, lastRunAt: null, lastArchivedCount: 0 })
  const [aaOpen, setAaOpen] = useState(false)
  const [aaBusy, setAaBusy] = useState(false)
  // v3.12.0 工作区归档（语义 A = 只做可见性）：记录本身由 host 的
  // workspace-archive store 持久化，这里只缓存「当前折叠了哪些」的状态。
  const [wsArch, setWsArch] = useState({ items: [], keys: [] })
  const [wsArchOpen, setWsArchOpen] = useState(false)
  const [wsArchBusy, setWsArchBusy] = useState(false)
  const zipChecked = useRef(false)
  const [openMenu, setOpenMenu] = useState(null)
  const timer = useRef(null)
  // 存储面板关着时会话集合若发生变化，标脏；下次展开时再刷新，
  // 既不会显示过期数字，也避免每次 refresh 都白扫一遍全量日志。
  const storageDirty = useRef(false)
  const menuRef = useRef(null)
  const dialogRef = useRef(null)

  // 血缘分组（issue #6）：子代理折叠在父会话下。DSH 侧栏按设计不渲染子代理
  // 行（ui-subagent 明文 "omitted from the ordinary sidebar"），本面板是唯一
  // 能完整看到它们的地方，所以同一套「父 — 子」模型在这里落地：分组开启时
  // 子代理不再作为独立顶层卡片，而是折叠在父会话卡片下方。数据来自
  // sidebar-state 的官方 header 血缘字段（parentSession / origin），零解码。
  const [lineage, setLineage] = useState({})
  const [openKids, setOpenKids] = useState({})
  // 3.7.0 分支聚拢（D2/D4）：组展开态持久化（照侧栏 dsm-subs-open-v1 模式，数组键）。
  // 面板子代理折叠现状不持久化——不动它，避免两种语言互相牵连。
  const [openBranches, setOpenBranches] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem('dsm-branch-open-v1') || '[]')
      const o = {}
      for (const k of Array.isArray(v) ? v : []) if (typeof k === 'string') o[k] = true
      return o
    } catch (e) { return {} }
  })
  const toggleBranch = (rootId) => setOpenBranches((prev) => {
    const next = Object.assign({}, prev)
    if (next[rootId]) delete next[rootId]
    else next[rootId] = true
    try { localStorage.setItem('dsm-branch-open-v1', JSON.stringify(Object.keys(next))) } catch (e) {}
    return next
  })
  const [groupByLineage, setGroupByLineage] = useState(() => initialPrefs.groupByLineage !== false)
  // issue #18 第 1 条：父会话不在列表里的子代理收进一张「未归属子代理」卡片，
  // 展开态不持久化——默认收起，避免又一次把列表撑长。
  const [openOrphans, setOpenOrphans] = useState(false)

  // —— T4（3.7.0）标签 + 已存筛选 ——
  // 数据源纪律：卡片 chip、编辑 sheet 勾选、管理行用量、筛选下拉，一律以本
  // 地 assignments 乐观态为准（tags/list 全量 + 每次 /tags/set 采纳服务端回
  // 来的那一行）；/sessions 的 item.tags 只为筛选谓词供数，与 assignments
  // 同一次乐观写里成对更新，两者不可能漂移。tags/list 失败 = tagsReady 假：
  // chip 全隐藏、下拉与 ⋯ 菜单「标签」禁用（title 说原因），下次 refresh 再试。
  // 刻意不把 tagFilter 写进 localStorage 偏好：重启后若标签数据不可用，一个
  // 恢复出来的死筛选会把列表清成 0 行且无从解释——已存筛选功能才是持久组合
  // 的正规去处。
  const [tagDefs, setTagDefs] = useState([])
  const [assignments, setAssignments] = useState({})
  // 'loading'（首刷在途，中性文案）| 'ready' | 'failed'（tags/list 降级：chip
  // 全隐藏、下拉与 ⋯「标签」禁用，title 分别说「加载中」/「加载失败」）。
  const [tagsState, setTagsState] = useState('loading')
  const tagsReady = tagsState === 'ready'
  const [tagFilter, setTagFilter] = useState('')
  const [savedFilters, setSavedFilters] = useState([])
  const [openTags, setOpenTags] = useState(null)      // 展开标签编辑 sheet 的卡片 sessionId
  const [openTagMgr, setOpenTagMgr] = useState(false) // 标签管理 sheet
  const [qaStyleOpen, setQaStyleOpen] = useState(false) // v0.2.2 面板外观 sheet
  // v0.5.5 MCP 服务器开关：只读写 profile 的 cordis.patch.yml，重启 DSH 后生效。
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpRows, setMcpRows] = useState(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpErr, setMcpErr] = useState('')
  const [mcpNote, setMcpNote] = useState('')
  // v0.6.1：skill 列表管理（三态开关 + 导出/导入/删除，直接读写 SKILL.md 的 frontmatter）。
  const [skillOpen, setSkillOpen] = useState(false)
  const [skillData, setSkillData] = useState(null)
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillErr, setSkillErr] = useState('')
  const [skillNote, setSkillNote] = useState('')
  const [skillImportRoot, setSkillImportRoot] = useState('')
  const skillFileRef = useRef(null)
  // v3.15.0 模型路由：读写 llm-router / subagent-router 两个插件的 settings.json。
  // 与 MCP / profile 那类不同，它们靠 mtime 指纹 5 秒轮询，改完不用重启。
  // `routerTab` 是同一个弹层里的两个分区：'llm' | 'subagent'。
  // v3.17.0：顶部维护栏收成一个「设置」入口，低频配置全部进这个面板内的设置菜单。
  // 取值 = 当前打开的分组（'appearance' | 'archive' | 'storage' | 'host'），
  // null = 菜单关闭。用它替代原先 9 个独立的 open 状态做互斥；下面那些
  // qaStyleOpen / mcpOpen … 仍保留，因为要驱动各自的 sheet 内容。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('appearance')
  const [routerOpen, setRouterOpen] = useState(false)
  const [routerTab, setRouterTab] = useState('llm')
  const [routerSnap, setRouterSnap] = useState(null)
  const [routerBusy, setRouterBusy] = useState(false)
  const [routerErr, setRouterErr] = useState('')
  const [routerNote, setRouterNote] = useState('')
  // 正在展开编辑的路由 id / 候选 id（一次只开一个，弹层已经够拥挤了）。
  const [routerEdit, setRouterEdit] = useState('')
  const [routerDraft, setRouterDraft] = useState({ id: '', name: '', chain: '' })
  const [routerNew, setRouterNew] = useState({ open: false, id: '', name: '', chain: '' })
  // v0.2.4 问题3：外观偏好存 localStorage（非响应式），write 后以此 tick 强制
  // sheet 重读最新值，否则 select/滑杆显示卡在旧值。
  const [qaStyleTick, setQaStyleTick] = useState(0)
  const [tagBusy, setTagBusy] = useState(null)        // 单会话写锁（sessionId）
  const [mgrBusy, setMgrBusy] = useState(false)       // 管理 sheet 写锁（全局一把）
  const [cardTagName, setCardTagName] = useState('')  // 卡内 sheet「新建标签并贴上」输入
  const [mgrTagName, setMgrTagName] = useState('')    // 管理 sheet 顶部新建输入
  const [renamingTagId, setRenamingTagId] = useState(null)
  const [renameTagValue, setRenameTagValue] = useState('')
  const [mergeTarget, setMergeTarget] = useState({})  // fromId -> toId（行内 select 值）
  const [saveFilterOpen, setSaveFilterOpen] = useState(false)
  const [saveFilterName, setSaveFilterName] = useState('')
  const [appliedSavedId, setAppliedSavedId] = useState('')
  const tagFilterRef = useRef('')
  tagFilterRef.current = tagFilter

  // 标签 id → 名字（chip 渲染与 sheet 共用；死 id 查不到名字 → 渲染层跳过，
  // 半删标签的幽灵绝不上屏）。
  const tagMap = useMemo(() => new Map(tagDefs.map((t) => [String(t.id), String(t.name)])), [tagDefs])
  // 用量统计：管理行上的「N 个会话」以 assignments 为准（与会话是否在当前
  // 列表无关——已归档/被筛掉的打标会话也要算进用量）。
  const tagUsage = useMemo(() => {
    const m = {}
    for (const ids of Object.values(assignments)) for (const id of (Array.isArray(ids) ? ids : [])) m[String(id)] = (m[String(id)] || 0) + 1
    return m
  }, [assignments])
  // 禁用态统一说人话：区分「还在加载」与「加载失败」两种 tagsReady=false。
  const tagsBlockedTitle = tagsState === 'failed'
    ? '标签数据未能加载，暂时无法使用标签功能（重新打开设置面板可重试）'
    : '标签数据加载中，稍候即可使用'

  // tags/list：与 pending-moves 同一先例——尽力而为的旁路读取，失败降级空表
  // 并置 tagsState='failed'，绝不打扰列表主流程的错误条。
  const loadTags = () => postJSON('/archived-sessions/tags/list', {})
    .then((r) => {
      const defs = (r && Array.isArray(r.tags)) ? r.tags : []
      setTagDefs(defs)
      setAssignments((r && r.assignments && typeof r.assignments === 'object' && !Array.isArray(r.assignments)) ? r.assignments : {})
      setTagsState('ready')
      // 死筛选自愈：标签被别的窗口删了，刷新后不能把列表永久卡在 0 行。
      const cur = tagFilterRef.current
      if (cur && !defs.some((t) => String(t.id) === cur)) setTagFilter('')
    })
    .catch(() => {
      setTagDefs([]); setAssignments({}); setTagsState('failed')
      if (tagFilterRef.current) setTagFilter('')
    })
  const loadSavedFilters = () => postJSON('/archived-sessions/filters/list', {})
    .then((r) => setSavedFilters((r && Array.isArray(r.items)) ? r.items : []))
    .catch(() => setSavedFilters([]))

  // 全量替换某会话的标签：先双写本地（assignments + 该行 item.tags），失败
  // 双双回滚；成功则采纳服务端响应里这一行的最终值（并发冲突以服务端为准，
  // 其它行不动——它们可能正被别的在途乐观操作编辑，下一次 refresh 全量收敛）。
  const setSessionTags = async (sid, nextIds) => {
    const key = String(sid)
    const prev = Array.isArray(assignments[key]) ? assignments[key].slice() : []
    if (prev.length === nextIds.length && prev.every((t, i) => String(t) === String(nextIds[i]))) return
    const writeLocal = (ids) => {
      setAssignments((a) => {
        const n = Object.assign({}, a)
        if (ids.length) n[key] = ids
        else delete n[key]
        return n
      })
      setSessions((s) => s && s.map((x) => (String(x.sessionId) === key ? Object.assign({}, x, { tags: ids }) : x)))
    }
    writeLocal(nextIds)
    setTagBusy(key)
    try {
      const r = await postJSON('/archived-sessions/tags/set', { sessionId: sid, tagIds: nextIds })
      const row = r && r.assignments && Array.isArray(r.assignments[key]) ? r.assignments[key].map(String) : nextIds.map(String)
      writeLocal(row)
    } catch (e) {
      writeLocal(prev)
      showToast('标签设置失败：' + String((e && e.message) || e), 'err')
    } finally {
      setTagBusy(null)
    }
  }

  // 勾选 toggle：从当前本地行推导全量替换列表（>20 个时服务端 409，回滚 +
  // 报错——v1 不在前端复刻上限校验，规则只有服务端一份事实源）。
  const toggleTagFor = (sid, tagId) => {
    if (tagBusy !== null) return
    const key = String(sid)
    const cur = Array.isArray(assignments[key]) ? assignments[key] : []
    const has = cur.some((t) => String(t) === String(tagId))
    const next = has ? cur.filter((t) => String(t) !== String(tagId)) : cur.concat(String(tagId))
    setSessionTags(sid, next)
  }

  // 卡内「新建标签并贴上」：create 成功即刻并入 tagDefs（chip 无需等整表刷新），
  // 再走同一 setSessionTags 乐观通道（写锁交给它收尾）；create 失败（重名/非法/
  // 超限）只 toast，服务端中文错误信息原样转达。
  const createTagAndAttach = async (sid) => {
    const name = cardTagName.trim()
    if (!name || tagBusy !== null) return
    setTagBusy(String(sid))
    let fresh = null
    try {
      const r = await postJSON('/archived-sessions/tags/create', { name })
      if (r && r.tag && r.tag.id != null) fresh = r.tag
      else throw new Error('服务端未返回新标签')
    } catch (e) {
      showToast('新建标签失败：' + String((e && e.message) || e), 'err')
    }
    if (!fresh) { setTagBusy(null); return }
    setTagDefs((d) => (d.some((t) => String(t.id) === String(fresh.id)) ? d : d.concat(fresh)))
    const cur = Array.isArray(assignments[String(sid)]) ? assignments[String(sid)].slice() : []
    setCardTagName('')
    await setSessionTags(sid, cur.concat(String(fresh.id)))
  }

  // —— 标签管理 sheet 的四个写操作 ——
  // 全部本地镜像 + toast（merge/delete 会顺带自愈筛选态：删掉正在筛的标签 →
  // 复位「全部」；并入 → 筛选跟着换成目标标签），下一次 refresh 全量收敛。

  const createTag = async () => {
    const name = mgrTagName.trim()
    if (!name || mgrBusy) return
    setMgrBusy(true)
    try {
      const r = await postJSON('/archived-sessions/tags/create', { name })
      if (r && r.tag && r.tag.id != null) {
        const fresh = r.tag
        setTagDefs((d) => (d.some((t) => String(t.id) === String(fresh.id)) ? d : d.concat(fresh)))
        setMgrTagName('')
      }
    } catch (e) {
      showToast('新建标签失败：' + String((e && e.message) || e), 'err')
    } finally {
      setMgrBusy(false)
    }
  }

  const commitTagRename = async (tag) => {
    const name = renameTagValue.trim()
    if (!name || mgrBusy) { setRenamingTagId(null); return }
    if (name === tag.name) { setRenamingTagId(null); return }
    setMgrBusy(true)
    try {
      await postJSON('/archived-sessions/tags/rename', { id: tag.id, name })
      setTagDefs((d) => d.map((t) => (String(t.id) === String(tag.id) ? Object.assign({}, t, { name }) : t)))
      setRenamingTagId(null)
    } catch (e) {
      showToast('重命名失败：' + String((e && e.message) || e), 'err')
    } finally {
      setMgrBusy(false)
    }
  }

  const deleteTag = async (tag) => {
    if (mgrBusy) return
    if (!window.confirm(tagDeleteConfirm(tag.name))) return
    setMgrBusy(true)
    try {
      await postJSON('/archived-sessions/tags/delete', { id: tag.id })
      const gone = String(tag.id)
      setTagDefs((d) => d.filter((t) => String(t.id) !== gone))
      setAssignments((a) => {
        const n = {}
        for (const [sid, ids] of Object.entries(a)) {
          const kept = (Array.isArray(ids) ? ids : []).filter((id) => String(id) !== gone)
          if (kept.length) n[sid] = kept
        }
        return n
      })
      // item.tags 同步剔除死 id（筛选谓词读它）——否则被删标签的行仍留在筛选
      // 结果里，与 chip 消失自相矛盾。
      setSessions((s) => s && s.map((x) => {
        const curT = Array.isArray(x.tags) ? x.tags : []
        if (!curT.some((id) => String(id) === gone)) return x
        return Object.assign({}, x, { tags: curT.filter((id) => String(id) !== gone) })
      }))
      // 红线：删掉正在筛选的标签 → 自动复位「全部」，绝不留下一个 0 行死筛选。
      if (tagFilterRef.current === gone) setTagFilter('')
      setMergeTarget((m) => { const n = Object.assign({}, m); delete n[gone]; return n })
    } catch (e) {
      showToast('删除标签失败：' + String((e && e.message) || e), 'err')
    } finally {
      setMgrBusy(false)
    }
  }

  const mergeTag = async (from) => {
    const toId = mergeTarget[String(from.id)]
    if (!toId || mgrBusy) return
    setMgrBusy(true)
    try {
      await postJSON('/archived-sessions/tags/merge', { fromId: from.id, toId })
      const gone = String(from.id)
      setTagDefs((d) => d.filter((t) => String(t.id) !== gone))
      // 本地镜像 = 宿主语义：成员行改挂目标标签并按 id 去重（同会话两标都打
      // 时并完只剩一个），目标行不动。
      setAssignments((a) => {
        const n = {}
        for (const [sid, ids] of Object.entries(a)) {
          const kept = []
          const seen = new Set()
          for (const id of (Array.isArray(ids) ? ids : [])) {
            const v = String(id) === gone ? String(toId) : String(id)
            if (seen.has(v)) continue
            seen.add(v)
            kept.push(v)
          }
          if (kept.length) n[sid] = kept
        }
        return n
      })
      if (tagFilterRef.current === gone) setTagFilter(String(toId))
      setMergeTarget((m) => { const n = Object.assign({}, m); delete n[gone]; return n })
      // 与 assignments 同步镜像 item.tags（筛选谓词读它）：含 fromId 的行改挂
      // 目标标签并按 id 去重——否则「按目标标签筛选」要等整表刷新才命中。
      setSessions((s) => s && s.map((x) => {
        const curT = Array.isArray(x.tags) ? x.tags : []
        if (!curT.some((id) => String(id) === gone)) return x
        const nextT = []
        const seenT = new Set()
        for (const id of curT) {
          const v = String(id) === gone ? String(toId) : String(id)
          if (seenT.has(v)) continue
          seenT.add(v)
          nextT.push(v)
        }
        return Object.assign({}, x, { tags: nextT })
      }))
      showToast(`已并入「${tagMap.get(String(toId)) || '目标标签'}」`)
    } catch (e) {
      showToast('合并标签失败：' + String((e && e.message) || e), 'err')
    } finally {
      setMgrBusy(false)
    }
  }

  // —— 已存筛选：保存 / 应用 / 删除 ——
  // payload 形状转换全部走 logic 的纯函数对（snapshotOf 落盘、shapeFromSaved
  // 读回），往返等值有单测锁着；非法字段回落默认并在 toast 里说清。

  const saveCurrentFilter = async () => {
    const name = saveFilterName.trim()
    if (!name || mgrBusy) return
    setMgrBusy(true)
    try {
      const r = await postJSON('/archived-sessions/filters/save', {
        name,
        filters: filterSnapshotOf({ filter, workspaceFilter, sortBy, tagFilter }),
      })
      if (r && r.item) setSavedFilters((l) => (l.some((x) => String(x.id) === String(r.item.id)) ? l : l.concat(r.item)))
      setSaveFilterOpen(false)
      setSaveFilterName('')
      showToast(`已保存筛选「${(r && r.item && r.item.name) || name}」`)
    } catch (e) {
      // 409 重名 / 409 上限 / 400 名字无效：服务端中文消息原样转达。
      showToast('保存筛选失败：' + String((e && e.message) || e), 'err')
    } finally {
      setMgrBusy(false)
    }
  }

  const applySavedFilter = (id) => {
    const key = String(id)
    setAppliedSavedId(key)
    if (!key) return
    const item = savedFilters.find((x) => String(x.id) === key)
    if (!item) return
    const shape = filterShapeFromSaved(item)
    // 形状合法但指向已消失的标签 / 工作区：纯函数无从得知活数据，这里对账
    // ——标签不可用（未加载或已删）就复位「全部」，避免应用出 0 行死筛选；
    // 工作区即便被删也保留原值（列表空是诚实结果，兜底 option 说明状态）。
    const tagUnavailable = !!shape.tag && (!tagsReady || !tagMap.has(shape.tag))
    const degraded = shape.degraded.slice()
    if (tagUnavailable) degraded.push('tag')
    setFilter(shape.view)
    clearSel()
    setConfirmBatch(false)
    if (shape.view === 'starred' || shape.view === 'review' || shape.view === 'empty' || shape.view === 'trash') setMoreOpen(true)
    setWorkspaceFilter(shape.workspace)
    setSortBy(shape.sort)
    setTagFilter(tagUnavailable ? '' : shape.tag)
    if (degraded.length) {
      const labels = { view: '视图', workspace: '工作区', sort: '排序', tag: '标签' }
      showToast(`已应用筛选「${item.name}」，但其中 ${[...new Set(degraded)].map((k) => labels[k] || k).join('、')} 条件已失效并回落默认`, 'err')
    }
  }

  const deleteSavedFilter = async (id) => {
    if (mgrBusy) return
    setMgrBusy(true)
    try {
      await postJSON('/archived-sessions/filters/delete', { ids: [id] })
      setSavedFilters((l) => l.filter((x) => String(x.id) !== String(id)))
      if (String(appliedSavedId) === String(id)) setAppliedSavedId('')
    } catch (e) {
      showToast('删除已存筛选失败：' + String((e && e.message) || e), 'err')
    } finally {
      setMgrBusy(false)
    }
  }

  const loadLineage = () => postJSON('/archived-sessions/sidebar-state', {})
    .then((r) => setLineage((r && r.lineage) || {}))
    .catch(() => {})

  // kind: 'ok'（默认）| 'err'。停留时长按**字数**给（logic.toastDurationFor）：
  // 固定 2.4s 对"排队/失败"这类几十字的文案根本读不完（用户 2026-09-10 反馈）；
  // 失败类再 +2s 并用警示色。任何提示都可以**点击立即关闭**，不必干等。
  const showToast = (msg, kind) => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ msg, kind: kind === 'err' ? 'err' : 'ok' })
    timer.current = setTimeout(() => setToast(null), toastDurationFor(msg, kind))
  }

  // 版本徽章点击复制完整 buildStamp。webview 里 navigator.clipboard 可能缺失
  // 或被权限拒绝（此前失败被静默吞掉，用户以为按钮坏了）——失败落
  // execCommand 兜底；两条路都不通时至少把完整版本号亮在 toast 里。
  const copyBuildStamp = async () => {
    const full = String(capabilities && capabilities.buildStamp || '')
    if (!full) return
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(full)
        showToast('已复制完整版本号 ' + full, 'ok')
        return
      }
      throw new Error('clipboard unavailable')
    } catch (e) {
      try {
        const ta = document.createElement('textarea')
        ta.value = full
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('execCommand failed')
        showToast('已复制完整版本号 ' + full, 'ok')
      } catch (e2) {
        showToast('复制失败，完整版本号：' + full, 'err')
      }
    }
  }

  // 点击行尾短 ID 复制完整会话 ID。clipboard API 优先（desktop/web 的页面都来自
  // localhost，属安全上下文），失败回退 execCommand；成功把短 ID 短暂换成「已复制」
  // 作就近反馈，两条路径全失败时把完整 ID 亮进 toast 供手抄（与上方徽章的失败终点
  // 同一思路）。
  const copiedTimer = useRef(null)
  const [copiedId, setCopiedId] = useState(null)
  const copySessionId = (id) => {
    const markCopied = () => {
      setCopiedId(id)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1400)
    }
    const viaExecCommand = () => {
      try {
        const ta = document.createElement('textarea')
        ta.value = id
        ta.setAttribute('readonly', '')
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        if (ok) markCopied()
        else showToast('复制失败，完整 ID：' + id, 'err')
      } catch (e) { showToast('复制失败，完整 ID：' + id, 'err') }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(markCopied).catch(viaExecCommand)
    } else viaExecCommand()
  }

  const refresh = () => {
    setError(null)
    Promise.all([
      postJSON('/archived-sessions/sessions', {}),
      postJSON('/archived-sessions/workspaces', {}),
      postJSON('/archived-sessions/capabilities', {}),
    ])
      .then(([s, works, caps]) => {
        // Permanently-purged sessions must never re-appear here, even if DSH's
        // in-memory session index still lists them after the file was unlinked.
        const purged = dsmLoadPurged()
        const visible = (s.items || []).filter((x) => !purged.has(String(x.sessionId)))
        setSessions(visible)
        setWorkspaces(works.items || [])
        setCapabilities(caps || null)
        // 构建指纹打到控制台：面板行为与源码不一致时，第一件事就是核对这行——
        // host 端只在宿主启动时加载一次，不重启宿主看到的永远是旧代码。
        if (caps && caps.buildStamp) console.info('[dsh-lyin-sessions-manager] host build:', caps.buildStamp)
        setSelected({})
        setDelTarget(null)
        setConfirmBatch(false)
        loadLineage()
        // v3.12.0：工作区折叠集合与 workspaces 一起刷新（两处都只读，开销一次文件读）。
        loadWsArch()
        if (!targetWs && works.items && works.items.length) setTargetWs(works.items[0].workspaceId)
        loadTrash()
        // T4：标签与已存筛选的旁路读取（与 pending-moves 同一先例：失败降级，
        // 不进主错误条）。
        loadTags()
        loadSavedFilters()
        postJSON('/archived-sessions/pending-moves', {}).then((q) => setPendingQueue((q && q.items) || [])).catch(() => {})
        // 会话集合变了：面板开着就同步刷新；关着则只标脏，等展开时再刷。
        if (storageOpen) loadStorage()
        else storageDirty.current = true
      })
      .catch((e) => setError(String((e && e.message) || e)))
  }

  useEffect(() => {
    refresh()
    return () => { if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // v3.6.2 #5：面板只在 mount 拉一次，预热窗口内打开 = 整列占位冻结到手点
  // 「重新加载」。这里挂一个 warm-done 钩子：host 预热从「在途」翻到「完成」
  // 的瞬间自动补一次刷新（标题/血缘/空白分类一起浮现）。空闲时该转换不发生，
  // 不引入任何周期性刷新。
  const refreshRef = useRef(null)
  refreshRef.current = refresh
  useEffect(() => dsmOnWarmDone(() => { if (refreshRef.current) refreshRef.current() }), [])
  // T2：侧栏适配器停用（或宿主未装侧栏）时，排队移动通知走面板 toast 通道。
  useEffect(() => dsmOnNotice((text, kind) => showToast(text, kind)), [])

  useEffect(() => {
    try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify({ filter, workspaceFilter, sortBy, groupByLineage })) } catch (e) {}
  }, [filter, workspaceFilter, sortBy, groupByLineage])

  // 自动归档设置随面板加载一次（host 侧读取即触发每日检查）。
  // 存储统计刻意不在这里预取：它要 stat 每条日志，只在用户展开面板时才算。
  useEffect(() => {
    loadAutoArchive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 收藏切换：乐观更新 + 失败回滚（star 是高频轻操作，不等网络往返）。
  const toggleStar = async (it) => {
    const next = !it.starred
    setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, starred: next } : x)))
    try {
      await postJSON('/archived-sessions/star/set', { sessionId: it.sessionId, starred: next })
    } catch (e) {
      setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, starred: !next } : x)))
      showToast('收藏失败：' + String((e && e.message) || e))
    }
  }

  // —— v0.1 元数据层（优先级 / 待回看 / 备注）：与 toggleStar 同型的乐观更新 ——

  const toggleReview = async (it) => {
    const next = !it.review
    setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, review: next } : x)))
    try {
      await postJSON('/archived-sessions/meta/set', { sessionId: it.sessionId, patch: { review: next } })
    } catch (e) {
      setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, review: !next } : x)))
      showToast('待回看标记失败：' + String((e && e.message) || e))
    }
  }

  const setPriority = async (it, raw) => {
    const prev = Number.isInteger(it.priority) ? it.priority : null
    const priority = raw === '' ? null : Number(raw)
    if (priority === prev) return
    setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, priority } : x)))
    try {
      await postJSON('/archived-sessions/meta/set', { sessionId: it.sessionId, patch: { priority } })
    } catch (e) {
      setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, priority: prev } : x)))
      showToast('优先级保存失败：' + String((e && e.message) || e))
    }
  }

  const saveNote = async (it, text) => {
    const prev = typeof it.note === 'string' ? it.note : ''
    const note = String(text ?? '').slice(0, 2000)
    setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, note } : x)))
    try {
      await postJSON('/archived-sessions/meta/set', { sessionId: it.sessionId, patch: { note } })
      return true
    } catch (e) {
      setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, note: prev } : x)))
      showToast('备注保存失败：' + String((e && e.message) || e))
      return false
    }
  }

  // 批量标注：meta/set 本身就是原子批量（单请求全量应用，无部分失败形态），
  // 失败即整体回滚提示——不需要 hkkz9522 式的逐条结果对话框。
  const doBatchMeta = async (patch, label) => {
    if (!selIds.length || busy) return
    setBusy('__batch__')
    try {
      await postJSON('/archived-sessions/meta/set', { sessionIds: selIds, patch })
      setSessions((s) => s && s.map((x) => (selIds.includes(String(x.sessionId)) ? { ...x, ...patch } : x)))
      showToast(`已为 ${selIds.length} 个会话${label}`)
    } catch (e) {
      showToast(`批量${label}失败：` + String((e && e.message) || e))
    } finally {
      setBusy(null)
    }
  }

  // Markdown 导出：自有路由（/archived-sessions/export-md），blob 触发下载。
  const exportMarkdown = async (it) => {
    if (mdBusy) return
    setMdBusy(it.sessionId)
    try {
      const res = await fetch('/archived-sessions/export-md?sessionId=' + encodeURIComponent(it.sessionId))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'dsh-session-' + it.sessionId + '.md'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast('已导出 Markdown')
    } catch (e) {
      showToast('导出失败：' + String((e && e.message) || e))
    } finally {
      setMdBusy(null)
    }
  }

  // 官方 ZIP 导出预检（一次性）：后端不支持 raw artifacts 时返回 501，
  // 此时隐藏 ZIP 入口只留 Markdown（全局缓存，后端能力不会中途变）。
  // 探针用非法 id 走 HEAD：命中 501 = 不支持；404/400 = 路由活着且支持。
  useEffect(() => {
    if (openDetails === null || zipChecked.current) return
    zipChecked.current = true
    fetch('/api/session.export?sessionId=probe&includeDescendants=false', { method: 'HEAD' })
      .then((res) => setZipOk(res.status !== 501))
      .catch(() => setZipOk(true))
  }, [openDetails])

  // Close the ⋯ menu on outside click / Escape (no full-screen backdrop).
  useEffect(() => {
    if (openMenu === null) return
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenu(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  useEffect(() => {
    if (!delTarget && !purgeTarget) return
    const previous = document.activeElement
    const onKey = (e) => {
      if (e.key === 'Escape') { setDelTarget(null); setPurgeTarget(null) }
    }
    document.addEventListener('keydown', onKey)
    requestAnimationFrame(() => dialogRef.current && dialogRef.current.querySelector('button')?.focus())
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && typeof previous.focus === 'function') previous.focus()
    }
  }, [delTarget, purgeTarget])

  const wsPath = (id) => {
    const w = workspaces.find((x) => x.workspaceId === id)
    return w ? w.path : ''
  }
  // 能力读取：优先 v3.5.2 规范键名，回退旧键名（旧 host / 缓存响应兼容）。
  const actionCapability = (name, legacy) => {
    const source = capabilities && capabilities.actions
    return (source && (source[name] || (legacy && source[legacy]))) || { available: false, reason: '正在检查当前 DSH 的兼容能力…' }
  }
  const canPurge = actionCapability('physicalPurge', 'purge')
  const canMove = actionCapability('relocateSession', 'move')
  const canRestoreTrash = actionCapability('restoreIndexedSession', 'restoreTrash')

  // issue #18 第 1 条：子代理会话不是「一条可管理的会话」，而是父会话的下属。
  // 先前它们以顶层行的形式混进「活动 / 全部」，一个重度的多代理工作日能攒出
  // 上百个「(无标题)」——计数、全选、批量操作全被它们污染。这里统一判定，
  // 表格计数与顶层行都用它排除；子代理只出现在父会话的「N 子代理」里。
  const isSubagentItem = useCallback((item) => {
    const li = item ? lineage[String(item.sessionId)] : null
    return !!(li && li.origin === 'subagent')
  }, [lineage])
  // v3.12.0 工作区归档（语义 A = 只做可见性）：被折叠工作区里的会话在面板里
  // 整体不出现——计数、搜索、全选、批量操作全都走这份集合，避免出现「列表里
  // 看不到，全选却能选中」的错位。会话自身的归档状态不改，恢复后原样回来。
  const wsFoldKeys = wsArch.keys
  // 例外：用户在下拉里显式点名了一个已归档的工作区 —— 那就是「我要看它」，
  // 此时不折叠，否则选中后只会看到空列表。
  const wsPeekKey = workspaceFilter !== 'all' && !isWorkspaceSentinel(workspaceFilter) ? workspaceFilter : ''
  const visibleSessions = useMemo(
    () => visibleItemsAfterWorkspaceFold(sessions, wsFoldKeys, wsPeekKey),
    [sessions, wsFoldKeys, wsPeekKey],
  )
  // 列表管线仍要拿到子代理行（折叠判定要用它们挂到父会话下），所以保留一份
  // 未过滤的集合；只有「计数 / 顶层行 / 全选」用 topOnly。
  const { archivedAll, activeAll, starredAll, reviewAll, emptyAll } = useMemo(() => ({
    archivedAll: visibleSessions ? visibleSessions.filter((x) => x.archived) : [],
    activeAll: visibleSessions ? visibleSessions.filter((x) => !x.archived) : [],
    starredAll: starredOf(visibleSessions),
    // v0.1 元数据层：待回看视图（与收藏同型，正交于活动/归档状态）。
    reviewAll: reviewOf(visibleSessions),
    // issue #6 之三：空白会话单分一类。空白判定来自宿主血缘快照（sizeBytes 阈值
    // 实测校准），与侧栏「空白」标记同源——两处永远不会各说各话。
    emptyAll: visibleSessions ? visibleSessions.filter((x) => { const li = lineage[String(x.sessionId)]; return !!(li && li.empty) }) : [],
  }), [visibleSessions, lineage])
  // 血缘分组开着时，计数只算「能作为一行被操作的会话」。平铺模式保持原样
  // （用户显式选择与 DSH 原生一致的平铺视图）。
  const topOnly = useCallback((arr) => (groupByLineage ? arr.filter((x) => !isSubagentItem(x)) : arr), [groupByLineage, isSubagentItem])
  const archivedList = useMemo(() => topOnly(archivedAll), [topOnly, archivedAll])
  const activeList = useMemo(() => topOnly(activeAll), [topOnly, activeAll])
  const starredList = useMemo(() => topOnly(starredAll), [topOnly, starredAll])
  const reviewList = useMemo(() => topOnly(reviewAll), [topOnly, reviewAll])
  const emptyList = useMemo(() => topOnly(emptyAll), [topOnly, emptyAll])
  // 「全部」计数：血缘分组下同样只算能作为一行的会话（子代理在父行徽标里）。
  const totalTopCount = useMemo(() => topOnly(visibleSessions || []).length, [topOnly, visibleSessions])
  const list = useMemo(() => {
    if (filter === 'trash') return []
    // 注意用 *All（含子代理）：列表管线要靠它们把子代理挂到父会话下；排除子代理
    // 发生在折叠之后的顶层行与计数（见 isSubagentItem / topOnly）。
    const base = filter === 'archived' ? archivedAll : filter === 'active' ? activeAll : filter === 'starred' ? starredAll : filter === 'review' ? reviewAll : filter === 'empty' ? emptyAll : visibleSessions || []
    // T4 标签筛选（单选，v1 不追多选 AND——理由见 logic.applyTagFilter）：在
    // 搜索/工作区之前先按标签收敛；''/未就绪时谓词原样返回，行为与旧版一致。
    const tagPassed = applyTagFilter(base, tagsReady ? tagFilter : '')
    const needle = query.trim().toLocaleLowerCase()
    const filtered = tagPassed.filter((item) => {
      // v0.7.0：三态——真实工作区路径 / 「未分组」/ 「工作区已删」，谓词见 logic.matchWorkspaceFilter。
      if (!matchWorkspaceFilter(item, workspaceFilter)) return false
      if (!needle) return true
      // v3.6.2 #6：占位标题的会话按「有效标题」（列表值 → 侧栏权威回落）匹配，
      // 预热补齐但面板未刷新时也能按关键词搜到。
      return [effectiveTitleOf(item, dsmAuthoritativeTitles), item.sessionId, item.workspaceTitle, item.workspacePath].some((value) => String(value || '').toLocaleLowerCase().includes(needle))
    })
    return [...filtered].sort((a, b) => {
      if (sortBy === 'oldest') return Number(a.createdAt || 0) - Number(b.createdAt || 0)
      if (sortBy === 'title') return effectiveTitleOf(a, dsmAuthoritativeTitles).localeCompare(effectiveTitleOf(b, dsmAuthoritativeTitles), 'zh-CN')
      // v0.1：优先级排序（未设置按 3 归一；同优先级新者在前，见 logic.ascPriority）。
      if (sortBy === 'priority') return ascPriority(a, b)
      return Number(b.createdAt || 0) - Number(a.createdAt || 0)
    })
  }, [visibleSessions, archivedAll, activeAll, starredAll, reviewAll, emptyAll, filter, query, workspaceFilter, sortBy, tagFilter, tagsReady, dsmAuthoritativeTitles])
  const selIds = Object.keys(selected).filter((k) => selected[k])
  // 「回收站」是独立视图，不共用会话列表。
  const showSessionList = filter !== 'trash'

  // 血缘分组：把 origin === 'subagent' 的会话挂到父会话卡片下（可嵌套到孙
  // 代）。父会话不在当前列表里（被筛选掉 / 已删除 / 跨组）时子会话保持顶层，
  // 保证「搜得到就一定看得见」，不会因为折叠而消失。
  // 3.7.0 分支聚拢：先子代理折叠、后分支聚拢（foldBranches 的输入契约——顺序反了
  // 会让分支父行的子代理变孤儿弹回顶层）。链式分支拍平进同一组；缺失父出
  // 「来源：<短ID>」合成头；「一行不丢」由纯函数守恒不变量保证。
  const { topList, kidsOf, foldedCount, branchGroupsOf, branchFolded, branchGroupCount, orphanSubagents } = useMemo(() => {
    if (!groupByLineage) return { topList: list, kidsOf: new Map(), foldedCount: 0, branchGroupsOf: new Map(), branchFolded: 0, branchGroupCount: 0, orphanSubagents: [] }
    const kids = foldSubagents(list, lineage)
    const br = foldBranches(kids.topList, lineage)
    // issue #18 第 1 条：分支聚拢不会动子代理（branchParentOf 明确挡掉），所以
    // 走到这里还留在顶层的子代理 = 父会话不在当前列表（已删除 / 已归档 / 被筛选）。
    // 它们先前就地平铺成「(无标题)」行；现在收进一张「未归属子代理」卡片，
    // 既不污染列表，也不会丢（展开仍可打开 / 归档 / 删除）。
    const { rows, orphans } = foldOrphanSubagents(br.topList, lineage)
    return { topList: rows, kidsOf: kids.kidsOf, foldedCount: kids.foldedCount, branchGroupsOf: br.branchGroupsOf, branchFolded: br.foldedCount, branchGroupCount: br.groupCount, orphanSubagents: orphans }
  }, [list, lineage, groupByLineage])
  // D5：query 命中折叠组内成员（或子代理）→ 渲染层强制展开——「看得见才搜得到」。
  const matchIds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return null
    return new Set((sessions || [])
      .filter((item) => [effectiveTitleOf(item, dsmAuthoritativeTitles), item.sessionId, item.workspaceTitle, item.workspacePath]
        .some((v) => String(v || '').toLocaleLowerCase().includes(needle)))
      .map((i) => String(i.sessionId)))
  }, [sessions, query])
  const kidsHit = (parentId) => !!(matchIds && (kidsOf.get(String(parentId)) || []).some((k) => matchIds.has(String(k.sessionId))))
  const branchHit = (rootId) => !!(matchIds && (branchGroupsOf.get(String(rootId)) || []).some((m) => matchIds.has(String(m.sessionId))))
  // 搜索命中未归属子代理 → 强制展开那张卡片（「看得见才搜得到」同样适用）。
  const orphanHit = !!(matchIds && orphanSubagents.some((k) => matchIds.has(String(k.sessionId))))
  const orphanOpen = openOrphans || orphanHit
  const syntheticCount = groupByLineage ? topList.reduce((n, it) => n + (it && it.syntheticRoot ? 1 : 0), 0) : 0

  // 子代理折叠分两个部件，各自贴在它该在的位置：
  //   kidsBadge   —— 标题行内，紧跟会话标题，是「这个会话有 N 个子代理」的身份
  //                  标记（贴在卡片底部会显得像多出的一块，没有归属）；
  //   renderKids  —— 展开时的子列表，用竖线挂在父卡片内容左边缘下方。
  const kidsBadge = (sessionId) => {
    if (!groupByLineage) return null
    const kids = kidsOf.get(String(sessionId)) || []
    if (!kids.length) return null
    const open = !!openKids[sessionId] || kidsHit(sessionId)
    return (
      <button
        type="button"
        className="dsm-kids-toggle"
        aria-expanded={open}
        title={(open ? '收起' : '展开') + ' ' + kids.length + ' 个子代理会话'}
        onClick={() => setOpenKids((s) => ({ ...s, [sessionId]: !s[sessionId] }))}
      >
        {open ? '▾' : '▸'} {kids.length} 子代理
      </button>
    )
  }

  // issue #6 之二/之三：面板侧的分支与空白视觉信号（侧栏已有同源 chip/tag）。
  // 分支标记 hover 说明来源；空白标记提示去「空白」分类清理。
  // 父会话标题查找走一次性 Map（sessions 会到几百条，每卡片 find 是 O(n²)）。
  const sessionsById = useMemo(() => new Map((sessions || []).map((x) => [String(x.sessionId), x])), [sessions])
  // issue #18 第 4 条：删除确认框里的「连同 N 个子代理」。按官方血缘字段递归数
  // 一遍（只有对话框打开时才计算一次，列表渲染路径不承担这个成本）。
  const delCascadeCount = useMemo(() => {
    if (!delTarget) return 0
    const childMap = new Map()
    for (const [id, li] of Object.entries(lineage || {})) {
      if (!li || li.origin !== 'subagent' || !li.parentSession) continue
      const p = String(li.parentSession)
      if (!childMap.has(p)) childMap.set(p, [])
      childMap.get(p).push(String(id))
    }
    const seen = new Set([String(delTarget.sessionId)])
    const queue = [String(delTarget.sessionId)]
    let n = 0
    while (queue.length) {
      const cur = queue.shift()
      for (const kid of childMap.get(cur) || []) {
        if (seen.has(kid)) continue
        seen.add(kid); n++; queue.push(kid)
      }
    }
    return n
  }, [delTarget, lineage])
  const branchBadge = (sessionId) => {
    const li = lineage[String(sessionId)]
    if (!li || li.origin === 'subagent' || !li.parentSession) return null
    const parent = sessionsById.get(String(li.parentSession))
    const label = parent && parent.title ? `分支于：${parent.title}` : `分支会话（来源：${shortId(li.parentSession)}）`
    return <span className="dsm-branch-chip" title={label}>⑂ 分支</span>
  }
  const emptyBadge = (sessionId) => {
    const li = lineage[String(sessionId)]
    if (!li || !li.empty) return null
    return <span className="dsm-empty-chip" title="无内容的空白会话">空白</span>
  }

  // T4 卡片标签 chips：分支/空白 chip 之后，每卡最多 3 个 +「+N」计数。
  // 数据走本地 assignments（tags/list 失败 = 空表 = 不显示，符合降级红线）；
  // 死 id（标签被别处删）查不到名字 → 跳过，幽灵绝不上屏。+N 的 title 列全名。
  const tagChips = (sessionId) => {
    if (!tagsReady) return null
    const ids = Array.isArray(assignments[String(sessionId)]) ? assignments[String(sessionId)] : []
    const names = []
    for (const id of ids) { const n = tagMap.get(String(id)); if (n) names.push(n) }
    if (!names.length) return null
    const shown = names.slice(0, 3)
    const rest = names.slice(3)
    return (
      <>
        {shown.map((n, i) => <span key={i} className="dsm-tagchip" title={'标签：' + n}>{n}</span>)}
        {rest.length > 0 && <span className="dsm-tagchip dsm-tagchip-more" title={'另有标签：' + rest.join('、')}>+{rest.length}</span>}
      </>
    )
  }

  const renderKids = (parentId, depth) => {
    const kids = kidsOf.get(String(parentId)) || []
    if (!kids.length || !(openKids[parentId] || kidsHit(parentId))) return null
    return (
      <div className="dsm-kids">
        {kids.map((k) => (
          <div className="dsm-kid" key={k.sessionId}>
            <div className="dsm-kid-row">
              <span className="dsm-kid-name" title={k.title || k.sessionId}>{k.title || '(无标题)'}</span>
              <span className="dsm-kid-meta">{k.archived ? '已归档' : '活动'}{fmtDate(k.createdAt) ? ` · ${fmtDate(k.createdAt)}` : ''}</span>
              <span className="dsm-kid-acts">
                <button type="button" className="archv-btn" disabled={busy !== null} title="切换到这个子代理会话（设置面板挡着会话区，关掉即可看到）" onClick={async () => {
                  const name = k.title || (String(k.sessionId).slice(0, 8) + '…')
                  const res = await dsmOpenSessionById(k.sessionId, parentId)
                  const msg = openSubagentToast(res, name, 'panel')
                  showToast(msg.text, msg.kind)
                }}>打开</button>
                <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => act(k.archived ? 'restore' : 'archive', k)}>{k.archived ? '恢复' : '归档'}</button>
                <button type="button" className="archv-btn archv-del" disabled={busy !== null} title="移入回收站，可在回收站恢复" onClick={() => setDelTarget(k)}>删除</button>
              </span>
            </div>
            {(depth || 0) < 4 && renderKids(k.sessionId, (depth || 0) + 1)}
          </div>
        ))}
      </div>
    )
  }

  // 分支组头徽标 + 组列表：完整复用子代理折叠的语言（.dsm-kids-toggle / .dsm-kids
  // 竖线），成员行照抄子代理子行——打开走 dsmOpenSessionById（成员各自的直接父，
  // 官方地址契约），归档/删除同权。成员自己的 kidsBadge/分支 chip 保留在行内。
  const branchGroupBadge = (sessionId) => {
    if (!groupByLineage) return null
    const members = branchGroupsOf.get(String(sessionId)) || []
    if (!members.length) return null
    const open = !!openBranches[sessionId] || branchHit(sessionId)
    return (
      <button
        type="button"
        className="dsm-kids-toggle"
        aria-expanded={open}
        title={(open ? '收起 ' : '展开 ') + members.length + ' 个分支会话'}
        onClick={() => toggleBranch(sessionId)}
      >
        {open ? '▾' : '▸'} {members.length} 分支
      </button>
    )
  }
  const renderBranchGroup = (rootId) => {
    const members = branchGroupsOf.get(String(rootId)) || []
    if (!members.length || !(openBranches[rootId] || branchHit(rootId))) return null
    return (
      <div className="dsm-kids" aria-label="分支会话">
        {members.map((k) => (
          <div className="dsm-kid" key={k.sessionId}>
            <div className="dsm-kid-row">
              <span className="dsm-kid-name" title={k.title || k.sessionId}>{k.title || '(无标题)'}</span>
              {branchBadge(k.sessionId)}
              {emptyBadge(k.sessionId)}
              {kidsBadge(k.sessionId)}
              <span className="dsm-kid-meta">{k.archived ? '已归档' : '活动'}{fmtDate(k.createdAt) ? ` · ${fmtDate(k.createdAt)}` : ''}</span>
              <span className="dsm-kid-acts">
                <button type="button" className="archv-btn" disabled={busy !== null} title="切换到这个分支会话（设置面板挡着会话区，关掉即可看到）" onClick={async () => {
                  const name = k.title || (String(k.sessionId).slice(0, 8) + '…')
                  const li = lineage[String(k.sessionId)]
                  const res = await dsmOpenSessionById(k.sessionId, (li && li.parentSession) || rootId)
                  const msg = openSubagentToast(res, name, 'panel')
                  showToast(msg.text, msg.kind)
                }}>打开</button>
                <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => act(k.archived ? 'restore' : 'archive', k)}>{k.archived ? '恢复' : '归档'}</button>
                <button type="button" className="archv-btn archv-del" disabled={busy !== null} title="移入回收站，可在回收站恢复" onClick={() => setDelTarget(k)}>删除</button>
              </span>
            </div>
            {renderKids(k.sessionId, 1)}
          </div>
        ))}
      </div>
    )
  }

  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }))
  const clearSel = () => setSelected({})
  // issue #18 第 3 条：全选只选「当前列表里真正占据一行、且能单独勾选」的会话。
  // 旧实现遍历的是过滤后的原始 list（含被折叠的子代理、被聚拢的分支成员、
  // 合成头），于是全选会在界面上看不出任何变化的情况下选中一批不可见会话——
  // 用户只能靠「取消全选」撤销，批量归档/删除会打到自己没看见的东西。
  const selectAll = () => {
    const o = {}
    topList.forEach((x) => { if (x && x.sessionId != null && !x.syntheticRoot) o[x.sessionId] = true })
    setSelected(o)
  }

  const act = (action, it) => {
    if (busy) return
    setBusy(it.sessionId)
    postJSON('/archived-sessions/' + action, { sessionId: it.sessionId })
      .then(() => {
        setBusy(null)
        const n = it.title || it.sessionId
        showToast(action === 'archive' ? `已归档「${n}」` : `已恢复「${n}」`)
        // 单条归档/恢复只是成员标记翻转：本地更新即可，不走整表 refresh
        //（refresh 会清空多选状态；host 侧缓存已把列表成本压到 stat 级别）。
        setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId ? { ...x, archived: action === 'archive' } : x)))
      })
      .catch((e) => { setBusy(null); setError(String((e && e.message) || e)) })
  }

  const doDeleteConfirmed = () => {
    if (!delTarget || busy) return
    setBusy(delTarget.sessionId)
    postJSON('/archived-sessions/delete', { sessionId: delTarget.sessionId, cascadeSubagents: cascadeSub })
      .then((r) => {
        setBusy(null)
        const n = delTarget.title || delTarget.sessionId
        const cascaded = Number((r && r.cascaded) || 0)
        showToast(`已删除 ${n}${cascaded ? `（连同 ${cascaded} 个子代理会话）` : ''}（已移入回收站）`)
        const gone = new Set([String(delTarget.sessionId), ...((r && r.cascadedIds) || []).map(String)])
        setDelTarget(null)
        // 删除进入回收站：本地移除这些行（含被连带回收的子代理）+ 单刷回收站，
        // 不整表 refresh——refresh 会清空多选状态。
        setSessions((s) => s && s.filter((x) => !gone.has(String(x.sessionId))))
        loadTrash()
        dsmLoadTrashIds()
      })
      .catch((e) => { setBusy(null); setDelTarget(null); setError(String((e && e.message) || e)) })
  }

  const loadTrash = () => {
    postJSON('/archived-sessions/trash/list', {})
      .then((r) => { setTrash(r.items || []); setTrashSettings(r.settings || { retentionDays: 0 }) })
      .catch(() => {})
  }

  const updateRetention = (days) => {
    setTrashBusy('__settings')
    postJSON('/archived-sessions/trash/settings', { retentionDays: Number(days) })
      .then((r) => { setTrashBusy(null); setTrashSettings(r.settings); showToast('已更新自动清理策略') })
      .catch((e) => { setTrashBusy(null); setError(String((e && e.message) || e)) })
  }

  const verifyTrash = () => {
    setTrashBusy('__verify')
    postJSON('/archived-sessions/trash/verify', {})
      .then((r) => {
        setTrashBusy(null); setTrashCheck(r)
        if (r.missing) showToast(`发现 ${r.missing} 条日志缺失`)
        else if (r.unverified) showToast(`${r.unverified} 条日志位置由当前 Runtime 管理，无法直接核验`)
        else showToast('回收站校验通过')
      })
      .catch((e) => { setTrashBusy(null); setError(String((e && e.message) || e)) })
  }

  // 存储占用分析：只读聚合（按工作区排行 + 最大的会话）。按需调用，不在面板加载时预取。
  const loadStorage = () => {
    setStorageBusy(true)
    setStorageError(null)
    postJSON('/archived-sessions/storage', { topN: 10 })
      .then((r) => { setStorageBusy(false); setStorage(r); storageDirty.current = false })
      // 错误留在面板内自行重试，不冒泡成整个设置面板的错误条。
      .catch((e) => { setStorageBusy(false); setStorageError(String((e && e.message) || e)) })
  }

  // 自动归档设置。一次纯读取会顺带让 host 跑一遍每日检查（host 侧按天节流）。
  const applyAa = (r) => setAa({ settings: r.settings || { inactiveDays: 0, skipStarred: true }, lastRunAt: r.lastRunAt ?? null, lastArchivedCount: r.lastArchivedCount || 0 })

  const loadAutoArchive = () => {
    postJSON('/archived-sessions/auto-archive/settings', {})
      .then(applyAa)
      .catch(() => {})
  }

  const updateAutoArchive = (patch) => {
    if (aaBusy) return
    setAaBusy(true)
    postJSON('/archived-sessions/auto-archive/settings', patch)
      .then((r) => { setAaBusy(false); applyAa(r); showToast('已更新自动归档策略') })
      .catch((e) => { setAaBusy(false); setError(String((e && e.message) || e)) })
  }

  const runAutoArchive = () => {
    if (aaBusy) return
    setAaBusy(true)
    postJSON('/archived-sessions/auto-archive/run', {})
      .then((r) => {
        setAaBusy(false)
        applyAa(r)
        const n = r.archived || 0
        if (r.skipped === 'disabled') showToast('自动归档未启用')
        else { showToast(`已自动归档 ${n} 个会话`); if (n > 0) refresh() }
      })
      .catch((e) => { setAaBusy(false); setError(String((e && e.message) || e)) })
  }

  // 工作区归档（v3.12.0，语义 A = 只做可见性）。记录落在 host 的
  // workspace-archives.v1.json；这里只负责读回、发起归档/恢复、并把结果
  // 同步给侧栏用的 dsmArchivedWsKeys。
  const applyWsArch = (r) => {
    const items = Array.isArray(r && r.items) ? r.items : []
    const keys = Array.isArray(r && r.keys) ? r.keys.map((k) => String(k)) : items.map((x) => String((x && x.key) || ''))
    setWsArch({ items, keys: keys.filter(Boolean) })
    dsmArchivedWsKeys = new Set(keys.filter(Boolean))
    if (dsmRepaintDots) dsmRepaintDots()
  }

  const loadWsArch = () => {
    postJSON('/archived-sessions/workspace-archives', {})
      .then(applyWsArch)
      .catch(() => {})
  }

  // 归档/恢复都走同一条命令通道，返回体形状一致（items 倒序 + keys）。
  const runWsArch = (action, path, doneMsg) => {
    if (wsArchBusy) return
    setWsArchBusy(true)
    postJSON('/archived-sessions/workspace-archives', action === 'archive' ? { action, path } : { action })
      .then((r) => {
        setWsArchBusy(false)
        applyWsArch(r)
        showToast(r && r.changed ? doneMsg : '没有变化')
        refresh()
      })
      .catch((e) => { setWsArchBusy(false); setError(String((e && e.message) || e)) })
  }

  // ---- v3.15.0 模型路由。三个入口共用同一个 apply 通道：
  // 所有校验在 host 侧 router-core.js（两个插件 normalizer 的镜像），
  // 这里只负责把「用户点了一个按钮」翻译成 { target, op }。
  const applyRouter = (target, op, doneMsg) => {
    if (routerBusy) return
    setRouterBusy(true)
    setRouterErr('')
    postJSON('/archived-sessions/router/apply', { target, op })
      .then((r) => {
        setRouterBusy(false)
        if (r && r.snapshot) setRouterSnap(r.snapshot)
        setRouterNote(r && r.changed ? doneMsg : '没有变化')
      })
      .catch((e) => { setRouterBusy(false); setRouterErr(String((e && e.message) || e)) })
  }

  // 链文本框 ⇄ 数组：一行一个 `provider/model[@effort]`，解析全交给 host。
  const splitChain = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  const openRouterEdit = (route) => {
    setRouterEdit(route.id)
    setRouterDraft({
      id: route.id,
      name: route.name || '',
      chain: route.chain.map((c) => (c.reasoningEffort ? `${c.provider}/${c.model}@${c.reasoningEffort}` : `${c.provider}/${c.model}`)).join('\n'),
    })
  }

  const restoreTrash = (sid) => {
    if (trashBusy) return
    setTrashBusy(sid)
    postJSON('/archived-sessions/trash/restore', { sessionId: sid })
      .then((r) => {
        setTrashBusy(null)
        // 子代理随父会话一起回来时如实说明，避免用户以为只恢复了一条。
        const cascaded = Number((r && r.cascaded) || 0)
        const base = r && r.workspaceGone ? '已恢复会话（原工作区已删除，会话暂归「未分组」）' : '已恢复会话'
        showToast(base + (cascaded ? `，连同 ${cascaded} 个子代理会话` : ''))
        loadTrash()
        refresh()
      })
      .catch((e) => { setTrashBusy(null); setError(String((e && e.message) || e)) })
  }
  const purgeTrash = (sid) => {
    if (trashBusy) return
    setTrashBusy(sid)
    postJSON('/archived-sessions/trash/purge', { sessionId: sid })
      .then(() => { setTrashBusy(null); showToast('已彻底删除'); dsmMarkPurged([sid]); dsmLoadTrashIds(); loadTrash() })
      .catch((e) => { setTrashBusy(null); setError(String((e && e.message) || e)) })
  }
  const purgeAllTrash = () => {
    if (trashBusy || !trash.length) return
    setTrashBusy('__all')
    const all = trash.map((t) => t.sessionId)
    postJSON('/archived-sessions/trash/purge-many', { sessionIds: all })
      .then((result) => {
        setTrashBusy(null)
        const rows = result.results || []
        const succeeded = rows.filter((item) => item.ok).map((item) => item.sessionId)
        const failed = rows.filter((item) => !item.ok)
        if (succeeded.length) dsmMarkPurged(succeeded)
        dsmLoadTrashIds()
        loadTrash()
        if (failed.length) {
          const first = failed[0]
          setError(`清理完成 ${succeeded.length} 条，失败 ${failed.length} 条：${first.error || first.sessionId}`)
        } else showToast('已清空回收站')
      })
      .catch((e) => { setTrashBusy(null); setError(String((e && e.message) || e)) })
  }

  const doMove = (it) => {
    if (!canMove.available) { setError(canMove.reason || '当前环境不支持跨工作区移动'); return }
    const targetPath = moveMode === 'new' ? newPath.trim() : wsPath(targetWs)
    if (!targetPath) { setError('请选择已有工作区或输入新的目标目录路径'); return }
    setBusy(it.sessionId)
    setError(null)
    postActiveAware('/archived-sessions/move', { sessionId: it.sessionId, targetPath })
      .then((r) => {
        setBusy(null)
        setOpenMove(null)
        setMoveMode('existing')
        setNewPath('')
        // 会话被 DSH 占用（活跃会话 / 未关闭的会话）：服务端已登记排队，等它
        // 释放（session/disposed）或下次启动时自动完成。不要谎报"已移动"。
        if (r && r.queued) {
          showToast(r.notes && r.notes.length ? r.notes.join(' ') : '会话正被 DSH 打开，已排队待移动。', 'err')
          setRetry(null)
          refresh()
          return
        }
        showToast(`已把「${it.title || it.sessionId}」移到 ${r.workspaceTitle || targetPath}`)
        // 非致命提示（如源目录仍有旧代日志未自动清理）：错误样式 + 停留更久，
        // 让用户来得及读完再去决定怎么处理。
        if (Array.isArray(r.notes) && r.notes.length > 0) showToast(r.notes.join(' '), 'err')
        // 移动只改 workspacePath/workspaceTitle：本地替换该行，不整表 refresh。
        setSessions((s) => s && s.map((x) => (x.sessionId === it.sessionId
          ? { ...x, workspacePath: r.workspacePath || targetPath, workspaceTitle: r.workspaceTitle || targetPath }
          : x)))
        setRetry(null)
      })
      .catch((e) => {
        setBusy(null)
        setError(String((e && e.message) || e))
        // 会话被 DSH 占用写权限：切走会话后原地重试即可，不必重新选目标。
        setRetry(e && e.code === BUSY_CODE ? { run: () => doMove(it) } : null)
      })
  }

  const doBatch = (action) => {
    if (!selIds.length || busy) return
    if (action === 'delete-many') {
      if (!confirmBatch) { setConfirmBatch(true); return }
      setConfirmBatch(false)
    }
    setBusy('__batch__')
    postJSON('/archived-sessions/' + action, { sessionIds: selIds })
      .then((r) => {
        setBusy(null)
        const n = (r && (r.archived || r.restored || r.deleted)) || selIds.length
        // 批量删默认也级联子代理：如实说明连带回收了多少，避免「数量对不上」。
        const cascaded = Number((r && r.cascaded) || 0)
        showToast(`已处理 ${n} 个会话${cascaded ? `（连同 ${cascaded} 个子代理会话）` : ''}`)
        refresh()
      })
      .catch((e) => { setBusy(null); setConfirmBatch(false); setError(String((e && e.message) || e)) })
  }

  // issue #7：批量移动到同一个目标工作区。失败逐条回报，不中断其余会话。
  // 传入 ids 时只搬这些（用于「重试失败的会话」），否则搬当前选中。
  const doBatchMove = (retryIds) => {
    const ids = (Array.isArray(retryIds) && retryIds.length) ? retryIds : selIds
    if (!ids.length || busy) return
    if (!canMove.available) { setError(canMove.reason || '当前环境不支持跨工作区移动'); return }
    const targetPath = moveMode === 'new' ? newPath.trim() : wsPath(targetWs)
    if (!targetPath) { setError('请选择已有工作区或输入新的目标目录路径'); return }
    setBusy('__batch__')
    setError(null)
    setRetry(null)
    postActiveAware('/archived-sessions/move-many', { sessionIds: ids, targetPath })
      .then((r) => {
        setBusy(null)
        setBatchMoveOpen(false)
        setMoveMode('existing')
        setNewPath('')
        const moved = (r && r.moved) || 0
        const failed = (r && Array.isArray(r.failed)) ? r.failed : []
        const queued = (r && Array.isArray(r.queued)) ? r.queued : []
        if (queued.length) {
          // 活跃/被占用的会话：服务端已排队，下次重启 DSH 时自动完成。
          showToast(`${queued.length} 个会话已排队（正被 DSH 打开），重启 DSH 后自动完成；请先别打开它们。`, 'err')
        }
        if (failed.length) {
          // 短 ID 列表 + 首个失败原因：长 UUID 全列出来不可读，原因只给第一条
          // （通常同批失败同因），完整原因仍可在控制台网络面板查到。
          const firstReason = failed[0] && failed[0].error ? `，首个原因：${failed[0].error.split('\n')[0]}` : ''
          setError(`已移动 ${moved} 个会话，${failed.length} 个失败（${failed.map((f) => shortId(f.sessionId)).join('、')}）${firstReason}`)
          // 被 DSH 占用写权限的那几个：切走会话后重试仍有戏，只重投这几条。
          const busyIds = failed.filter((f) => f.code === BUSY_CODE).map((f) => f.sessionId)
          setRetry(busyIds.length ? { run: () => doBatchMove(busyIds) } : null)
        } else if (moved > 0) {
          showToast(`已把 ${moved} 个会话移到 ${targetPath}`)
          setRetry(null)
        } else {
          setRetry(null)
        }
        clearSel()
        refresh()
      })
      .catch((e) => {
        setBusy(null)
        setError(String((e && e.message) || e))
        setRetry(e && e.code === BUSY_CODE ? { run: () => doBatchMove(ids) } : null)
      })
  }

  const openMoveFor = (it) => {
    if (!canMove.available) { setError(canMove.reason || '当前环境不支持跨工作区移动'); return }
    if (openMove === it.sessionId) { setOpenMove(null); return }
    setOpenTags(null)
    setTargetWs(workspaces.length ? (targetWs || workspaces[0].workspaceId) : '')
    setMoveMode('existing')
    setNewPath('')
    setOpenMove(it.sessionId)
  }

  const pickDirectory = async () => {
    if (!workspacesSvc || picking) return
    setPicking(true)
    try {
      const p = await workspacesSvc.pickDirectory()
      if (p) { setNewPath(p); setMoveMode('new') }
    } catch (e) {
      setError(String((e && e.message) || e))
    } finally {
      setPicking(false)
    }
  }

  const toggleDetails = (it) => {
    if (openDetails === it.sessionId) { setOpenDetails(null); return }
    if (details[it.sessionId]) {
      // v3.6.2 #11：详情是同生命周期内永不失效的快照，重开永远显示旧数。
      // 加 30s TTL：过期即后台重取（先展示旧数据不闪空，回来再替换）。
      setOpenDetails(it.sessionId)
      const at = detailsAt.current[it.sessionId] || 0
      if (Date.now() - at > 30000) {
        postJSON('/archived-sessions/details', { sessionId: it.sessionId })
          .then((d) => { detailsAt.current[it.sessionId] = Date.now(); setDetails((m) => ({ ...m, [it.sessionId]: d })) })
          .catch(() => {})
      }
      return
    }
    setDetailsLoading(it.sessionId)
    postJSON('/archived-sessions/details', { sessionId: it.sessionId })
      .then((d) => {
        detailsAt.current[it.sessionId] = Date.now()
        setDetails((m) => ({ ...m, [it.sessionId]: d }))
        setDetailsLoading(null)
        setOpenDetails(it.sessionId)
      })
      .catch((e) => { setDetailsLoading(null); setError(String((e && e.message) || e)) })
  }

  const workspaceTag = (it) => {
    if (it.hasWorkspace && it.workspaceGone) {
      return <span className="archv-wtag archv-wgone" title={(it.workspacePath || '') + '（原工作区已删除）'}>工作区已删 · {pathName(it.workspacePath) || '?'}</span>
    }
    const wName = it.workspaceTitle || pathName(it.workspacePath)
    if (wName) return <span className="archv-wtag" title={it.workspacePath || ''}>{wName}</span>
    return <span className="archv-wtag">未分组</span>
  }

  const openTagsFor = (it) => {
    if (!tagsReady) { showToast(tagsState === 'failed' ? '标签数据未能加载，暂时无法编辑标签；重新打开设置面板可重试' : '标签数据还在加载中，稍候再试', 'err'); return }
    if (openTags === it.sessionId) { setOpenTags(null); return }
    setOpenMove(null)
    setCardTagName('')
    setOpenTags(it.sessionId)
  }

  const runMenu = (id, it) => {
    setOpenMenu(null)
    if (id === 'restore') act('restore', it)
    else if (id === 'archive') act('archive', it)
    else if (id === 'delete') setDelTarget(it)
    else if (id === 'move') openMoveFor(it)
    else if (id === 'tags') openTagsFor(it)
    else if (id === 'details') toggleDetails(it)
  }

  const rowMenu = (it) => {
    const items = it.archived
      ? [
          ['restore', '恢复'],
          ['move', openMove === it.sessionId ? '收起移动' : '移动'],
          ['tags', '标签'],
          ['details', openDetails === it.sessionId ? '收起详情' : '详情'],
          ['delete', '删除'],
        ]
      : [['archive', '归档'], ['move', '移动'], ['tags', openTags === it.sessionId ? '收起标签' : '标签'], ['details', '详情'], ['delete', '删除']]
    return (
      <div ref={openMenu === it.sessionId ? menuRef : null} className="more-wrap">
        <button
          type="button"
          className="more-btn"
          aria-label="更多操作"
          aria-haspopup="true"
          aria-expanded={openMenu === it.sessionId}
          onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === it.sessionId ? null : it.sessionId) }}
        >⋯</button>
        {openMenu === it.sessionId && (
          <div className="more-menu" role="menu">
            {items.map(([id, label]) => {
              const blocked = (id === 'move' && !canMove.available) || (id === 'tags' && !tagsReady)
              const blockedTitle = id === 'move' ? canMove.reason : id === 'tags' ? tagsBlockedTitle : undefined
              return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className={'more-item' + (id === 'delete' ? ' more-item-danger' : '')}
                disabled={blocked}
                title={blocked ? blockedTitle : undefined}
                onClick={() => runMenu(id, it)}
              >{label}</button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="archv" role="region" aria-label="会话管理">
      <style>{CSS}</style>
      <div className="archv-head">
        <h2 className="archv-title">会话管理</h2>
        {capabilities && capabilities.buildStamp
          ? <span
              className="archv-stamp"
              role="button"
              aria-label="复制完整版本号"
              title={capabilities.buildStamp}
              onClick={copyBuildStamp}
            >v{String(capabilities.buildStamp).split('+')[0]}</span>
          : null}
        {sessions !== null && <span className="archv-count" title={groupByLineage ? '子代理会话折叠在父会话下，不计入此数' : undefined} aria-label={`${totalTopCount} 个会话`}>{totalTopCount}</span>}
      </div>
      {error && (
        <div className="archv-err" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="archv-errretry"
            title={retry ? '把刚才失败的操作原样再做一次（例如先切走被占用的会话后重试）' : '重新加载会话列表'}
            onClick={() => {
              const run = retry && retry.run
              setRetry(null)
              if (run) run(); else refresh()
            }}
          >重试</button>
        </div>
      )}
      {sessions === null ? (
        <div className="archv-skel" aria-label="加载中">
          {[0, 1, 2].map((i) => <div key={i} className="archv-skel-card" />)}
        </div>
      ) : (
        <>
          {/* v3.18.0：顶部是**一条统一导航**（全部 / 活动 / 已归档 / 设置 / 回收站）。
              原先筛选行与「⚙ 设置」是两个互不相干的容器，设置按钮还被拉满整行；
              现在同一条圆角容器里并排，选中项只有胶囊底色 + 底部色条（无图标）。
              已收藏 / 待回看 / 空白 从这条移进「设置 → 会话筛选」，不在顶栏占位。 */}
          {(() => {
            // v3.18.0：5 格导航的数据源。设置排第 4、回收站第 5（用户指定顺序）。
            const navTabs = [
              { id: 'all', label: '全部', count: totalTopCount },
              { id: 'active', label: '活动', count: activeList.length },
              { id: 'archived', label: '已归档', count: archivedList.length },
              { id: '__settings', label: '设置', count: null },
              { id: 'trash', label: '回收站', count: trash.length },
            ]
            const isOn = (id) => (id === '__settings' ? settingsOpen : !settingsOpen && filter === id)
            return (
              <div className="dsm-navwrap">
                <div className="dsm-nav" role="tablist" aria-label="会话与设置">
                  <DsmNavGlider active={settingsOpen ? '__settings' : filter} />
                  {navTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isOn(tab.id)}
                      data-dsm-nav={tab.id}
                      className={'dsm-navtab' + (isOn(tab.id) ? ' dsm-navtab-on' : '')}
                      onClick={() => {
                        if (tab.id === '__settings') { setSettingsOpen(!settingsOpen); return }
                        if (settingsOpen) setSettingsOpen(false)
                        setFilter(tab.id); clearSel(); setConfirmBatch(false)
                      }}
                    >
                      <span className="dsm-navtab-label">{tab.label}</span>
                      {tab.count == null ? null : <span className="dsm-navtab-num">{tab.count}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )
          })()}


          {/* v3.17.0：设置是**独立整页**，不是就地展开的抽屉。点「⚙ 设置」后会话列表
              整块让位，顶部换成一条分组导航（外观 / 归档 / 存储与标签 / 宿主集成），
              每组只渲染自己那一页。再点「← 返回会话」回到列表。原维护栏那 9 个按钮
              分布在这四页里，一页只显示属于它的工具，所以不存在「一屏九个按钮」。 */}
          {settingsOpen && (
            <section className="dsm-settings-page" aria-label="插件设置">
              <div className="dsm-settings-nav" role="tablist" aria-label="设置导航">
                <DsmNavGlider active={settingsTab} rootSel=".dsm-settings-nav" attr="data-dsm-tab" cls="dsm-navglider" />
                {DSM_SETTINGS_GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === g.id}
                    className={'dsm-settings-tab' + (settingsTab === g.id ? ' dsm-settings-tab-on' : '')}
                    data-dsm-tab={g.id}
                    onClick={() => setSettingsTab(g.id)}
                  >
                    <span>{g.label}</span>
                  </button>
                ))}
              </div>
              {/* v3.17.0：分组内的具体工具按钮。都是原先维护栏上那几个，只是按组归类
                   并只在对应分组展开 —— 顶部因此回到「一个设置按钮」的清爽状态。 */}
              <div className="maint-bar dsm-settings-tools">
              {settingsTab === 'appearance' && (
                <div className="maint-group">
                  <button type="button" className="archv-btn" aria-expanded={qaStyleOpen} title="快捷面板的主题预设与圆角/模糊/不透明度/宽度" onClick={() => setQaStyleOpen(!qaStyleOpen)}>
                    面板外观
                  </button>
                </div>
              )}
              {settingsTab === 'filters' && (
                <div className="maint-group dsm-filter-links">
                  {/* v3.18.0：这三个视图从顶部导航移到这里（用户要求「其他的移动到设置下」）。
                      点一下＝关设置页 + 切到那个筛选，行为与原先在顶栏时一致。 */}
                  {[
                    { id: 'starred', label: '已收藏', count: starredList.length },
                    { id: 'review', label: '待回看', count: reviewList.length },
                    { id: 'empty', label: '空白', count: emptyList.length },
                  ].map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className="archv-btn"
                      onClick={() => { setSettingsOpen(false); setFilter(f.id); clearSel(); setConfirmBatch(false) }}
                    >{f.label} ({f.count})</button>
                  ))}
                </div>
              )}
              {settingsTab === 'archive' && (
                <div className="maint-group">
                  <button type="button" className={'archv-btn' + (aa.settings.inactiveDays ? ' archv-go' : '')} aria-expanded={aaOpen} onClick={() => setAaOpen(!aaOpen)}>
                    自动归档{aa.settings.inactiveDays ? `：${aa.settings.inactiveDays} 天未活跃` : '：未启用'}
                  </button>
                  {aa.lastRunAt ? <span className="maint-note">上次检查 {fmtDate(aa.lastRunAt)}，归档 {aa.lastArchivedCount} 个</span> : <span className="maint-note">尚未检查</span>}
                  <button
                    type="button"
                    className={'archv-btn' + (wsArch.keys.length ? ' archv-go' : '')}
                    aria-expanded={wsArchOpen}
                    title="把整个工作区从侧栏与列表里折叠起来（只做可见性，会话归档状态不变）"
                    onClick={() => {
                      const next = !wsArchOpen
                      setWsArchOpen(next)
                      if (next) loadWsArch()
                    }}
                  >
                    工作区归档{wsArch.keys.length ? `：${wsArch.keys.length} 个` : '：无'}
                  </button>
                </div>
              )}
              {settingsTab === 'storage' && (
                <div className="maint-group">
                  <button type="button" className="archv-btn" aria-expanded={storageOpen} onClick={() => { const next = !storageOpen; setStorageOpen(next); if (next && (!storage || storageDirty.current) && !storageBusy) loadStorage() }}>
                    存储占用{storage ? ` · ${fmtBytes(storage.totalBytes) || '0 B'}` : ''}
                  </button>
                  <button
                    type="button"
                    className="archv-btn"
                    aria-expanded={openTagMgr}
                    disabled={!tagsReady && !openTagMgr}
                    title={tagsReady ? '新建 / 重命名 / 合并 / 删除标签' : tagsBlockedTitle}
                    onClick={() => { setOpenTagMgr(!openTagMgr); setRenamingTagId(null) }}
                  >标签管理{tagsReady && tagDefs.length ? ` (${tagDefs.length})` : ''}</button>
                </div>
              )}
              {settingsTab === 'host' && (
                <div className="maint-group">
                  <button type="button" className="archv-btn" aria-expanded={mcpOpen} title="启用 / 停用本机 profile 里的 MCP 服务器（重启 DSH 后生效）" onClick={() => {
                    const next = !mcpOpen
                    setMcpOpen(next)
                    if (!next) return
                    setMcpBusy(true); setMcpErr(''); setMcpNote('')
                    getJSON('/archived-sessions/mcp/rows')
                      .then((d) => setMcpRows(Array.isArray(d.rows) ? d.rows : []))
                      .catch((e) => setMcpErr(String((e && e.message) || e)))
                      .finally(() => setMcpBusy(false))
                  }}>MCP 服务器</button>
                  <button type="button" className="archv-btn" aria-expanded={skillOpen} title="启用 / 部分停用 / 停用本机扫描到的 skill，也可导出 zip、导入、删除" onClick={() => {
                    const next = !skillOpen
                    setSkillOpen(next)
                    if (!next) return
                    setSkillBusy(true); setSkillErr(''); setSkillNote('')
                    getJSON('/archived-sessions/skills/list')
                      .then((d) => {
                        setSkillData(d)
                        const writable = (d.roots || []).filter((r) => r.scope !== 'bundled')
                        setSkillImportRoot((prev) => prev || (writable[0] && writable[0].path) || '')
                      })
                      .catch((e) => setSkillErr(String((e && e.message) || e)))
                      .finally(() => setSkillBusy(false))
                  }}>Skill 列表{skillData && Array.isArray(skillData.skills) ? ` (${skillData.skills.length})` : ''}</button>
                  <button type="button" className="archv-btn" aria-expanded={routerOpen} title="编辑 llm-router 的候选链与 subagent-router 的子代理候选（改完 5 秒内自生效，不用重启）" onClick={() => {
                    const next = !routerOpen
                    setRouterOpen(next)
                    if (!next) return
                    setRouterBusy(true); setRouterErr(''); setRouterNote(''); setRouterEdit('')
                    setRouterNew({ open: false, id: '', name: '', chain: '' })
                    postJSON('/archived-sessions/router/snapshot', {})
                      .then((d) => setRouterSnap(d))
                      .catch((e) => setRouterErr(String((e && e.message) || e)))
                      .finally(() => setRouterBusy(false))
                  }}>模型路由{routerSnap && Array.isArray(routerSnap.llm && routerSnap.llm.routes) ? ` (${routerSnap.llm.routes.length})` : ''}</button>
                </div>
              )}
            </div>

          {/* v0.2.2 快捷面板外观 sheet：预设下拉 + 四个滑杆，改动即时生效并
              持久化（localStorage['dsm-qa-style-v1']）；「恢复默认」清空细参数
              回到当前预设的出厂值。v0.2.4 问题3修复：IIFE 每次渲染只读一次
              localStorage，writeQaStyle 后 React 不知道要重渲染 → select 显示
              卡在旧值（外观其实已变）。改为受控组件：qaStyleTick state 随每
              次 write 递增，强制重读最新偏好。 */}
          {settingsOpen && settingsTab === 'appearance' && qaStyleOpen && (() => {
            void qaStyleTick // 依赖标记：tick 变化时本 IIFE 重渲染重读 localStorage
            const qaPrefs = readQaStyle()
            const setPref = (patch) => { writeQaStyle(patch); setQaStyleTick((n) => n + 1) }
            // v3.13.0：跟随态下显示/滑杆读数要取胶囊算出来的值，否则「跟随 +
            // 圆角滑杆」会显示成 dark-glass 的 14px，与实际生效值不符。
            const following = qaPrefs.preset === FOLLOW_PRESET
            const capsuleSnap = following ? readCapsuleSnapshot() : null
            const capsuleInfo = following ? capsuleFollowInfo(capsuleSnap) : null
            const presetVars = following
              ? { label: '跟随歌词胶囊', vars: qaVarsFromCapsule(capsuleSnap, { radius: qaPrefs.radius, blur: qaPrefs.blur, opacity: qaPrefs.opacity, width: qaPrefs.width }) }
              : (QA_STYLE_PRESETS[qaPrefs.preset] || QA_STYLE_PRESETS['dark-glass'])
            const presetNum = (name, fallback) => {
              const m = /(-?[\d.]+)(px)?$/.exec(String(presetVars.vars[name] || ''))
              return m ? Number(m[1]) : fallback
            }
            const presetAlpha = () => {
              const m = /([\d.]+)\)$/.exec(String(presetVars.vars['--dsmqa-bg'] || ''))
              return m ? Number(m[1]) : 0.86
            }
            const curRadius = qaPrefs.radius != null ? qaPrefs.radius : presetNum('--dsmqa-radius', 14)
            const curBlur = qaPrefs.blur != null ? qaPrefs.blur : presetNum('--dsmqa-blur', 14)
            const curOpacity = qaPrefs.opacity != null ? qaPrefs.opacity : presetAlpha()
            const curWidth = qaPrefs.width != null ? qaPrefs.width : presetNum('--dsmqa-width', 760)
            // v3.13.1：跟随态默认铺满整块区域，宽度滑杆此时不代表生效值（生效的是
            // `--dsmqa-width: none`）——直接写数字会让用户以为拖到 760 是当前值。
            const widthFull = following && qaPrefs.width == null
            return (
              <div className="mv-sheet" aria-label="面板外观">
                <div className="mv-sheet-head">
                  <h3 className="mv-sheet-title">快捷面板外观</h3>
                  <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setQaStyleOpen(false)}>×</button>
                </div>
                <div className="mv-field">
                  <label className="mv-field-label" htmlFor="dsm-qa-preset">主题预设</label>
                  <select id="dsm-qa-preset" value={qaPrefs.preset} onChange={(e) => setPref({ preset: e.target.value })}>
                    <option value={FOLLOW_PRESET}>跟随歌词胶囊（netease-lyrics）</option>
                    {Object.entries(QA_STYLE_PRESETS).map(([key, p]) => (
                      <option key={key} value={key}>{p.label}</option>
                    ))}
                  </select>
                </div>
                {following ? (
                  <div className="dtl-note">{capsuleSnap
                    ? `当前胶囊：${capsuleInfo.label}${capsuleInfo.ready ? '' : '（本插件暂按 ' + capsuleInfo.fallback + ' 近似，正式移植待后续）'}`
                    : '没读到歌词插件的胶囊设置：要么没装 netease-lyrics，要么它还没写过偏好。此时按 shadcn 暗色玻璃（默认胶囊）走。'}</div>
                ) : null}
                <div className="mv-field">
                  <label className="mv-field-label" htmlFor="dsm-qa-radius">圆角（{curRadius}px）</label>
                  <input id="dsm-qa-radius" type="range" min={0} max={24} step={1} value={curRadius} onChange={(e) => setPref({ radius: Number(e.target.value) })} />
                </div>
                <div className="mv-field">
                  <label className="mv-field-label" htmlFor="dsm-qa-blur">背景模糊（{curBlur}px）</label>
                  <input id="dsm-qa-blur" type="range" min={0} max={28} step={1} value={curBlur} onChange={(e) => setPref({ blur: Number(e.target.value) })} />
                </div>
                <div className="mv-field">
                  <label className="mv-field-label" htmlFor="dsm-qa-opacity">不透明度（{Math.round(curOpacity * 100)}%）</label>
                  <input id="dsm-qa-opacity" type="range" min={0.3} max={1} step={0.02} value={curOpacity} onChange={(e) => setPref({ opacity: Number(e.target.value) })} />
                </div>
                <div className="mv-field">
                  <label className="mv-field-label" htmlFor="dsm-qa-width">面板宽度（{widthFull ? '铺满整区' : curWidth + 'px'}）</label>
                  <input id="dsm-qa-width" type="range" min={480} max={1200} step={20} value={curWidth} onChange={(e) => setPref({ width: Number(e.target.value) })} />
                  {widthFull ? null : (
                    <button type="button" className="archv-btn" style={{ marginTop: 8 }} onClick={() => setPref({ width: null })}>改回铺满整区</button>
                  )}
                </div>
                <div className="mv-foot">
                  <button type="button" className="archv-btn" onClick={() => setPref({ preset: 'dark-glass', radius: null, blur: null, opacity: null, width: null })}>恢复默认</button>
                  <span className="dtl-note">改动即时生效并保存；细参数在预设之上叠加，切换预设会保留它们（「恢复默认」全部清空）。</span>
                </div>
              </div>
            )
          })()}

          {/* v0.5.5 MCP 服务器开关 sheet：列出 profile 里的 MCP 行，一键启停。
              改动写 cordis.patch.yml（服务端先落 .bak-mcpui-* 备份），重启 DSH 生效。 */}
          {settingsOpen && settingsTab === 'host' && mcpOpen && (
            <div className="mv-sheet" aria-label="MCP 服务器">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">MCP 服务器</h3>
                <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setMcpOpen(false)}>×</button>
              </div>
              {mcpErr ? <div className="mcp-note mcp-err">{mcpErr}</div> : null}
              {!mcpRows ? (
                <div className="mcp-note">{mcpBusy ? '读取中…' : '尚未读取。'}</div>
              ) : mcpRows.length === 0 ? (
                <div className="mcp-note">这个 profile 的 cordis.patch.yml 里没有 MCP 行。</div>
              ) : (
                <div className="mcp-list">
                  {mcpRows.map((r) => (
                    <div className="mcp-row" key={r.id}>
                      <div className="mcp-meta">
                        <div className="mcp-name">{r.serverName || r.id}</div>
                        <div className="mcp-sub">{r.id} · {r.transport || 'unknown'}{r.target ? ' · ' + r.target : ''}</div>
                      </div>
                      <button
                        type="button"
                        className={'archv-btn mcp-sw' + (r.enabled ? ' mcp-sw-on' : '')}
                        aria-pressed={!!r.enabled}
                        disabled={mcpBusy}
                        onClick={async () => {
                          setMcpBusy(true)
                          setMcpErr('')
                          try {
                            const d = await postJSON('/archived-sessions/mcp/toggle', { id: r.id, enabled: !r.enabled })
                            if (d && Array.isArray(d.rows)) setMcpRows(d.rows)
                            setMcpNote(d && d.changed ? '已写入，重启 DSH 后生效。' : '状态未变化。')
                          } catch (e) {
                            setMcpErr(String((e && e.message) || e))
                          } finally {
                            setMcpBusy(false)
                          }
                        }}
                      >{r.enabled ? '已启用' : '已停用'}</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mcp-note">{mcpNote || '改动写入当前 profile 的 cordis.patch.yml（写入前自动备份为 .bak-mcpui-*），重启 DSH 后生效。'}</div>
            </div>
          )}

          {/* v3.15.0 模型路由 sheet：同一个弹层两个分区（LLM 路由 / 子代理候选）。
              数据取自 /archived-sessions/router/snapshot；每次编辑走 /router/apply
              并在响应里带回最新 snapshot，所以不用另外 refresh。
              文案要反复强调「不用重启」——这两行旁边的按钮（MCP / Skill）都需要
              重启或等下一个 step，混在一起很容易让人以为这里也要。 */}
          {settingsOpen && settingsTab === 'host' && routerOpen && (() => {
            const snap = routerSnap || {}
            const llm = snap.llm || {}
            const sub = snap.subagent || {}
            const check = snap.check || { dangling: [], unusedRoutes: [] }
            const routes = Array.isArray(llm.routes) ? llm.routes : []
            const cands = Array.isArray(sub.candidates) ? sub.candidates : []
            const rowBusy = routerBusy
            return (
              <div className="mv-sheet" aria-label="模型路由">
                <div className="mv-sheet-head">
                  <h3 className="mv-sheet-title">模型路由</h3>
                  <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setRouterOpen(false)}>×</button>
                </div>
                <div className="mv-seg" role="tablist">
                  <button type="button" role="tab" aria-selected={routerTab === 'llm'} className={'mv-segbtn' + (routerTab === 'llm' ? ' mv-segbtn-on' : '')} onClick={() => { setRouterTab('llm'); setRouterEdit('') }}>LLM 路由（{routes.length}）</button>
                  <button type="button" role="tab" aria-selected={routerTab === 'subagent'} className={'mv-segbtn' + (routerTab === 'subagent' ? ' mv-segbtn-on' : '')} onClick={() => { setRouterTab('subagent'); setRouterEdit('') }}>子代理候选（{cands.length}）</button>
                </div>
                {routerErr ? <div className="mcp-note mcp-err">{routerErr}</div> : null}
                {!routerSnap ? (
                  <div className="mcp-note">{routerBusy ? '读取中…' : '尚未读取。'}</div>
                ) : routerTab === 'llm' ? (
                  <>
                    {llm.missing ? <div className="mcp-note">没读到 {llm.file}：要么没装 llm-router，要么它还没写过配置。下面的改动会新建这个文件。</div> : null}
                    <div className="mv-field">
                      <label className="mv-field-label" htmlFor="dsm-router-enabled">总开关</label>
                      <div className="mv-row-inline">
                        <button
                          type="button"
                          id="dsm-router-enabled"
                          className={'archv-btn' + (llm.enabled !== false ? ' archv-go' : '')}
                          aria-pressed={llm.enabled !== false}
                          disabled={rowBusy}
                          onClick={() => applyRouter('llm', { action: 'set-enabled', enabled: llm.enabled === false }, llm.enabled === false ? '已启用路由' : '已停用路由')}
                        >{llm.enabled !== false ? '已启用' : '已停用'}</button>
                        <select
                          value={llm.announce || 'switch'}
                          disabled={rowBusy}
                          aria-label="换候选时的提示方式"
                          onChange={(e) => applyRouter('llm', { action: 'set-announce', mode: e.target.value }, '已改提示方式')}
                        >
                          <option value="off">不提示</option>
                          <option value="switch">换候选时提示</option>
                          <option value="always">每次都提示</option>
                        </select>
                        <select
                          value={llm.defaultStrategy || 'fallback'}
                          disabled={rowBusy}
                          aria-label="默认策略"
                          onChange={(e) => applyRouter('llm', { action: 'set-default-strategy', strategy: e.target.value }, '已改默认策略')}
                        >
                          <option value="fallback">fallback（顺序重试）</option>
                          <option value="round-robin">round-robin（轮流）</option>
                        </select>
                        <label className="mv-inline-label">粘性
                          <input
                            type="number"
                            min="1"
                            max="100"
                            value={llm.stickyLimit == null ? 1 : llm.stickyLimit}
                            disabled={rowBusy}
                            aria-label="全局粘性次数"
                            onChange={(e) => applyRouter('llm', { action: 'set-global-sticky', stickyLimit: Number(e.target.value) }, '已改全局粘性')}
                          />
                        </label>
                      </div>
                    </div>
                    {routes.length === 0 ? (
                      <div className="mcp-note">还没有任何路由组。新建一条就能在模型下拉框里看到它。</div>
                    ) : (
                      <div className="mcp-list">
                        {routes.map((route, at) => (
                          <div className="mcp-row router-row" key={route.id}>
                            <div className="mcp-meta">
                              <div className="mcp-name">{route.name || route.id}{route.name && route.name !== route.id ? <span className="router-id"> · {route.id}</span> : null}</div>
                              <div className="mcp-sub router-chain">
                                {route.chain.map((c, i) => (
                                  <span key={`${route.id}-${i}`} className="router-hop">
                                    {i > 0 ? <span className="router-arrow">→</span> : null}
                                    <span className="router-hop-t">{c.provider}/{c.model}{c.reasoningEffort ? `@${c.reasoningEffort}` : ''}</span>
                                    {route.chain.length > 1 ? (
                                      <span className="router-hop-acts">
                                        <button type="button" className="router-mini" aria-label={`把第 ${i + 1} 个候选上移`} disabled={rowBusy || i === 0} onClick={() => applyRouter('llm', { action: 'move-candidate', id: route.id, from: i + 1, to: i }, '已上移')}>↑</button>
                                        <button type="button" className="router-mini" aria-label={`把第 ${i + 1} 个候选下移`} disabled={rowBusy || i === route.chain.length - 1} onClick={() => applyRouter('llm', { action: 'move-candidate', id: route.id, from: i + 1, to: i + 2 }, '已下移')}>↓</button>
                                      </span>
                                    ) : null}
                                  </span>
                                ))}
                                <span className="router-over">{route.strategy || llm.defaultStrategy || 'fallback'} · 粘性 {route.stickyLimit}{route.announce ? ` · ${route.announce}` : ''}</span>
                              </div>
                            </div>
                            <div className="router-acts">
                              <button type="button" className="archv-btn" disabled={rowBusy} onClick={() => (routerEdit === route.id ? setRouterEdit('') : openRouterEdit(route))}>{routerEdit === route.id ? '收起' : '编辑'}</button>
                              <button type="button" className="archv-btn router-del" disabled={rowBusy} onClick={() => applyRouter('llm', { action: 'remove-route', id: route.id }, `已删除 ${route.id}`)}>删除</button>
                            </div>
                            {routerEdit === route.id ? (
                              <div className="router-edit">
                                <label className="mv-inline-label">显示名
                                  <input type="text" value={routerDraft.name} disabled={rowBusy} onChange={(e) => setRouterDraft({ ...routerDraft, name: e.target.value })} />
                                </label>
                                <label className="mv-inline-label">候选（一行一个 provider/model，可选 @effort）
                                  <textarea rows="4" value={routerDraft.chain} disabled={rowBusy} spellCheck={false} onChange={(e) => setRouterDraft({ ...routerDraft, chain: e.target.value })} />
                                </label>
                                <div className="router-edit-foot">
                                  <button type="button" className="archv-btn" disabled={rowBusy} onClick={() => setRouterEdit('')}>取消</button>
                                  <button
                                    type="button"
                                    className="archv-btn archv-go"
                                    disabled={rowBusy}
                                    onClick={() => applyRouter('llm', { action: 'update-route', id: route.id, patch: { name: routerDraft.name, chain: splitChain(routerDraft.chain) } }, '已保存')}
                                  >保存</button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                    {routerNew.open ? (
                      <div className="router-new">
                        <div className="router-edit">
                          <label className="mv-inline-label">id（模型下拉框里显示的名字，不能有空格与斜杠）
                            <input type="text" value={routerNew.id} disabled={rowBusy} placeholder="例如 GLM5.3" onChange={(e) => setRouterNew({ ...routerNew, id: e.target.value })} />
                          </label>
                          <label className="mv-inline-label">显示名（可留空）
                            <input type="text" value={routerNew.name} disabled={rowBusy} onChange={(e) => setRouterNew({ ...routerNew, name: e.target.value })} />
                          </label>
                          <label className="mv-inline-label">候选（一行一个 provider/model）
                            <textarea rows="4" value={routerNew.chain} disabled={rowBusy} spellCheck={false} placeholder={'buddy/glm-5.3\ntrae/glm-5.3'} onChange={(e) => setRouterNew({ ...routerNew, chain: e.target.value })} />
                          </label>
                          <div className="router-edit-foot">
                            <button type="button" className="archv-btn" disabled={rowBusy} onClick={() => setRouterNew({ open: false, id: '', name: '', chain: '' })}>取消</button>
                            <button
                              type="button"
                              className="archv-btn archv-go"
                              disabled={rowBusy}
                              onClick={() => applyRouter('llm', { action: 'add-route', id: routerNew.id, name: routerNew.name, chain: splitChain(routerNew.chain) }, `已新建 ${routerNew.id}`)}
                            >新建</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mv-foot">
                        <button type="button" className="archv-btn" disabled={rowBusy} onClick={() => setRouterNew({ open: true, id: '', name: '', chain: '' })}>新建路由组</button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {sub.missing ? <div className="mcp-note">没读到 {sub.file}：要么没装 subagent-router，要么它还没写过配置。</div> : null}
                    <div className="mv-field">
                      <label className="mv-field-label">总开关</label>
                      <div className="mv-row-inline">
                        <button
                          type="button"
                          className={'archv-btn' + (sub.enabled !== false ? ' archv-go' : '')}
                          aria-pressed={sub.enabled !== false}
                          disabled={rowBusy}
                          onClick={() => applyRouter('subagent', { action: 'set-enabled', enabled: sub.enabled === false }, sub.enabled === false ? '已启用' : '已停用')}
                        >{sub.enabled !== false ? '已启用' : '已停用'}</button>
                        <button
                          type="button"
                          className={'archv-btn' + (sub.guidance !== false ? ' archv-go' : '')}
                          aria-pressed={sub.guidance !== false}
                          disabled={rowBusy}
                          onClick={() => applyRouter('subagent', { action: 'set-guidance', guidance: sub.guidance === false }, sub.guidance === false ? '已开启引导' : '已关闭引导')}
                        >引导文案{sub.guidance !== false ? '开' : '关'}</button>
                        <button type="button" className="archv-btn" disabled={rowBusy} onClick={() => applyRouter('subagent', { action: 'reload-from-router' }, '已把 LLM 路由组补进来')}>从 LLM 路由补全</button>
                      </div>
                    </div>
                    {sub.note ? <div className="mcp-note">备注：{sub.note}</div> : null}
                    <div className="mcp-list">
                      {cands.map((c, at) => {
                        const id = `${c.provider}/${c.model}`
                        const dangling = c.provider === 'llm-router' && check.dangling.includes(id)
                        return (
                          <div className="mcp-row router-row" key={id}>
                            <div className="mcp-meta">
                              <div className="mcp-name">{c.label || c.model}<span className="router-id"> · {id}</span></div>
                              <div className="mcp-sub">
                                <span className={'router-tier router-tier-' + (c.tier || 'light')}>{c.tier === 'heavy' ? '重' : '轻'}</span>
                                {dangling ? <span className="router-warn">路由组已不存在</span> : null}
                                <span style={{ marginLeft: 8 }}>{id}</span>
                              </div>
                            </div>
                            <div className="router-acts">
                              <button type="button" className="router-mini" aria-label="上移" disabled={rowBusy || at === 0} onClick={() => applyRouter('subagent', { action: 'move-candidate', from: at + 1, to: at }, '已上移')}>↑</button>
                              <button type="button" className="router-mini" aria-label="下移" disabled={rowBusy || at === cands.length - 1} onClick={() => applyRouter('subagent', { action: 'move-candidate', from: at + 1, to: at + 2 }, '已下移')}>↓</button>
                              <button
                                type="button"
                                className="archv-btn"
                                disabled={rowBusy}
                                aria-pressed={c.tier === 'heavy'}
                                onClick={() => applyRouter('subagent', { action: 'update-candidate', provider: c.provider, model: c.model, patch: { tier: c.tier === 'heavy' ? 'light' : 'heavy' } }, '已改档位')}
                              >{c.tier === 'heavy' ? '重' : '轻'}</button>
                              <button type="button" className="archv-btn router-del" disabled={rowBusy} onClick={() => applyRouter('subagent', { action: 'remove-candidate', provider: c.provider, model: c.model }, `已删除 ${c.model}`)}>删除</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {check.unusedRoutes && check.unusedRoutes.length > 0 ? (
                      <div className="mcp-note">没被子代理候选引用的路由组：{check.unusedRoutes.join('、')}（不影响使用，只是提醒）</div>
                    ) : null}
                  </>
                )}
                <div className="mcp-note">{routerNote || '这些改动写的是两个插件各自的 settings.json（写入前自动备份为 .bak-routerui-*）。它们都靠文件修改时间 5 秒轮询，所以改完最多 5 秒自己生效——不用重启 DSH，也不影响 /router、/subagent-router 与 llm_router 工具继续使用。'}</div>
              </div>
            )
          })()}

          {/* v0.6.1 skill 列表 sheet：三态开关写 frontmatter（服务端先落 .bak-skill-* 备份），
              宿主 watch 到文件变化后下一次 agent step 即生效，不需要重启。
              只列 skillRoots() 扫到的目录；包内（node_modules / bundled）标为只读。 */}
          {settingsOpen && settingsTab === 'host' && skillOpen && (
            <div className="mv-sheet" aria-label="Skill 列表">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">Skill 列表{skillData ? ` · ${skillData.skills.length}` : ''}</h3>
                <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setSkillOpen(false)}>×</button>
              </div>
              {skillErr ? <div className="mcp-note mcp-err">{skillErr}</div> : null}
              {!skillData ? (
                <div className="mcp-note">{skillBusy ? '读取中…' : '尚未读取。'}</div>
              ) : skillData.skills.length === 0 ? (
                <div className="mcp-note">没有扫描到 skill。</div>
              ) : (
                <div className="mcp-list">
                  {skillData.skills.map((s) => {
                    const segs = skillData.modes.map((m) => ({ m, label: skillData.modeLabels[m] }))
                    return (
                      <div className="mcp-row skill-row" key={s.dir}>
                        <div className="mcp-meta">
                          <div className="mcp-name">{s.name}{!s.writable ? <span className="skill-tag">只读</span> : null}</div>
                          <div className="mcp-sub" title={s.dir}>{s.rootLabel}{s.description ? ` · ${s.description}` : ''}</div>
                        </div>
                        <div className="mv-seg skill-seg" role="group" aria-label={`${s.name} 的启用状态`}>
                          {segs.map((x) => (
                            <button
                              key={x.m}
                              type="button"
                              className={'mv-segbtn' + (s.mode === x.m ? ' mv-segbtn-on' : '')}
                              aria-pressed={s.mode === x.m}
                              disabled={skillBusy || !!!s.writable}
                              onClick={async () => {
                                setSkillBusy(true)
                                setSkillErr('')
                                try {
                                  const d = await postJSON('/archived-sessions/skills/mode', { dir: s.dir, mode: x.m, name: s.name })
                                  if (d && Array.isArray(d.skills)) setSkillData((prev) => prev ? { ...prev, skills: d.skills } : prev)
                                  setSkillNote(d && d.changed ? `「${s.name}」→ ${skillData.modeLabels[x.m]}，已生效。` : '状态未变化。')
                                } catch (e) {
                                  setSkillErr(String((e && e.message) || e))
                                } finally {
                                  setSkillBusy(false)
                                }
                              }}
                            >{x.label}</button>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="archv-btn skill-act"
                          disabled={skillBusy}
                          title="导出为 zip"
                          onClick={async () => {
                            setSkillErr('')
                            try {
                              const res = await fetch(`/archived-sessions/skills/export?dir=${encodeURIComponent(s.dir)}`)
                              const type = res.headers.get('content-type') || ''
                              if (!res.ok || !type.includes('zip')) {
                                // 失败时后端回的是 JSON，若走裸 <a download> 会被存成 .zip 且看不出来。
                                const d = await res.json().catch(() => null)
                                throw new Error((d && (d.error || d.message)) || `导出失败 (${res.status})`)
                              }
                              const blob = await res.blob()
                              const url = URL.createObjectURL(blob)
                              const a = document.createElement('a')
                              a.href = url
                              a.download = `${s.dirName || s.name}.zip`
                              document.body.appendChild(a)
                              a.click()
                              a.remove()
                              URL.revokeObjectURL(url)
                              setSkillNote(`已导出 ${s.name}.zip`)
                            } catch (e) {
                              setSkillErr(String((e && e.message) || e))
                            }
                          }}
                        >导出</button>
                        <button
                          type="button"
                          className="archv-btn skill-act skill-danger"
                          disabled={skillBusy || !!!s.writable}
                          title="删除这个 skill 目录（不可恢复）"
                          onClick={async () => {
                            if (!window.confirm(`删除 skill「${s.name}」？

目录：${s.dir}

这会直接删掉磁盘上的整个目录，不可恢复。`)) return
                            setSkillBusy(true)
                            setSkillErr('')
                            try {
                              const d = await postJSON('/archived-sessions/skills/delete', { dir: s.dir, name: s.name })
                              if (d && Array.isArray(d.skills)) setSkillData((prev) => prev ? { ...prev, skills: d.skills } : prev)
                              setSkillNote(`已删除「${s.name}」（${d.files} 个文件）。`)
                            } catch (e) {
                              setSkillErr(String((e && e.message) || e))
                            } finally {
                              setSkillBusy(false)
                            }
                          }}
                        >删除</button>
                      </div>
                    )
                  })}
                </div>
              )}
              {skillData ? (
                <div className="skill-import">
                  <span className="mcp-note">导入 zip 到</span>
                  <select
                    className="skill-root"
                    value={skillImportRoot}
                    onChange={(e) => setSkillImportRoot(e.target.value)}
                    disabled={skillBusy}
                  >
                    {(skillData.roots || []).filter((r) => r.scope !== 'bundled').map((r) => (
                      <option key={r.path} value={r.path}>{r.label || r.path}</option>
                    ))}
                  </select>
                  <input
                    ref={skillFileRef}
                    type="file"
                    accept=".zip,application/zip"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files && e.target.files[0]
                      e.target.value = ''
                      if (!file || !skillImportRoot) return
                      setSkillBusy(true)
                      setSkillErr('')
                      try {
                        const buf = await file.arrayBuffer()
                        // 覆盖 = 换掉磁盘上已有的同名 skill。先确认，用户才知道会动到什么。
                        const overwrite = window.confirm(
                          '如果已存在同名 skill，是否覆盖？\n\n确定 = 覆盖（旧目录会改名保留为 <name>.replaced-<时间>）\n取消 = 遇到同名就报错，不覆盖',
                        )
                        const qs = `root=${encodeURIComponent(skillImportRoot)}` + (overwrite ? '&overwrite=1' : '')
                        const res = await fetch(`/archived-sessions/skills/import?${qs}`, {
                          method: 'POST',
                          headers: { 'content-type': 'application/zip' },
                          body: buf,
                        })
                        const d = await res.json().catch(() => null)
                        if (!res.ok || !d || d.ok === false) throw new Error((d && (d.error || d.message)) || `导入失败 (${res.status})`)
                        if (Array.isArray(d.skills)) setSkillData((prev) => prev ? { ...prev, skills: d.skills } : prev)
                        setSkillNote(`已导入「${d.name}」。`)
                      } catch (err) {
                        setSkillErr(String((err && err.message) || err))
                      } finally {
                        setSkillBusy(false)
                      }
                    }}
                  />
                  <button type="button" className="archv-btn" disabled={skillBusy || !skillImportRoot} onClick={() => skillFileRef.current && skillFileRef.current.click()}>选择 zip 导入</button>
                </div>
              ) : null}
              {skillData && skillData.broken && skillData.broken.length ? (
                <details className="skill-broken">
                  <summary className="mcp-note">已忽略的目录（{skillData.broken.length}）</summary>
                  {skillData.broken.map((b) => (
                    <div className="mcp-note skill-broken-row" key={b.dir} title={b.dir}>{b.rootLabel || b.dir} · {b.reason}</div>
                  ))}
                </details>
              ) : null}
              <div className="mcp-note">{skillNote || '三态：启用 / 仅 / 调用（模型看不到，斜杠命令仍可用）/ 停用（模型与斜杠都不可用）。改动写 SKILL.md 的 frontmatter，写入前自动备份为 .bak-skill-*；宿主监听文件变化，下一次对话即生效。'}</div>
            </div>
          )}

          {/* T4 标签管理 sheet：照自动归档/待移动队列的 mv-sheet 先例。
              每行 = 名字 / 用量 / 重命名（内联输入）/ 并入 select + 确认 / 删除。
              删除确认文案含「只删标签，不会删除会话」红线（logic.tagDeleteConfirm）。 */}
          {settingsOpen && settingsTab === 'storage' && openTagMgr && (
            <div className="mv-sheet" aria-label="标签管理">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">标签管理 · {tagDefs.length}</h3>
                <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => { setOpenTagMgr(false); setRenamingTagId(null) }}>×</button>
              </div>
              <div className="mv-field">
                <label className="mv-field-label" htmlFor="dsm-tag-new">新建标签</label>
                <div className="mv-browse-row">
                  <input
                    id="dsm-tag-new"
                    type="text"
                    value={mgrTagName}
                    disabled={mgrBusy}
                    maxLength={32}
                    placeholder="标签名（不能含斜杠，最长 32 字）"
                    onChange={(e) => setMgrTagName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag() } }}
                  />
                  <button type="button" className="archv-btn" disabled={mgrBusy || !mgrTagName.trim()} onClick={createTag}>新建</button>
                </div>
              </div>
              {tagDefs.length === 0 ? (
                <div className="dtl-note">还没有标签。在上方输入名字即可创建；给会话贴标签也可以在会话卡片的「⋯ → 标签」里进行。</div>
              ) : (
                <div>
                  {tagDefs.map((t) => {
                    const others = tagDefs.filter((o) => String(o.id) !== String(t.id))
                    return (
                      <div key={String(t.id)} className="dsm-tagrow">
                        {renamingTagId === String(t.id) ? (
                          <>
                            <input
                              className="dsm-tag-input"
                              type="text"
                              value={renameTagValue}
                              disabled={mgrBusy}
                              maxLength={32}
                              aria-label={'重命名标签 ' + t.name}
                              autoFocus
                              onChange={(e) => setRenameTagValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTagRename(t) } if (e.key === 'Escape') setRenamingTagId(null) }}
                            />
                            <span className="dsm-tag-acts">
                              <button type="button" className="archv-btn archv-go" disabled={mgrBusy || !renameTagValue.trim()} onClick={() => commitTagRename(t)}>保存</button>
                              <button type="button" className="archv-btn" disabled={mgrBusy} onClick={() => setRenamingTagId(null)}>取消</button>
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="dsm-tag-name" title={t.name}>{t.name}</span>
                            <span className="maint-note">{tagUsage[String(t.id)] || 0} 个会话</span>
                            <span className="dsm-tag-acts">
                              <button type="button" className="archv-btn" disabled={mgrBusy || renamingTagId !== null} title="重命名这个标签" onClick={() => { setRenamingTagId(String(t.id)); setRenameTagValue(t.name) }}>重命名</button>
                              {others.length > 0 && (
                                <>
                                  <select
                                    aria-label={'把标签「' + t.name + '」并入'}
                                    value={mergeTarget[String(t.id)] || ''}
                                    disabled={mgrBusy}
                                    title="把这个标签的所有会话并入另一个标签（并入后本标签删除）"
                                    onChange={(e) => setMergeTarget((m) => Object.assign({}, m, { [String(t.id)]: e.target.value }))}
                                  >
                                    <option value="">并入…</option>
                                    {others.map((o) => <option key={String(o.id)} value={String(o.id)}>{o.name}</option>)}
                                  </select>
                                  <button type="button" className="archv-btn" disabled={mgrBusy || !mergeTarget[String(t.id)]} title={mergeTarget[String(t.id)] ? '确认并入所选标签' : '先在左侧选择并入的目标标签'} onClick={() => mergeTag(t)}>确认</button>
                                </>
                              )}
                              <button type="button" className="archv-btn archv-del" disabled={mgrBusy} title="删除标签（只删标签，不会删除会话）" onClick={() => deleteTag(t)}>删除</button>
                            </span>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="dtl-note">标签是会话的自定义标记：新建、重命名、合并、删除都只改标记本身，不会删除或移动任何会话。单个会话的标签数量与标签总数都有服务端上限，超限时会提示并自动回退本地改动。</div>
            </div>
          )}
          {pendingQueue.length > 0 && (
            <div className="mv-sheet" aria-label="待移动队列">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">待移动队列 · {pendingQueue.length}</h3>
              </div>
              <div className="dtl-note">这些会话正被 DSH 打开着，官方只在进程退出时释放写权限；释放后插件会自动完成移动，也可重启 DSH 让它在启动头几秒抢先补跑。</div>
              {pendingQueue.map((q) => (
                <div key={String(q.sessionId)} className="dsm-kid-row">
                  <span className="dsm-kid-name" title={`${q.sessionId} → ${q.targetPath || ''}`}>{shortId(q.sessionId)}… → {pathTail(q.targetPath) || '目标工作区'}</span>
                  <span className="dsm-kid-acts">
                    {Number.isSafeInteger(q.attempts) && q.attempts > 0 ? <span className="maint-note">已失败 {q.attempts} 次</span> : null}
                    <button type="button" className="archv-btn" onClick={() => cancelQueuedMove(q.sessionId)}>取消</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {settingsOpen && settingsTab === 'archive' && aaOpen && (
            <div className="mv-sheet" aria-label="自动归档设置">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">自动归档</h3>
                <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setAaOpen(false)}>×</button>
              </div>
              <div className="mv-field">
                <label className="mv-field-label" htmlFor="dsm-aa-days">将多久未活跃的会话自动归档</label>
                <select id="dsm-aa-days" value={aa.settings.inactiveDays} disabled={aaBusy} onChange={(e) => updateAutoArchive({ inactiveDays: Number(e.target.value) })}>
                  <option value="0">不自动归档</option>
                  <option value="30">30 天未活跃</option>
                  <option value="60">60 天未活跃</option>
                  <option value="90">90 天未活跃</option>
                </select>
              </div>
              <label className="aa-check">
                <input type="checkbox" checked={aa.settings.skipStarred !== false} disabled={aaBusy} onChange={(e) => updateAutoArchive({ skipStarred: e.target.checked })} />
                跳过已收藏的会话
              </label>
              <div className="mv-foot">
                <button type="button" className="archv-btn" disabled={aaBusy || !aa.settings.inactiveDays} onClick={runAutoArchive}>{aaBusy ? '检查中…' : '立即检查'}</button>
              </div>
              <div className="dtl-note">
                自动归档只是把会话收进「已归档」，不删除任何数据，随时可恢复。当前正在使用的会话永远不会被自动归档。检查在打开本面板时触发，每天最多一次。
              </div>
            </div>
          )}
          {settingsOpen && settingsTab === 'archive' && wsArchOpen && (
            <div className="mv-sheet" aria-label="工作区归档">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">工作区归档</h3>
                <div className="mv-sheet-actions">
                  {wsArch.keys.length ? (
                    <button type="button" className="archv-btn" disabled={wsArchBusy} onClick={() => runWsArch('clear', null, '已恢复全部工作区')}>
                      {wsArchBusy ? '处理中…' : '全部恢复'}
                    </button>
                  ) : null}
                  <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setWsArchOpen(false)}>×</button>
                </div>
              </div>
              {workspaces.length ? (
                <div className="ws-arch-list">
                  {workspaces.map((ws) => (
                    <div className="ws-arch-row" key={String(ws.workspaceId || ws.path)}>
                      <span className="ws-arch-name" title={String(ws.path || '')}>{String(ws.title || pathTail(ws.path) || ws.path || '（未命名工作区）')}</span>
                      <button
                        type="button"
                        className={'archv-btn' + (ws.archived ? ' archv-go' : '')}
                        disabled={wsArchBusy}
                        onClick={() => runWsArch(ws.archived ? 'unarchive' : 'archive', ws.path, ws.archived ? '已恢复该工作区' : '已归档该工作区')}
                      >
                        {ws.archived ? '恢复' : '归档'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="archv-empty">当前宿主没有已注册的工作区</div>
              )}
              <div className="dtl-note">
                归档只是把整个工作区从侧栏分组和会话列表里折叠起来，不动会话自身的归档状态，「已归档」视图也不会被塞满；点「恢复」立刻全部回来。同一个工作区目录重新创建时，归档记录保留。
              </div>
            </div>
          )}
          {settingsOpen && settingsTab === 'storage' && storageOpen && (
            <div className="mv-sheet" aria-label="存储占用">
              <div className="mv-sheet-head">
                <h3 className="mv-sheet-title">存储占用</h3>
                <div className="mv-sheet-actions">
                  <button type="button" className="archv-btn" disabled={storageBusy} onClick={loadStorage}>{storageBusy ? '统计中…' : '重新统计'}</button>
                  <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setStorageOpen(false)}>×</button>
                </div>
              </div>
              {storageError ? (
                <div className="archv-err" role="alert">
                  <span>{storageError}</span>
                  <button type="button" className="archv-errretry" onClick={loadStorage}>重试</button>
                </div>
              ) : !storage ? (
                <div className="archv-empty">统计中…</div>
              ) : storage.sessionCount === 0 ? (
                <div className="archv-empty">暂无会话，没有可统计的存储占用。</div>
              ) : (
                <>
                  <div className="dsm-storage-sum">
                    共 {fmtBytes(storage.totalBytes) || '0 B'} · {storage.sessionCount} 个会话{storage.unknownSessions ? ` · ${storage.unknownSessions} 个大小未知` : ''}
                  </div>
                  <div className="dsm-storage-list">
                    {storage.workspaces.map((w) => (
                      <div className="dsm-storage-row" key={w.key}>
                        <span className="dsm-storage-name" title={w.path || '未分组'}>{w.title || (w.path ? pathName(w.path) : '未分组')}</span>
                        <span className="dsm-storage-bar" aria-hidden="true"><span className="dsm-storage-fill" style={{ width: `${Math.round((w.share || 0) * 100)}%` }} /></span>
                        <span className="dsm-storage-size">{fmtBytes(w.bytes) || '—'}</span>
                        <span className="dsm-storage-count">{w.sessions} 个</span>
                      </div>
                    ))}
                  </div>
                  {storage.top.length > 0 && (
                    <div className="dtl-sec">
                      <div className="dtl-sec-t">占用最大的会话</div>
                      <div className="dsm-storage-list">
                        {storage.top.map((s) => (
                          <div className="dsm-storage-row" key={s.sessionId}>
                            <span className="dsm-storage-name" title={s.sessionId}>{s.title || s.sessionId}</span>
                            <span className="dsm-storage-size">{fmtBytes(s.sizeBytes) || '—'}</span>
                            <span className="dsm-storage-count">{s.workspaceTitle || (s.workspacePath ? pathName(s.workspacePath) : '未分组')}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="dtl-note">统计的是会话日志文件的磁盘占用（压缩后的实际大小），只读，不修改任何数据。</div>
                </>
              )}
            </div>
          )}
            </section>
          )}
          {!settingsOpen && showSessionList && (
            <>
              <div className="sess-tools sess-tools-5" aria-label="查找和整理会话">
                <div className="sess-field">
                  <label htmlFor="dsm-search">搜索会话</label>
                  <input id="dsm-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="标题、会话 ID 或工作区" />
                </div>
                <div className="sess-field">
                  <label htmlFor="dsm-workspace-filter">工作区</label>
                  <select id="dsm-workspace-filter" value={workspaceFilter} onChange={(e) => setWorkspaceFilter(e.target.value)}>
                    <option value="all">全部工作区</option>
                    {/* v0.7.0（吸收上游 cefd98f）：两个哨兵值收「没有工作区的会话」与
                        「工作区目录已经不在了的会话」——这两类在旧版只能混在「全部」里。 */}
                    <option value={WS_UNGROUPED}>未分组（没有工作区）</option>
                    <option value={WS_GONE}>工作区已删</option>
                    {/* v3.12.0：已归档的工作区在列表里被整体折叠，下拉里标注一下，
                        否则用户选中它只会看到空列表，以为是数据丢了。 */}
                    {workspaces.map((w) => <option key={w.workspaceId} value={w.path}>{w.title}{w.archived ? '（已归档）' : ''}</option>)}
                    {/* 已存筛选可能指向已删除的工作区：补一个兜底 option，select 永不显示空白。
                        哨兵值要排除掉，否则会渲染成「已删工作区 · ?」。 */}
                    {workspaceFilter !== 'all' && !isWorkspaceSentinel(workspaceFilter) && !workspaces.some((w) => w.path === workspaceFilter) && (
                      <option value={workspaceFilter}>已删工作区 · {pathName(workspaceFilter) || '?'}</option>
                    )}
                  </select>
                </div>
                <div className="sess-field">
                  {/* T4 标签筛选（单选）。v1 明确不做多选 AND：见 logic.applyTagFilter 注释。 */}
                  <label htmlFor="dsm-tag-filter">标签</label>
                  <select
                    id="dsm-tag-filter"
                    value={tagFilter}
                    disabled={!tagsReady}
                    title={!tagsReady ? tagsBlockedTitle : tagFilter ? '当前按「' + (tagMap.get(tagFilter) || '所选标签') + '」筛选；多选组合可用「保存当前筛选」固化' : '按标签筛选（单选）'}
                    onChange={(e) => setTagFilter(e.target.value)}
                  >
                    <option value="">全部标签</option>
                    {tagDefs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    {tagFilter && !tagMap.has(tagFilter) && <option value={tagFilter}>（已删标签）</option>}
                  </select>
                </div>
                <div className="sess-field">
                  <label htmlFor="dsm-sort">排序</label>
                  <select id="dsm-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                    <option value="newest">最新创建</option><option value="oldest">最早创建</option><option value="title">标题 A–Z</option><option value="priority">优先级</option>
                  </select>
                </div>
                <div className="sess-field">
                  <label htmlFor="dsm-group">分组</label>
                  <select id="dsm-group" value={groupByLineage ? 'lineage' : 'flat'} onChange={(e) => setGroupByLineage(e.target.value === 'lineage')} title="血缘分组：子代理折叠、分支聚拢成组；平铺：与 DSH 原生一致，全部并列">
                    <option value="lineage">血缘（折叠）</option>
                    <option value="flat">平铺（并列）</option>
                  </select>
                </div>
              </div>
              <div className="sess-results">
                {/* 一句话说清现状：有子代理折叠时，折叠数取代「共 X 个」尾巴
                    出现在同一句里；没有折叠时维持「显示 N 个，共 M 个」。
                    role=status 移到这句正文上，右侧保存控件组不进播报区。 */}
                <span className="sess-results-main" role="status">
                  显示 {topList.length - syntheticCount} 个会话
                  {foldedCount || branchFolded
                    ? `，另有 ${[foldedCount ? `${foldedCount} 个子代理折叠在父会话下` : '', branchFolded ? `${branchFolded} 个分支聚成 ${branchGroupCount} 组` : ''].filter(Boolean).join('、')}`
                    : query || workspaceFilter !== 'all' || tagFilter
                      ? `，共 ${filter === 'archived' ? archivedList.length : filter === 'active' ? activeList.length : filter === 'starred' ? starredList.length : filter === 'review' ? reviewList.length : filter === 'empty' ? emptyList.length : totalTopCount} 个`
                      : (topList.length !== list.length ? `，共 ${list.length} 个` : '')}
                </span>
                {/* T4：计数行右侧的保存筛选控件组。保存 = 抓 {view,workspace,
                    sort,tag} 快照（logic.filterSnapshotOf）落盘；已存下拉
                    「选中即应用」（logic.filterShapeFromSaved 还原，非法字段
                    回落默认并 toast 标注），行内删除作用于当前选中项。 */}
                <span className="dsm-fbar">
                  {saveFilterOpen ? (
                    <>
                      <input
                        type="text"
                        value={saveFilterName}
                        maxLength={40}
                        placeholder="筛选名称"
                        aria-label="为当前筛选命名"
                        autoFocus
                        disabled={mgrBusy}
                        onChange={(e) => setSaveFilterName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrentFilter() } if (e.key === 'Escape') { setSaveFilterOpen(false); setSaveFilterName('') } }}
                      />
                      <button type="button" className="archv-btn archv-go" disabled={mgrBusy || !saveFilterName.trim()} onClick={saveCurrentFilter}>保存</button>
                      <button type="button" className="archv-btn" disabled={mgrBusy} onClick={() => { setSaveFilterOpen(false); setSaveFilterName('') }}>取消</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="archv-btn"
                      title="把当前视图 / 工作区 / 标签 / 排序存为一个可复用的筛选"
                      onClick={() => { setSaveFilterOpen(true); setSaveFilterName('') }}
                    >保存当前筛选</button>
                  )}
                  <select
                    aria-label="已存筛选"
                    value={savedFilters.some((f) => String(f.id) === appliedSavedId) ? appliedSavedId : ''}
                    disabled={!savedFilters.length || mgrBusy}
                    title={!savedFilters.length ? '还没有已存筛选；点左侧「保存当前筛选」创建' : '选择一个已存筛选并立即应用；选中后右侧可删除'}
                    onChange={(e) => applySavedFilter(e.target.value)}
                  >
                    <option value="">{savedFilters.length ? '已存筛选…' : '无已存筛选'}</option>
                    {savedFilters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  {appliedSavedId && (
                    <button
                      type="button"
                      className="archv-btn archv-del"
                      disabled={mgrBusy}
                      title={'删除已存筛选「' + ((savedFilters.find((f) => String(f.id) === appliedSavedId) || {}).name || appliedSavedId) + '」（只删这条保存的筛选，不动会话）'}
                      onClick={() => deleteSavedFilter(appliedSavedId)}
                    >删除</button>
                  )}
                </span>
              </div>
            </>
          )}

          {!settingsOpen && showSessionList && (topList.length > 0 || orphanSubagents.length > 0) && (
            <div className={'sess-batch' + (selIds.length > 0 ? ' sess-batch-pin' : '')}>
              <span className="sess-btntext">{selIds.length ? `已选 ${selIds.length} 项` : (filter === 'archived' ? `共 ${archivedList.length} 个归档会话` : filter === 'starred' ? `共 ${starredList.length} 个收藏会话` : filter === 'review' ? `共 ${reviewList.length} 个待回看会话` : `共 ${totalTopCount} 个会话（活动 ${activeList.length} / 已归档 ${archivedList.length}）`)}</span>
              {/* issue #18 第 3 条：全选只覆盖当前列表里能单独勾选的行；折叠中的
                  子代理 / 分支成员与合成头不参与，避免「选中了看不见的东西」。 */}
              <button type="button" className="archv-btn" disabled={topList.length === 0} title={groupByLineage ? '选中当前列表的会话行（折叠中的子代理与分支成员不会被选中）' : undefined} onClick={selectAll}>全选</button>
              {!settingsOpen && selIds.length > 0 && (
                <>
                  {filter === 'archived' && (
                    <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => doBatch('restore-many')}>恢复所选</button>
                  )}
                  {filter !== 'archived' && (
                    <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => doBatch('archive-many')}>归档所选</button>
                  )}
                  {/* issue #18 复访：批量删除（移入回收站）原先只挂在「已归档」
                      视图下，全部 / 活动 / 已收藏 / 空白视图多选后没有任何删除
                      入口，与单条会话的「… → 移到回收站」不一致。各会话视图都给，
                      回收站视图本身不走这个列表（showSessionList 已排除）。 */}
                  <button type="button" className="archv-btn archv-del" disabled={busy !== null} title="移入回收站，可在回收站恢复" onClick={() => doBatch('delete-many')}>{confirmBatch ? '确认删除所选?' : '删除所选'}</button>
                  {canMove.available && (
                    <button
                      type="button"
                      className="archv-btn"
                      disabled={busy !== null}
                      aria-expanded={batchMoveOpen}
                      onClick={() => setBatchMoveOpen(!batchMoveOpen)}
                    >
                      移动所选…
                    </button>
                  )}
                  <button
                    type="button"
                    className="archv-btn"
                    disabled={busy !== null}
                    aria-expanded={batchMetaOpen}
                    title="批量设置优先级 / 待回看"
                    onClick={() => setBatchMetaOpen(!batchMetaOpen)}
                  >
                    标注所选…
                  </button>
                  <button type="button" className="archv-btn" onClick={clearSel}>取消选择</button>
                </>
              )}
              {!settingsOpen && selIds.length > 0 && batchMoveOpen && canMove.available && (
                <div className="mv-sheet" role="region" aria-label="批量移动到工作区">
                  <div className="mv-sheet-head">
                    <h3 className="mv-sheet-title">批量移动 {selIds.length} 个会话</h3>
                    <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setBatchMoveOpen(false)}>×</button>
                  </div>
                  <div className="mv-seg" role="tablist">
                    <button type="button" role="tab" aria-selected={moveMode === 'existing'} className={'mv-segbtn' + (moveMode === 'existing' ? ' mv-segbtn-on' : '')} onClick={() => setMoveMode('existing')}>已有工作区</button>
                    <button type="button" role="tab" aria-selected={moveMode === 'new'} className={'mv-segbtn' + (moveMode === 'new' ? ' mv-segbtn-on' : '')} onClick={() => setMoveMode('new')}>新建目录</button>
                  </div>
                  {moveMode === 'existing' ? (
                    <div className="mv-field">
                      <label className="mv-field-label" htmlFor="mv-batch-ws">目标工作区</label>
                      <select id="mv-batch-ws" value={targetWs} onChange={(e) => setTargetWs(e.target.value)}>
                        {workspaces.length === 0 && <option value="">（暂无工作区）</option>}
                        {workspaces.map((w) => (
                          <option key={w.workspaceId} value={w.workspaceId}>{w.title} · {w.path}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="mv-field">
                      <label className="mv-field-label" htmlFor="mv-batch-path">新工作区目录路径</label>
                      <div className="mv-browse-row">
                        <input
                          id="mv-batch-path"
                          type="text"
                          value={newPath}
                          onChange={(e) => setNewPath(e.target.value)}
                          placeholder="例如 /Users/you/Projects/demo 或 ~/demo"
                        />
                        <button
                          type="button"
                          className="archv-btn"
                          onClick={pickDirectory}
                          disabled={busy !== null || picking || !workspacesSvc}
                          title={!workspacesSvc ? '当前运行环境不支持系统目录选择' : '打开系统目录选择窗口'}
                        >
                          {picking ? '选择中…' : '浏览…'}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mv-foot">
                    <button type="button" className="archv-btn" onClick={() => setBatchMoveOpen(false)}>取消</button>
                    <button type="button" className="archv-btn archv-go" disabled={busy !== null} onClick={() => doBatchMove()}>
                      {busy === '__batch__' && <span className="archv-spin" aria-hidden="true" />}确认移动
                    </button>
                  </div>
                </div>
              )}
              {/* v0.1 批量标注 sheet：meta/set 是单请求原子批量（无部分失败形态），
                  失败整体提示——不需要 hkkz9522 式逐条结果对话框；批量备注有
                  覆盖风险，v0.1 不提供（逐会话编辑）。 */}
              {!settingsOpen && selIds.length > 0 && batchMetaOpen && (
                <div className="mv-sheet" role="region" aria-label="批量标注">
                  <div className="mv-sheet-head">
                    <h3 className="mv-sheet-title">批量标注 {selIds.length} 个会话</h3>
                    <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setBatchMetaOpen(false)}>×</button>
                  </div>
                  <div className="mv-field">
                    <label className="mv-field-label" htmlFor="mv-batch-prio">优先级</label>
                    <select id="mv-batch-prio" value={batchPrio} onChange={(e) => setBatchPrio(e.target.value)}>
                      <option value="">（不修改）</option>
                      <option value="1">1 · 最高</option>
                      <option value="2">2 · 高</option>
                      <option value="3">3 · 正常</option>
                      <option value="4">4 · 低</option>
                      <option value="5">5 · 最低</option>
                      <option value="clear">清除优先级</option>
                    </select>
                  </div>
                  <div className="mv-foot">
                    <button type="button" className="archv-btn" onClick={() => setBatchMetaOpen(false)}>取消</button>
                    <button
                      type="button"
                      className="archv-btn archv-go"
                      disabled={busy !== null || !batchPrio}
                      onClick={() => { doBatchMeta({ priority: batchPrio === 'clear' ? null : Number(batchPrio) }, batchPrio === 'clear' ? '清除优先级' : `设置优先级 ${batchPrio}`); setBatchPrio(''); setBatchMetaOpen(false) }}
                    >
                      {busy === '__batch__' && <span className="archv-spin" aria-hidden="true" />}应用优先级
                    </button>
                    <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => { doBatchMeta({ review: true }, '标记待回看'); setBatchMetaOpen(false) }}>标记待回看</button>
                    <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => { doBatchMeta({ review: false }, '取消待回看'); setBatchMetaOpen(false) }}>取消待回看</button>
                  </div>
                  <div className="dtl-note">「（不修改）」时不改优先级；「清除」为显式取消设置（排序回落 3 正常）。备注与标签请逐会话编辑。</div>
                </div>
              )}
            </div>
          )}

          {!settingsOpen && showSessionList && topList.length === 0 && orphanSubagents.length === 0 ? (
            <div className="archv-empty">{query || workspaceFilter !== 'all' || tagFilter ? '没有匹配的会话。请调整搜索词、标签或工作区筛选。' : filter === 'archived' ? '目前没有归档会话。在“全部”里选中会话点“归档”即可收纳进来。' : filter === 'active' ? '目前没有活动会话。' : filter === 'starred' ? '还没有收藏的会话。点击会话左侧的星标即可收藏。' : filter === 'review' ? '还没有待回看的会话。打开会话行上的「待回看」开关即可收进来。' : filter === 'empty' ? '没有空白会话。新开会话还没产生内容时会归到这里，侧栏会自动隐藏它们。' : '暂无可管理的会话。'}</div>
          ) : !settingsOpen && showSessionList ? (
            <div className="archv-list" role="list">
              {topList.map((it) => {
                if (it && it.syntheticRoot) {
                  // 缺失父的分支组头（合成行）：无勾选/星标/菜单/打开，不可导航——
                  // 它代表的来源会话不在当前列表（被筛掉/已归档/已删除），只作归属展示。
                  const root = String(it.syntheticRoot)
                  const members = branchGroupsOf.get(root) || []
                  const open = !!openBranches[root] || branchHit(root)
                  const srcTitle = dsmAuthoritativeTitles.get(root)
                  return (
                    // issue #18 第 2 条：合成头先前在这里提前 return，只渲染按钮与
                    // 「来源：」，展开时什么都不会出现（成员列表只挂在普通卡片的
                    // renderBranchGroup 上）。这里补上同一个成员渲染器——按钮、
                    // 展开状态、搜索命中展开都复用分支组的既有语义。
                    <React.Fragment key={it.sessionId}>
                      <div className="dsm-src-head" role="listitem">
                        <button
                          type="button"
                          className="dsm-kids-toggle"
                          aria-expanded={open}
                          title={(open ? '收起 ' : '展开 ') + members.length + ' 个分支会话（来源会话不在当前列表）'}
                          onClick={() => toggleBranch(root)}
                        >
                          {open ? '▾' : '▸'} {members.length} 分支
                        </button>
                        <span className="dsm-src-name" title={root}>{'来源：' + (srcTitle || shortId(root))}</span>
                      </div>
                      {renderBranchGroup(root)}
                    </React.Fragment>
                  )
                }
                const date = fmtDate(it.createdAt)
                const expanded = openMove === it.sessionId || openTags === it.sessionId
                return (
                  <div key={it.sessionId} className={'archv-card' + (expanded ? ' archv-card-exp' : '')} role="listitem">
                    <div className="archv-row">
                      <input
                        type="checkbox"
                        className="archv-check"
                        checked={!!selected[it.sessionId]}
                        onChange={() => toggle(it.sessionId)}
                        aria-label={'选择 ' + (it.title || it.sessionId)}
                      />
                      <button
                        type="button"
                        className={'archv-star' + (it.starred ? ' archv-star-on' : '')}
                        aria-pressed={!!it.starred}
                        aria-label={(it.starred ? '取消收藏 ' : '收藏 ') + (it.title || it.sessionId)}
                        title={it.starred ? '取消收藏' : '收藏'}
                        onClick={(e) => { e.stopPropagation(); toggleStar(it) }}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 2.5l2.9 5.9 6.6.9-4.8 4.6 1.2 6.5-5.9-3.1-5.9 3.1 1.2-6.5L2.5 9.3l6.6-.9z" /></svg>
                      </button>
                      {/* v0.1 元数据层：待回看开关（书签；与星标同型乐观更新）。 */}
                      <button
                        type="button"
                        className={'archv-review' + (it.review ? ' archv-review-on' : '')}
                        aria-pressed={!!it.review}
                        aria-label={(it.review ? '取消待回看 ' : '标记待回看 ') + (it.title || it.sessionId)}
                        title={it.review ? '取消待回看' : '标记待回看'}
                        onClick={(e) => { e.stopPropagation(); toggleReview(it) }}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.7L5 22V3a1 1 0 0 1 1-1z" /></svg>
                      </button>
                      {/* v0.1 元数据层：优先级（未设置显示 —，排序按 3 归一）。 */}
                      <select
                        className={'archv-prio' + (Number.isInteger(it.priority) ? ' archv-prio-set' : '')}
                        value={Number.isInteger(it.priority) ? String(it.priority) : ''}
                        aria-label={'优先级：' + (it.title || it.sessionId)}
                        title="优先级（1 最高 → 5 最低；未设置按 3 正常参与排序）"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => { e.stopPropagation(); setPriority(it, e.target.value) }}
                      >
                        <option value="">—</option>
                        <option value="1">P1</option>
                        <option value="2">P2</option>
                        <option value="3">P3</option>
                        <option value="4">P4</option>
                        <option value="5">P5</option>
                      </select>
                      <div className="archv-body">
                        <div className="archv-main">
                          <div className="archv-titlerow">
                            <span className="archv-name" title={it.title || ''}>{it.title || '(无标题)'}</span>
                            {branchBadge(it.sessionId)}
                            {emptyBadge(it.sessionId)}
                            {tagChips(it.sessionId)}
                            {kidsBadge(it.sessionId)}
                            {branchGroupBadge(it.sessionId)}
                            <button type="button" className={'archv-id' + (copiedId === it.sessionId ? ' archv-id-copied' : '')} title={it.sessionId + '（点击复制完整 ID）'} aria-label={'复制会话 ID ' + it.sessionId} onClick={(e) => { e.stopPropagation(); copySessionId(it.sessionId) }}>{copiedId === it.sessionId ? '已复制' : shortId(it.sessionId)}</button>
                          </div>
                          <div className="archv-meta">
                            {it.archived ? <span className="archv-wtag archv-wgone">已归档</span> : <span className="archv-wtag archv-active">活动</span>}
                            {workspaceTag(it)}
                            {date && <><span className="archv-dot">·</span><span className="archv-date">{date}</span></>}
                          </div>
                        </div>
                        {rowMenu(it)}
                      </div>
                    </div>
                    {groupByLineage && renderKids(it.sessionId, 0)}
                    {groupByLineage && renderBranchGroup(it.sessionId)}
                    {expanded && (
                      <div className="mv-sheet" role="region" aria-label="移动到工作区">
                        <div className="mv-sheet-head">
                          <h3 className="mv-sheet-title">移动到工作区</h3>
                          <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setOpenMove(null)}>×</button>
                        </div>
                        <div className="mv-seg" role="tablist">
                          <button type="button" role="tab" aria-selected={moveMode === 'existing'} className={'mv-segbtn' + (moveMode === 'existing' ? ' mv-segbtn-on' : '')} onClick={() => setMoveMode('existing')}>已有工作区</button>
                          <button type="button" role="tab" aria-selected={moveMode === 'new'} className={'mv-segbtn' + (moveMode === 'new' ? ' mv-segbtn-on' : '')} onClick={() => setMoveMode('new')}>新建目录</button>
                        </div>
                        {moveMode === 'existing' ? (
                          <div className="mv-field">
                            <label className="mv-field-label" htmlFor="mv-target-ws">目标工作区</label>
                            <select id="mv-target-ws" value={targetWs} onChange={(e) => setTargetWs(e.target.value)}>
                              {workspaces.length === 0 && <option value="">（暂无工作区）</option>}
                              {workspaces.map((w) => (
                                <option key={w.workspaceId} value={w.workspaceId}>{w.title} · {w.path}</option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div className="mv-field">
                            <label className="mv-field-label" htmlFor="mv-new-path">新工作区目录路径</label>
                            <div className="mv-browse-row">
                              <input
                                id="mv-new-path"
                                type="text"
                                value={newPath}
                                onChange={(e) => setNewPath(e.target.value)}
                                placeholder="例如 /Users/you/Projects/demo 或 ~/demo"
                              />
                              <button
                                type="button"
                                className="archv-btn"
                                onClick={pickDirectory}
                                disabled={busy !== null || picking || !workspacesSvc}
                                title={!workspacesSvc ? '当前运行环境不支持系统目录选择' : '打开系统目录选择窗口'}
                              >
                                {picking ? '选择中…' : '浏览…'}
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="mv-foot">
                          <button type="button" className="archv-btn" onClick={() => setOpenMove(null)}>取消</button>
                          <button type="button" className="archv-btn archv-go" disabled={busy !== null} onClick={() => doMove(it)}>
                            {busy === it.sessionId && <span className="archv-spin" aria-hidden="true" />}确认移动
                          </button>
                        </div>
                      </div>
                    )}
                    {openTags === it.sessionId && (() => {
                      // T4 卡内标签编辑 sheet（mv-sheet 同型）：勾选即时全量
                      // /tags/set，乐观 + 回滚；死 id 行不渲染。底部「新建标签
                      // 并贴上」回车即提交。
                      const cur = Array.isArray(assignments[String(it.sessionId)]) ? assignments[String(it.sessionId)] : []
                      const locked = tagBusy !== null || !tagsReady
                      return (
                      <div className="mv-sheet" role="region" aria-label="会话标签">
                        <div className="mv-sheet-head">
                          <h3 className="mv-sheet-title">会话标签 · {it.title || shortId(it.sessionId)}</h3>
                          <button type="button" className="mv-sheet-close" aria-label="关闭" onClick={() => setOpenTags(null)}>×</button>
                        </div>
                        {tagDefs.length === 0 ? (
                          <div className="dtl-note">还没有标签，在下方新建第一个。</div>
                        ) : (
                          <div className="dsm-taglist">
                            {tagDefs.map((t) => {
                              const checked = cur.some((id) => String(id) === String(t.id))
                              return (
                                <label className="dsm-tagcheck" key={String(t.id)}>
                                  <input type="checkbox" checked={checked} disabled={locked} onChange={() => toggleTagFor(it.sessionId, t.id)} />
                                  <span className="dsm-tagcheck-name" title={t.name}>{t.name}</span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                        <div className="mv-field">
                          <label className="mv-field-label" htmlFor={'dsm-tag-attach-' + String(it.sessionId)}>新建标签并贴上</label>
                          <div className="mv-browse-row">
                            <input
                              id={'dsm-tag-attach-' + String(it.sessionId)}
                              type="text"
                              value={cardTagName}
                              disabled={locked}
                              maxLength={32}
                              placeholder="标签名（不能含斜杠，最长 32 字）"
                              onChange={(e) => setCardTagName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTagAndAttach(it.sessionId) } }}
                            />
                            <button type="button" className="archv-btn" disabled={locked || !cardTagName.trim()} title={locked && !tagsReady ? '标签数据未能加载，暂时无法新建标签' : '新建这个标签并立即贴到当前会话'} onClick={() => createTagAndAttach(it.sessionId)}>贴上</button>
                          </div>
                        </div>
                        <div className="dtl-note">勾选即时生效；单个会话的标签数量以服务端上限为准，超时会提示并回退。</div>
                      </div>
                      )
                    })()}
                    {openDetails === it.sessionId && (
                      <div className="dtl-sheet" role="region" aria-label="会话详情">
                        <div className="dtl-sheet-head">
                          <h3 className="dtl-sheet-title">会话详情</h3>
                          <button type="button" className="mv-sheet-close" aria-label="关闭详情" onClick={() => setOpenDetails(null)}>×</button>
                        </div>
                        {detailsLoading === it.sessionId ? (
                          <div className="archv-skel" aria-label="加载中">{[0, 1].map((i) => <div key={i} className="archv-skel-card" />)}</div>
                        ) : (() => {
                          const d = details[it.sessionId]
                          if (!d) return <div className="dtl-paths">暂无详情</div>
                          const st = d.stats || {}
                          const tools = st.toolCounts ? Object.entries(st.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10) : []
                          return (
                            <div>
                              <div className="dtl-grid">
                                <div className="dtl-cell"><span className="dtl-k">磁盘占用</span><span className="dtl-v">{fmtBytes(d.sizeBytes) || '—'}</span></div>
                                <div className="dtl-cell"><span className="dtl-k">轮次 / 步骤</span><span className="dtl-v">{st.turns ?? 0} / {st.steps ?? 0}</span></div>
                                <div className="dtl-cell"><span className="dtl-k">用户 / 助手</span><span className="dtl-v">{st.userMessages ?? 0} / {st.assistantMessages ?? 0}</span></div>
                                <div className="dtl-cell"><span className="dtl-k">工具调用</span><span className="dtl-v">{st.toolCalls ?? 0}</span></div>
                                <div className="dtl-cell"><span className="dtl-k">图片附件</span><span className="dtl-v">{st.attachments ?? 0}</span></div>
                                <div className="dtl-cell"><span className="dtl-k">创建 / 更新</span><span className="dtl-v">{fmtDate(d.createdAt) || '—'} · {fmtDate(d.updatedAt) || '—'}</span></div>
                              </div>
                              {tools.length > 0 && (
                                <div className="dtl-sec"><div className="dtl-sec-t">工具使用</div>
                                  <div className="dtl-tags">{tools.map(([t, c]) => <span className="dtl-tag" key={t}>{t} ×{c}</span>)}</div>
                                </div>
                              )}
                              {st.fetches && st.fetches.length > 0 && (
                                <div className="dtl-sec"><div className="dtl-sec-t">搜索 / 抓取</div>
                                  <ul className="dtl-list">{st.fetches.map((f, i) => <li key={i}>{f.tool}{f.query ? ` 「${f.query}」` : ''}</li>)}</ul>
                                </div>
                              )}
                              {d.files && d.files.length > 0 && (
                                <div className="dtl-sec"><div className="dtl-sec-t">写过的文件（{d.files.length}）</div>
                                  <ul className="dtl-list">{d.files.map((f, i) => <li key={i}><code>{f.path}</code> <span className="dtl-filetool">({f.tool})</span></li>)}</ul>
                                </div>
                              )}
                              {d.lineage && (d.lineage.parentSessionId || (d.lineage.children && d.lineage.children.length > 0) || (d.lineage.subagents && d.lineage.subagents.length > 0)) && (
                                <div className="dtl-sec"><div className="dtl-sec-t">血缘</div>
                                  <div className="dtl-paths">
                                    {d.lineage.parentSessionId && <div>父会话: <code>{d.lineage.parentSessionId}</code></div>}
                                    {d.lineage.children && d.lineage.children.length > 0 && <div>子会话 ({d.lineage.children.length}): <code>{d.lineage.children.join(', ')}</code></div>}
                                    {d.lineage.subagents && d.lineage.subagents.length > 0 && <div>子代理 ({d.lineage.subagents.length}): <code>{d.lineage.subagents.join(', ')}</code></div>}
                                  </div>
                                </div>
                              )}
                              {/* v0.1 元数据层：备注编辑（≤2000 字符，保存走 meta/set，
                                  乐观更新 + 失败回滚；草稿按会话隔离）。 */}
                              <div className="dtl-sec">
                                <div className="dtl-sec-t">备注</div>
                                <textarea
                                  className="archv-note"
                                  value={Object.prototype.hasOwnProperty.call(noteDrafts, it.sessionId) ? noteDrafts[it.sessionId] : (it.note || '')}
                                  maxLength={2000}
                                  rows={3}
                                  placeholder="给这个会话写点什么（跟随会话持久保存，重启不丢）"
                                  aria-label="会话备注"
                                  onChange={(e) => { setNoteDrafts((m) => ({ ...m, [it.sessionId]: e.target.value })) }}
                                />
                                <div className="mv-foot">
                                  <button
                                    type="button"
                                    className="archv-btn archv-go"
                                    disabled={busy !== null}
                                    onClick={async () => {
                                      const text = Object.prototype.hasOwnProperty.call(noteDrafts, it.sessionId) ? noteDrafts[it.sessionId] : (it.note || '')
                                      const ok = await saveNote(it, text)
                                      if (ok) setNoteDrafts((m) => { const next = { ...m }; delete next[it.sessionId]; return next })
                                    }}
                                  >保存备注</button>
                                  {Object.prototype.hasOwnProperty.call(noteDrafts, it.sessionId) && noteDrafts[it.sessionId] !== (it.note || '') && <span className="dtl-note">有未保存的修改</span>}
                                </div>
                              </div>
                              <div className="dtl-sec">
                                <div className="dtl-sec-t">导出</div>
                                <div className="dtl-export">
                                  <a
                                    className="archv-btn"
                                    href={`/api/session.export?sessionId=${encodeURIComponent(it.sessionId)}&includeDescendants=true`}
                                    onClick={(e) => e.stopPropagation()}
                                    style={zipOk ? undefined : { pointerEvents: 'none', opacity: 0.45 }}
                                    title={zipOk ? '含子会话与附件，由 DSH 提供' : '当前持久化后端不支持原始日志导出'}
                                  >下载原始日志 (ZIP)</a>
                                  <button type="button" className="archv-btn" disabled={mdBusy === it.sessionId} onClick={() => exportMarkdown(it)}>{mdBusy === it.sessionId ? '生成中…' : '导出 Markdown'}</button>
                                </div>
                                <div className="dtl-note">ZIP 含子会话与附件，由 DSH 提供 · Markdown 为本插件生成的可读对话记录</div>
                              </div>
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )
              })}
              {/* issue #18 第 1 条：父会话不在当前列表（已删除 / 已归档 / 被筛选）
                  的子代理不再平铺成上百个「(无标题)」行，统一收进这一张卡片：
                  默认收起不占版面，展开后逐条可打开 / 归档 / 删除，一条都不丢。 */}
              {groupByLineage && orphanSubagents.length > 0 && (
                <div className="archv-card dsm-orphan-card" role="listitem">
                  <div className="archv-row">
                    <div className="archv-body">
                      <div className="archv-main">
                        <div className="archv-titlerow">
                          <button
                            type="button"
                            className="dsm-kids-toggle"
                            aria-expanded={orphanOpen}
                            title={(orphanOpen ? '收起 ' : '展开 ') + orphanSubagents.length + ' 个未归属的子代理会话'}
                            onClick={() => setOpenOrphans(!openOrphans)}
                          >
                            {orphanOpen ? '▾' : '▸'} {orphanSubagents.length} 子代理
                          </button>
                          <span className="archv-name">未归属的子代理会话</span>
                        </div>
                        <div className="archv-meta">
                          <span className="archv-wtag archv-wgone">父会话不在当前列表</span>
                          <span className="archv-dot">·</span>
                          <span className="archv-date">不再混进上面的会话列表；展开后可打开 / 归档 / 删除</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  {orphanOpen && (
                    <div className="dsm-kids" aria-label="未归属子代理会话">
                      {orphanSubagents.map((k) => {
                        const li = lineage[String(k.sessionId)]
                        return (
                          <div className="dsm-kid" key={k.sessionId}>
                            <div className="dsm-kid-row">
                              <span className="dsm-kid-name" title={k.title || k.sessionId}>{k.title || '(无标题)'}</span>
                              {emptyBadge(k.sessionId)}
                              {tagChips(k.sessionId)}
                              <span className="dsm-kid-meta">{k.archived ? '已归档' : '活动'}{fmtDate(k.createdAt) ? ` · ${fmtDate(k.createdAt)}` : ''}</span>
                              <span className="dsm-kid-acts">
                                <button type="button" className="archv-btn" disabled={busy !== null} title="切换到这个子代理会话（设置面板挡着会话区，关掉即可看到）" onClick={async () => {
                                  const name = k.title || (String(k.sessionId).slice(0, 8) + '…')
                                  const res = await dsmOpenSessionById(k.sessionId, (li && li.parentSession) || null)
                                  const msg = openSubagentToast(res, name, 'panel')
                                  showToast(msg.text, msg.kind)
                                }}>打开</button>
                                <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => act(k.archived ? 'restore' : 'archive', k)}>{k.archived ? '恢复' : '归档'}</button>
                                <button type="button" className="archv-btn archv-del" disabled={busy !== null} title="移入回收站，可在回收站恢复" onClick={() => setDelTarget(k)}>删除</button>
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
      {toast && <div className={'archv-status' + (toast.kind === 'err' ? ' archv-status-err' : '') + (String(toast.msg).length > 28 ? ' archv-status-long' : '')} role="status" title="点击关闭" onClick={() => setToast(null)}>{toast.msg}</div>}
      {delTarget && (
        <div className="dlg-backdrop" onClick={() => setDelTarget(null)}>
          <div ref={dialogRef} className="dlg" role="alertdialog" aria-modal="true" aria-label="删除会话" onClick={(e) => e.stopPropagation()}>
            <h3 className="dlg-title">删除会话</h3>
            <p className="dlg-text">确认删除「{delTarget.title || delTarget.sessionId}」？将移入回收站，可在本页底部「回收站」中恢复或彻底删除。</p>
            {delCascadeCount > 0 && (
              <label className="dlg-check">
                <input type="checkbox" checked={cascadeSub} disabled={busy !== null} onChange={(e) => setCascadeSub(e.target.checked)} />
                <span>同时删除它的 {delCascadeCount} 个子代理会话（子代理生命周期跟随父会话）。取消勾选则保留，它们会收进「未归属的子代理会话」卡片，仍可单独处理。</span>
              </label>
            )}
            <div className="dlg-actions">
              <button type="button" className="archv-btn" disabled={busy !== null} onClick={() => setDelTarget(null)}>取消</button>
              <button type="button" className="archv-btn archv-del" disabled={busy !== null} onClick={doDeleteConfirmed}>移入回收站</button>
            </div>
          </div>
        </div>
      )}
      {filter === 'trash' && <section className="dsm-trash" aria-label="回收站">
        <div className="dsm-trash-h">
          <h3>回收站</h3>
          <span className="dsm-trash-count">{trash.length ? `（${trash.length} 个待清理）` : '（空）'}</span>
        </div>
        <div className="sess-tools">
          <div className="sess-field">
            <label htmlFor="dsm-retention">自动清理</label>
            <select id="dsm-retention" value={trashSettings.retentionDays || 0} disabled={trashBusy !== null} onChange={(e) => updateRetention(e.target.value)}>
              <option value="0">不自动清理</option><option value="7">保留 7 天</option><option value="30">保留 30 天</option><option value="90">保留 90 天</option>
            </select>
          </div>
          <div className="sess-field"><label>数据检查</label><button type="button" className="archv-btn" disabled={trashBusy !== null} onClick={verifyTrash}>{trashBusy === '__verify' ? '校验中…' : '校验日志完整性'}</button></div>
          <div className="sess-field"><label>永久清理</label><button type="button" className="archv-btn archv-del" disabled={trashBusy !== null || !trash.length || !canPurge.available} aria-disabled={!canPurge.available} title={!canPurge.available ? canPurge.reason : '物理删除这些日志，释放磁盘空间'} onClick={() => setPurgeTarget('__all')}>清空回收站</button></div>
        </div>
        {!canPurge.available && (
          <div className="archv-empty" role="status">
            {canPurge.reason}。回收站条目会一直保留，可随时恢复；当前 DSH 版本下移入回收站<b>不会释放磁盘空间</b>，会话日志仍完整保留在原工作区目录。
          </div>
        )}
        <div className="dtl-note">回收站是软删除：日志仍留在原工作区目录，「彻底删除」才是真正释放磁盘空间的一步（当前版本未支持时会保持禁用）。</div>
        {trashCheck && <div className={trashCheck.missing ? 'archv-err' : 'archv-empty'} role="status">校验完成：{trashCheck.healthy} 条正常，{trashCheck.missing} 条日志缺失，{trashCheck.unverified || 0} 条无法直接核验。</div>}
        {trash.length === 0 ? (
          <div className="dsm-trash-empty">回收站为空。删除的会话会先进入这里，可恢复或彻底删除。</div>
        ) : (
          <div className="dsm-trash-list">
            {trash.map((t) => (
              <div key={t.sessionId} className="dsm-trash-row">
                <span className="dsm-trash-name" title={t.sessionId}>{t.title || t.sessionId}</span>
                <span className="dsm-trash-date">{fmtDate(t.deletedAt)}</span>
                <span className="dsm-trash-actions">
                  <button type="button" className="archv-btn" disabled={trashBusy !== null || !canRestoreTrash.available} title={!canRestoreTrash.available ? canRestoreTrash.reason : '恢复到删除前的位置与归档状态'} onClick={() => restoreTrash(t.sessionId)}>恢复</button>
                  <button type="button" className="archv-btn archv-del" disabled={trashBusy !== null || !canPurge.available} title={!canPurge.available ? canPurge.reason : undefined} onClick={() => setPurgeTarget(t.sessionId)}>彻底删除</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>}
      {purgeTarget && (
        <div className="dlg-backdrop" onClick={() => setPurgeTarget(null)}>
          <div ref={dialogRef} className="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dsm-purge-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="dsm-purge-title" className="dlg-title">永久删除{purgeTarget === '__all' ? '全部回收站会话' : '这个会话'}？</h3>
            <p className="dlg-text">此操作会物理删除日志并释放磁盘空间，无法恢复。归档、筛选和重新安装插件都不能找回这些数据。</p>
            <div className="dlg-actions">
              <button type="button" className="archv-btn" onClick={() => setPurgeTarget(null)}>取消</button>
              <button type="button" className="archv-btn archv-del" onClick={() => { const target = purgeTarget; setPurgeTarget(null); target === '__all' ? purgeAllTrash() : purgeTrash(target) }}>确认永久删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Main-page sidebar session "⋯" menu augmentation (DOM shim) -----------
// DSH core renders the sidebar session list (dsh-client-ui-workspace) with a
// per-row "⋯" Menu whose items (rename / fork / archive) are hardcoded — there
// is NO plugin slot for adding per-session menu items, and the row DOM carries
// no sessionId. To honor the request we augment the already-opened portalled
// menu via DOM: we watch for a [role="menu"] portalled to document.body whose
// React fiber chain reaches a SessionNodeItem (i.e. it is a session menu), read
// the session id (and current cwd) off that fiber, then clone an existing menu
// item to append "移动会话" / "删除会话". This is intentionally a DOM shim and is
// fragile against DSH UI updates (class names / fiber shape / menu markup).
const SIDEBAR_AUG_CSS = `
.dsm-backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.dsm-dlg{width:min(420px,92vw);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:14px;padding:18px;box-shadow:0 16px 48px rgb(0 0 0/.28);display:flex;flex-direction:column;gap:12px}
.dsm-title{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary);margin:0}
.dsm-text{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0;word-break:break-all}
.dsm-body{display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto}
.dsm-loading,.dsm-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:4px 2px}
.dsm-err{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:4px 2px}
.dsm-opt{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-primary);border-radius:9px;font-size:12.5px;cursor:pointer;text-align:left}
.dsm-opt:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}
.dsm-opt:disabled{opacity:.55;cursor:default}
.dsm-opt-cur{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);color:var(--dsw-alias-state-business-primary)}
.dsm-opt-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dsm-opt-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;margin-left:8px}
.dsm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dsm-btn{appearance:none;min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-subtle);color:var(--dsw-alias-label-secondary);border-radius:9px;font-size:12px;font-weight:500;cursor:pointer}
.dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-del{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dsm-del:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsm-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483601;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);padding:9px 16px;border-radius:999px;font-size:12px;box-shadow:0 8px 24px rgb(0 0 0/.25);max-width:min(92vw,460px);cursor:pointer}
.dsm-toast-long{border-radius:14px;text-align:left;line-height:18px}
.dsm-toast-err{background:#4A1D1D;color:#FFD9D9;border:1px solid var(--dsw-alias-state-error-primary)}
.dsm-sub{position:fixed;z-index:1100;box-sizing:border-box;min-width:190px;max-width:320px;padding:4px;display:flex;flex-direction:column;gap:0;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;box-shadow:var(--dsw-shadow-lv3)}
.dsm-sub-loading,.dsm-sub-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 10px}
.dsm-sub-err{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:6px 10px}
.dsm-sub-item{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:none;border-radius:8px;background:transparent;cursor:pointer;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);text-align:left}
.dsm-sub-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsm-sub-item:disabled{opacity:.5;cursor:default}
.dsm-sub-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-sub-cur{font-size:11px;color:var(--dsw-alias-state-business-primary);flex:none;margin-left:8px}
.dsm-dot{position:absolute;left:6px;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;box-sizing:border-box;cursor:pointer;pointer-events:auto;z-index:1}
.dsm-dot-unread-manual{background:var(--dsw-alias-state-business-primary)}
.dsm-dot-waiting{background:var(--dsw-alias-state-warn-primary,#F59E0B)}
.dsm-dot-unread{background:var(--dsw-alias-state-success-primary)}
.dsm-drag-source{opacity:.48}
.dsm-drop-target{position:relative;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)!important;outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:8px}
.dsm-drop-target::after{content:'移动到这里';position:absolute;right:8px;top:50%;transform:translateY(-50%);padding:1px 6px;border-radius:4px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverted);font-size:10px;font-weight:600;line-height:16px;pointer-events:none}
.dsm-drag-busy{cursor:progress!important}
.dsm-trash{margin-top:18px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:14px}
.dsm-trash-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.dsm-trash-h h3{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.dsm-trash-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsm-trash-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.dsm-trash-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-fill-elevated)}
.dsm-trash-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.dsm-trash-date{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none;white-space:nowrap}
.dsm-trash-actions{display:flex;gap:6px;flex:none}.dsm-trash-actions .archv-btn{min-width:72px}
.dsm-trash-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 2px}
.dsm-storage-sum{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:10px}
.dsm-storage-list{display:flex;flex-direction:column;gap:6px}
.dsm-storage-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-fill-elevated)}
.dsm-storage-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--dsw-alias-label-primary)}
/* v3.18.0：顶部统一导航（全部 / 活动 / 已归档 / 设置 / 回收站）。
   参考样式：一条圆角容器，选中项 = 胶囊底色 + 底部色条，紧凑靠左、不撑满。 */
.dsm-navwrap{margin:0 0 12px;min-width:0}
.dsm-nav{position:relative;display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px;
  max-width:100%;padding:4px;border-radius:12px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 4%)}
.dsm-navglider{position:absolute;top:0;left:0;border-radius:9px;pointer-events:none;
  background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent));
  box-shadow:0 2px 8px rgb(0 0 0 / 12%),inset 0 1px 0 rgb(255 255 255 / 8%);
  transition:transform .3s cubic-bezier(.22,.61,.36,1),width .3s cubic-bezier(.22,.61,.36,1)}
@media (prefers-reduced-motion:reduce){.dsm-navglider{transition:none}}
.dsm-navtab{position:relative;z-index:1;appearance:none;display:inline-flex;align-items:baseline;gap:5px;
  flex:none;padding:6px 13px;border:0;border-radius:9px;background:transparent;
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;font-weight:600;
  white-space:nowrap;cursor:pointer;transition:color .2s ease}
.dsm-navtab:hover{color:var(--dsw-alias-label-primary)}
.dsm-navtab-on{color:var(--dsw-alias-label-primary)}
/* 底部色条：与参考实现同款，选中项的视觉主线。 */
.dsm-navtab-on::after{content:'';position:absolute;left:13px;right:13px;bottom:2px;height:2px;border-radius:2px;
  background:var(--dsw-alias-state-business-primary);opacity:.9}
.dsm-navtab-num{font-variant-numeric:tabular-nums;font-weight:600;font-size:11px;
  color:var(--dsw-alias-label-tertiary)}
.dsm-navtab-on .dsm-navtab-num{color:var(--dsw-alias-label-secondary)}
.dsm-navtab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsm-filter-links{flex-wrap:wrap}
.dsm-storage-bar{flex:0 0 96px;height:6px;border-radius:999px;background:var(--dsw-alias-fill-subtle);overflow:hidden}
.dsm-storage-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary)}
.dsm-storage-size{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap}
.dsm-storage-count{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none;white-space:nowrap;max-width:32%;overflow:hidden;text-overflow:ellipsis}
.maint-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px 14px;margin:0 0 8px}
.maint-group{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.maint-right{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:104px}
/* v3.17.0：面板内设置。顶部只留一个「⚙ 设置」按钮；点开后是**独立整页**
   （.dsm-settings-page），顶部一条分组导航，每页只渲染自己那组内容。
   与参考实现（ofm 插件）同构：导航是 role=tablist，内容是整块切换，不是折叠。 */
.dsm-settings-page{display:flex;flex-direction:column;gap:14px;min-width:0;animation:dsm-page-in .2s cubic-bezier(.16,1,.3,1)}
@keyframes dsm-page-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dsm-settings-page{animation:none}}
/* 导航条：分段控件 + 滑块指示器（与 ofm 插件的设置页同一套做法）。
   滑块用绝对定位 + transform 移动，切换时是横向滑动而不是闪一下。 */
.dsm-settings-nav{position:relative;display:flex;flex-wrap:wrap;gap:2px;padding:4px;border-radius:13px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);min-width:0}
.dsm-settings-glider{position:absolute;top:4px;left:4px;border-radius:9px;pointer-events:none;
  background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 94%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 90%,transparent));
  box-shadow:0 2px 8px rgb(0 0 0 / 14%),inset 0 1px 0 rgb(255 255 255 / 9%);
  transition:transform .3s cubic-bezier(.22,.61,.36,1),width .3s cubic-bezier(.22,.61,.36,1)}
@media (prefers-reduced-motion:reduce){.dsm-settings-glider{transition:none}}
.dsm-settings-tab{position:relative;z-index:1;appearance:none;flex:1 1 auto;min-width:0;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 14px;border:none;border-radius:9px;background:transparent;
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;font-weight:500;
  white-space:nowrap;cursor:pointer;transition:color .2s ease}
.dsm-settings-tab:hover{color:var(--dsw-alias-label-primary)}
.dsm-settings-tab-on{color:var(--dsw-alias-label-primary);font-weight:600}
.dsm-settings-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsm-settings-tab svg{width:14px;height:14px;flex:none;opacity:.85}
.dsm-settings-tab-on svg{opacity:1}
/* 每页的工具行：不再用维护栏的两列 grid，改成可换行的横向排布。 */
.dsm-settings-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;padding:10px 12px;
  border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 85%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
.dsm-settings-tools .maint-group{flex-wrap:wrap;gap:8px}
.dsm-settings-tools:empty{display:none}
.maint-right .archv-btn{white-space:nowrap}
@media (max-width:640px){.maint-bar{display:flex;flex-direction:column;align-items:stretch}.maint-right{flex-direction:row;flex-wrap:wrap;justify-content:flex-start}}
.maint-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mv-sheet-actions{display:flex;align-items:center;gap:6px}
.aa-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.aa-check input{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;flex:none}
/* ---- 血缘分层披露（issue #6）：行内徽标 ---- */
.dsm-lineage-pick{display:flex;flex-direction:column;gap:6px;margin:8px 0}
.dsm-lineage-pick-btn{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px;text-align:left}
.dsm-lineage-pick-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dsm-lineage-sum{font-size:12px;opacity:.75;margin:6px 0;display:flex;align-items:center;gap:6px;overflow:hidden}
.dsm-lineage-tree{display:flex;flex-direction:column;gap:2px;margin:8px 0;max-height:340px;overflow:auto}
.dsm-lineage-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-size:12px;min-height:28px}
.dsm-lineage-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dsm-lineage-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-lineage-kids,.dsm-lineage-size{font-size:11px;opacity:.65;white-space:nowrap}
.dsm-lineage-livechip{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(234,179,8,.18);color:#A16207;white-space:nowrap}
.dsm-lineage-acts{display:flex;gap:4px}
.dsm-kids-badge{appearance:none;display:inline-flex;align-items:center;gap:3px;margin-left:auto;padding:1px 7px;border:none;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;font-weight:600;line-height:15px;cursor:pointer;flex:none;pointer-events:auto}
.dsm-subs{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px 26px;pointer-events:auto}
.dsm-sub-row{display:flex;align-items:center;gap:8px;min-height:24px;padding-right:6px;border-radius:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary);position:relative}
.dsm-sub-row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l2)}
.dsm-sub-row:hover{background:var(--dsw-alias-interactive-bg-hover);cursor:pointer}
.dsm-sub-row:hover .dsm-sub-name{color:var(--dsw-alias-label-primary)}
.dsm-sub-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-sub-meta{flex:none;font-size:10.5px;opacity:.8}
.dsm-sub-live .dsm-sub-meta{color:var(--dsw-alias-state-warning-primary);opacity:1;font-weight:600}
.dsm-sub-acts{display:none;align-items:center;gap:4px;flex:none}
.dsm-sub-row:hover .dsm-sub-acts,.dsm-sub-row:focus-within .dsm-sub-acts{display:inline-flex}
.dsm-sub-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-elevated);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 6px;font:inherit;font-size:10.5px;line-height:16px;cursor:pointer}
.dsm-sub-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dsm-sub-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.dsm-sub-note{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
.dsm-kids-badge:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
/* v3.14.0 后台任务小三角：常驻显示（它就是「这个会话还有活儿在跑」的唯一提示），
   所以不吃 .dsm-kids-badge 那套「悬停才出现」的显隐规则，也不抢 margin-left:auto
   ——它在状态点之后、标题之前，宽度只占一个三角加数字。 */
.dsm-jobs-badge{appearance:none;display:inline-flex;align-items:center;flex:none;pointer-events:auto;margin:0 2px 0 0;padding:0 4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-state-warn-primary,#EAB308);font:inherit;font-size:10px;font-weight:700;line-height:15px;letter-spacing:.5px;cursor:pointer}
.dsm-jobs-badge:hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#EAB308) 16%,transparent)}
.dsm-jobs .dsm-sub-row{cursor:default}
.dsm-jobs .dsm-sub-row:hover{background:transparent}
.dsm-job-age{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsm-row-sub{transform:translateX(calc(10px + var(--dsm-indent,0px)));transition:transform .15s ease}
.dsm-row-sub::before{content:'';position:absolute;left:calc(-6px - var(--dsm-indent,0px));top:0;bottom:0;width:2px;border-radius:1px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent);pointer-events:none}
.dsm-tag{display:inline-flex;align-items:center;margin-left:auto;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-fill-subtle);color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:500;line-height:15px;flex:none;pointer-events:auto;border:none;cursor:default}
.dsm-tag-fork{cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);font-weight:600}
.dsm-tag-fork:hover{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent)}
.dsm-row-flash{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:8px;transition:outline-color .6s ease}
/* 徽标/标签统一显隐（对齐「子代理折叠」的节奏）：默认一律隐藏，维持 DSH
   原生行外观；行被选中（dsm-row-active，paint 按 activeId 刷新）、鼠标悬
   停、键盘聚焦或已展开子代理列表（dsm-row-open）时才出现。display 切换
   不占位：隐藏时标题拿全宽，悬停时才让位给徽标。 */
[role="treeitem"]>.dsm-kids-badge,[role="treeitem"]>.dsm-tag{display:none}
[role="treeitem"]:hover>.dsm-kids-badge,[role="treeitem"]:hover>.dsm-tag,
[role="treeitem"].dsm-row-active>.dsm-kids-badge,[role="treeitem"].dsm-row-active>.dsm-tag,
[role="treeitem"].dsm-row-open>.dsm-kids-badge,
[role="treeitem"]:focus-within>.dsm-kids-badge,[role="treeitem"]:focus-within>.dsm-tag{display:inline-flex}
@media (prefers-reduced-motion:reduce){.dsm-row-sub{transition:none}.dsm-row-flash{transition:none}}
@media (max-width:640px){.dsm-storage-bar{display:none}.dsm-storage-count{max-width:40%}}
`

// Shared status-dot state so the ⋯-menu "标记未读" action can toggle the
// manual flag and trigger a repaint without coupling the two installers.
const DSM_KEY_MANUAL = 'dsm-manual-unread-v1'
let dsmManualUnread = null
let dsmRepaintDots = null
function dsmLoadManual() {
  if (dsmManualUnread) return dsmManualUnread
  try { dsmManualUnread = new Set(JSON.parse(localStorage.getItem(DSM_KEY_MANUAL) || '[]')) } catch (e) { dsmManualUnread = new Set() }
  return dsmManualUnread
}
function dsmSaveManual() { try { localStorage.setItem(DSM_KEY_MANUAL, JSON.stringify([...dsmLoadManual()])) } catch (e) {} }
function dsmToggleManual(id) {
  const s = dsmLoadManual()
  if (s.has(id)) s.delete(id); else s.add(id)
  dsmSaveManual()
  if (dsmRepaintDots) dsmRepaintDots()
}

// ---- 会话右键菜单的「动作层」（v3.16.0）------------------------------------
// 0.2.2（含本机 rc.1）起，宿主的会话菜单改成「数据注册 + portal 渲染」：弹层挂在
// body 下是一棵独立 React 树，fiber 祖先链里没有 SessionNodeItem，靠上溯取
// sessionId 的 DOM 注入因此整段失效（上游 issue #28 同一根因，本机 asar 已核实）。
// 官方给的 ctx.contextMenus.register({ target: 'session' }) 直接把 sessionId 交过来，
// 所以「动作」收敛到这一层：数据注册（新路径）与 DOM shim（旧宿主兜底）共用同一
// 份实现，不再各写一遍——两处各写一份正是这次「三项全没了却没人发现」的成因。
let dsmMenuStyleInjected = false
function dsmMenuEnsureStyle() {
  if (dsmMenuStyleInjected || typeof document === 'undefined' || !document.head) return
  // DOM 那条路径已经注入过同一份样式（dataset.dsm = 'aug'），不要重复插。
  try { if (document.querySelector('style[data-dsm="aug"]')) { dsmMenuStyleInjected = true; return } } catch (e) { /* 查询失败就照常注入 */ }
  try {
    const s = document.createElement('style')
    s.dataset.dsm = 'aug'
    s.textContent = SIDEBAR_AUG_CSS
    document.head.appendChild(s)
    dsmMenuStyleInjected = true
  } catch (e) { /* 注入失败：动作仍可用，只是外观退回宿主默认 */ }
}

function dsmMenuToast(msg) {
  if (typeof document === 'undefined' || !document.body) return
  const t = document.createElement('div')
  const text = String(msg == null ? '' : msg)
  t.className = 'dsm-toast' + (text.length > 28 ? ' dsm-toast-long' : '')
  t.textContent = text
  t.title = '点击关闭'
  t.setAttribute('role', 'status')
  document.body.appendChild(t)
  // 停留时长按字数给（固定 2.6s 读不完排队/失败类文案），并允许点击提前关闭。
  let killTimer = null
  const kill = () => { if (killTimer) clearTimeout(killTimer); t.remove() }
  killTimer = setTimeout(kill, toastDurationFor(text))
  t.addEventListener('click', kill)
}

function dsmOpenDeleteConfirm(id) {
  if (typeof document === 'undefined' || !document.body) return
  dsmMenuEnsureStyle()
  const backdrop = document.createElement('div')
  backdrop.className = 'dsm-backdrop'
  const dlg = document.createElement('div')
  dlg.className = 'dsm-dlg'
  dlg.innerHTML = '<h3 class="dsm-title">删除会话</h3><p class="dsm-text">确认将该会话移入回收站？可在「设置 → 会话管理 → 回收站」中恢复或彻底删除。</p><div class="dsm-actions"><button type="button" class="dsm-btn" data-role="cancel">取消</button><button type="button" class="dsm-btn dsm-del" data-role="ok">移入回收站</button></div>'
  backdrop.appendChild(dlg)
  document.body.appendChild(backdrop)
  const close = () => backdrop.remove()
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  dlg.querySelector('[data-role=cancel]').addEventListener('click', close)
  dlg.querySelector('[data-role=ok]').addEventListener('click', () => {
    close()
    postJSON('/archived-sessions/delete', { sessionId: id })
      .then(() => {
        if (dsmTrashIds) dsmTrashIds.add(String(id))
        if (dsmRepaintDots) dsmRepaintDots()
        dsmMenuToast('已移入回收站')
      })
      .catch((e) => dsmMenuToast('删除失败：' + String((e && e.message) || e)))
  })
}

// 移动时的目标工作区清单。菜单的 resolve 有 1000ms 上限（宿主 resolutionTimeoutMs），
// 里面现拉两个接口必超时，所以这里预热一份快照，resolve 只读内存。
const DSM_MENU_SNAPSHOT_TTL_MS = 15000
let dsmMenuSnapshot = { at: 0, workspaces: [], sessionPath: new Map() }
let dsmMenuSnapshotPending = null
function dsmMenuCachedWorkspaces() { return dsmMenuSnapshot.workspaces }
function dsmMenuCachedPathOf(id) { return dsmMenuSnapshot.sessionPath.get(String(id)) || null }
function dsmMenuRefreshSnapshot(force) {
  const now = Date.now()
  if (!force && dsmMenuSnapshot.at && now - dsmMenuSnapshot.at < DSM_MENU_SNAPSHOT_TTL_MS) return Promise.resolve(dsmMenuSnapshot)
  if (dsmMenuSnapshotPending) return dsmMenuSnapshotPending
  dsmMenuSnapshotPending = (async () => {
    try {
      const [ws, sess] = await Promise.all([
        postJSON('/archived-sessions/workspaces', {}),
        postJSON('/archived-sessions/sessions', {}),
      ])
      const sessionPath = new Map()
      for (const item of (sess && sess.items) || []) {
        if (item && item.sessionId != null && typeof item.workspacePath === 'string') sessionPath.set(String(item.sessionId), item.workspacePath)
      }
      dsmMenuSnapshot = { at: Date.now(), workspaces: (ws && ws.items) || [], sessionPath }
    } catch (e) { /* 拉取失败保留上一份快照，菜单退化为「暂无可用工作区」而不是抛错 */ }
    finally { dsmMenuSnapshotPending = null }
    return dsmMenuSnapshot
  })()
  return dsmMenuSnapshotPending
}

async function dsmMenuMoveTo(id, targetPath, label) {
  try {
    const r = await postActiveAware('/archived-sessions/move', { sessionId: id, targetPath })
    // 会话被 DSH 打开（活跃/未关闭）时服务端只登记排队：磁盘与工作区分组都没动。
    // 无条件报「移动成功」正是 2026-09-10 用户报的那个坑，必须按服务端结果如实说明。
    if (r && r.queued) {
      dsmMenuToast(r.notes && r.notes.length ? r.notes.join(' ') : '会话正被 DSH 打开，已排队待移动；重启 DSH 后会自动完成（请先别打开它）。')
      return
    }
    dsmMenuToast(r && r.already ? `已在「${label}」` : `已移到「${label}」`)
  } catch (e) {
    dsmMenuToast('移动失败：' + String((e && e.message) || e))
  }
}

// Recycle-bin membership (session ids currently in 回收站). The sidebar
// status-dot installer uses this to hide trashed sessions so they don't show
// up under DSH's "未分组" group. Loaded from the backend on a throttle and
// updated optimistically when our own ⋯-menu deletes a session.
let dsmTrashIds = null
// issue #16：回收站按 cwd 的条数（host 随 sidebar-state 下发）。折叠分组下
// 上游把 group.sessions 收回成空数组，展开计数只能靠它来扣掉插件会隐藏的行。
let dsmTrashCountByCwd = null
// v3.12.0 工作区归档（语义 A = 只做可见性）：已折叠的工作区 key 集合。
// 侧栏按 group.cwd 折叠后比对、整组隐藏；面板列表按 item.workspacePath 过滤。
// 只读：写入走 /archived-sessions/workspace-archives。
let dsmArchivedWsKeys = new Set()
// v3.14.0 后台任务：session id → 该会话还在跑的作业行（`{id,label,kind,status,startedAt}`）。
// 由 /archived-sessions/sidebar-state 的 backgroundJobs 字段下发；宿主没有
// jobs/agents 服务时该字段缺失 → 空 Map，整个特性和 3.13.x 一样不存在。
// 用途有二：① 行前小三角（▸ N）表明可展开；② 有活作业的会话即使被标记已读、
// 也继续留在「刚完成」里——这正是用户要解决的「找不到是哪个会话还在后台干活」。
const dsmJobMap = new Map()
// 展开态与子代理分开存：两种列表互不影响，各自的折叠状态要能独立记住。
const DSM_KEY_JOBS = 'dsm-jobs-open-v1'
const dsmJobsOpen = new Set()
if (typeof localStorage !== 'undefined') {
  try { for (const id of JSON.parse(localStorage.getItem(DSM_KEY_JOBS) || '[]')) if (typeof id === 'string') dsmJobsOpen.add(id) } catch (e) { /* 存储不可用：仅本会话内存态 */ }
}
const dsmSaveJobsOpen = () => { try { localStorage.setItem(DSM_KEY_JOBS, JSON.stringify([...dsmJobsOpen])) } catch (e) { /* 无视 */ } }
let dsmServerPurgedIds = new Set()
let dsmAuthoritativeTitles = new Map()
let dsmTrashTick = 0
let dsmCapabilities = null
// 血缘分层披露（issue #6）：服务端血缘分类 + 本地视图状态。
// dsmLineage: id → { origin, parentSession, delegationDepth, empty }
const dsmLineage = new Map()
// v3.6.2：host 预热是否还在途（sidebar-state/sessions 的 warmPending 旗标）。
// 在途 → 侧栏轮询从 32s 台阶收紧到每拍（4s），标题/血缘一补齐就浮现；
// 完成瞬间（true→false）触发一次性回调（面板自动补刷新，见 dsmOnWarmDone）。
// T1（3.7.0）：空白精判并入同一「后台忙闲」信号——两者都落地才算完成，
// 面板只补刷一次（而不是 warm/refine 各刷一遍）。
let dsmWarmPending = false
let dsmRefinePending = false
let dsmTrashRetryTimer = null
const dsmWarmDoneHooks = new Set()
function dsmOnWarmDone(fn) {
  dsmWarmDoneHooks.add(fn)
  return () => dsmWarmDoneHooks.delete(fn)
}
// T2（3.7.0）：排队移动终局通知。已见集合只为本浏览器多 tab 即时去重；服务端
// 保留到 ack（pop 式会被「没弹就关页面」丢通知），ack 失败无害、7 天 TTL 兜底。
const DSM_KEY_SEEN_NOTICES = 'dsm-move-notices-seen-v1'
let dsmSeenNotices = null
function dsmLoadSeenNotices() {
  if (dsmSeenNotices) return dsmSeenNotices
  try { dsmSeenNotices = new Set(JSON.parse(localStorage.getItem(DSM_KEY_SEEN_NOTICES) || '[]').map(String)) } catch (e) { dsmSeenNotices = new Set() }
  return dsmSeenNotices
}
function dsmSaveSeenNotices(set) {
  try { localStorage.setItem(DSM_KEY_SEEN_NOTICES, JSON.stringify([...set].slice(-200))) } catch (e) {}
}
// 通知唯一出口：侧栏通道优先（页面级可见），面板 hook 兜底，都不可用时
// console.warn——宁可吵，不可无声（copy-guard 锁住 moveNotices 只能走这里）。
let dsmNotifySink = null
// 侧栏增强里那些 setInterval 的清算钩子：apply() 注册，dsmTeardownSidebarAug()
// 调用。没有它，停用插件（或 HMR）后 60s 兜底刷新会跟着旧闭包活到页面关闭。
let dsmSidebarCleanup = null
const dsmNoticeHooks = new Set()
function dsmNotify(text, kind) {
  if (!text) return
  if (dsmNotifySink && !sidebarAdapter.disabled) { try { dsmNotifySink(text, kind); return } catch (e) { /* fall through */ } }
  let done = false
  try { for (const fn of dsmNoticeHooks) { fn(text, kind); done = true } } catch (e) {}
  if (!done) { try { console.warn('[dsh-lyin-sessions-manager] ' + text) } catch (e) {} }
}
function dsmOnNotice(fn) { dsmNoticeHooks.add(fn); return () => dsmNoticeHooks.delete(fn) }
// 空白会话一律隐藏（原「纯净视图」的默认行为固化为唯一行为，开关已于
// 0.1.3 移除：上游本就不把空白会话渲染进侧栏，开关没有可服务的场景）。
// 只隐藏，永不删除；子代理行按 DSH 设计不进侧栏（ui-subagent README 明文
// "omitted from the ordinary sidebar"），收纳由上游完成，插件侧不做。
async function dsmLoadCapabilities() {
  try { dsmCapabilities = await postJSON('/archived-sessions/capabilities', {}) } catch (e) { /* unknown stays safely unavailable */ }
  return dsmCapabilities
}
function dsmActionCapability(name, legacy) {
  const source = dsmCapabilities && dsmCapabilities.actions
  return source ? (source[name] || (legacy && source[legacy]) || null) : null
}
async function dsmLoadTrashIds() {
  try {
    const r = await postJSON('/archived-sessions/sidebar-state', {})
    dsmTrashIds = new Set(((r && r.trashedSessionIds) || []).map(String))
    // issue #16：折叠分组的展开计数要用「组内总数 − 本组回收站条数」，
    // 这份按 cwd 的统计由 host 计算后随同一响应下发（老 host 没有该字段 → null）。
    dsmTrashCountByCwd = r && r.trashedCountByCwd && typeof r.trashedCountByCwd === 'object'
      ? new Map(Object.entries(r.trashedCountByCwd).map(([k, v]) => [String(k), Number(v) || 0]))
      : null
    dsmServerPurgedIds = new Set(((r && r.purgedSessionIds) || []).map(String))
    // v3.12.0 工作区归档：host 下发已折叠工作区的折叠键，侧栏按 group.cwd 比对整组隐藏。
    // 旧 host 无该字段 → 空集合，行为与 3.11.x 完全一致。
    const wsKeys = Array.isArray(r && r.archivedWorkspaceKeys) ? r.archivedWorkspaceKeys : []
    dsmArchivedWsKeys = new Set(wsKeys.map((k) => String(k)).filter(Boolean))
    // v3.14.0 后台任务：host 只下发「有活作业的会话」，缺字段即没有。整表替换而非
    // 增量合并——某个会话的作业全结算了，它就该从三角里消失，不留残影。
    dsmJobMap.clear()
    const jobsField = r && r.backgroundJobs && typeof r.backgroundJobs === 'object' ? r.backgroundJobs : null
    if (jobsField) {
      for (const [sid, rows] of Object.entries(jobsField)) {
        if (!Array.isArray(rows) || !rows.length) continue
        dsmJobMap.set(String(sid), rows.filter((row) => row && typeof row === 'object' && row.id))
      }
    }
    // 服务器已确认的乐观标记随即清除；未被确认的标记最多存活到下次刷新，
    // 绝不永久压住后来同 id 的新会话。
    for (const id of [...dsmPendingPurged]) {
      if (dsmServerPurgedIds.has(id)) dsmPendingPurged.delete(id)
    }
    dsmAuthoritativeTitles = new Map(Object.entries((r && r.titles) || {}).map(([id, title]) => [String(id), String(title)]))
    dsmLineage.clear()
    for (const [id, info] of Object.entries((r && r.lineage) || {})) {
      if (info && typeof info === 'object') dsmLineage.set(String(id), info)
    }
    // v3.6.2：预热完成的瞬间广播一次（面板挂自动补刷新；侧栏靠节拍恢复 32s）。
    // T1：旧 host 无 refinePending 字段 → !!undefined===false，节拍/广播语义
    // 与 3.6.2 完全一致（新 client 绝不在旧 host 上疯轮询）。
    const wasBusy = dsmWarmPending || dsmRefinePending
    dsmWarmPending = !!(r && r.warmPending)
    dsmRefinePending = !!(r && r.refinePending)
    if (wasBusy && !(dsmWarmPending || dsmRefinePending)) { try { for (const fn of dsmWarmDoneHooks) fn() } catch (e) { /* hook 出错不断主流程 */ } }
    // T2：投递计划（最多 2 条 + 省略句）——先同步写已见再弹（同浏览器第二个 tab
    // 立刻看不到重复），ack 尽力清理（旧 host 无此路由 → 404 静默）。
    {
      const plan = noticeToastPlan(r && r.moveNotices, dsmLoadSeenNotices(), 2)
      if (plan.ackIds.length) {
        const seen = dsmLoadSeenNotices()
        for (const id of plan.ackIds) seen.add(id)
        dsmSaveSeenNotices(seen)
        dsmNotify(plan.text, plan.kind)
        postJSON('/archived-sessions/pending-moves/notices/ack', { ids: plan.ackIds }).catch(() => {})
      }
    }
    if (dsmRepaintDots) dsmRepaintDots()
  } catch (e) {
    /* keep last known set */
    // v3.6.2 C：失败不再等下一个 32s 台阶——2s 后快速重试一次（已有待重试则跳过）。
    if (dsmTrashRetryTimer == null) {
      dsmTrashRetryTimer = setTimeout(() => { dsmTrashRetryTimer = null; dsmLoadTrashIds() }, 2000)
      if (typeof dsmTrashRetryTimer.unref === 'function') dsmTrashRetryTimer.unref()
    }
  }
  return dsmTrashIds
}

// Permanently-hidden set: sessions the user hard-purged from the 回收站. The
// SERVER is the single source of truth: sidebar-state only reports tombstones
// whose ids are NOT currently present, so a same-id session recreated later is
// unhidden automatically (the tombstone must never permanently suppress a new
// session). dsmPendingPurged only carries this tab's optimistic marks until
// the next server fetch acks them — no localStorage persistence, so a stale
// tombstone can never outlive its server record. (dsmServerPurgedIds is
// declared with the trash-state group above.)
const dsmPendingPurged = new Set()
function dsmLoadPurged() {
  return new Set([...dsmServerPurgedIds, ...dsmPendingPurged])
}
function dsmMarkPurged(ids) {
  ids.forEach((id) => dsmPendingPurged.add(String(id)))
  if (dsmRepaintDots) dsmRepaintDots()
}

// ---- Sidebar injection adapter (versioned, safe-degrading) ----------------
// 每一处脆弱的 DOM / React fiber 识别都收敛到这个 adapter：识别规则集中、
// 可版本化（上游改版时 bump version 并只改这里），并且**可安全降级**——
// 识别连续落空说明上游内部结构变了，此时 adapter 自动停用全部注入，
// 绝不把半残行为强加到官方侧栏上（拖拽 / 标题同步 / 状态圆点一并停用）。
const SIDEBAR_ADAPTER_VERSION = 3
const SIDEBAR_ADAPTER_MAX_MISSES = 200

// 侧栏注入的整场清退：移除我们加到 DSH 侧栏 DOM 里的所有节点（状态圆点 /
// 子代理徽标 / 就地子列表 / fork·空白 tag），并还原被隐藏的空分组。
// 两个调用时机：adapter 因上游结构连续未识别而停用（此刻残留的是「半残」
// 节点，必须整体撤下而不是留在官方侧栏上错位显示），以及插件 effect 卸载。
// 只按自己的 data-dsm-* 标记删除，绝不碰 DSH 自己的节点。
function dsmTeardownSidebarAug() {
  if (typeof dsmSidebarCleanup === 'function') { try { dsmSidebarCleanup() } catch (e) { /* best-effort */ } }
  dsmSidebarCleanup = null
  if (typeof document === 'undefined') return
  const selectors = ['[data-dsm-dot]', '[data-dsm-kids]', '[data-dsm-subs]', '[data-dsm-tag]', '[data-dsm-jobs]', '[data-dsm-jobs-badge]']
  for (const sel of selectors) {
    try { document.querySelectorAll(sel).forEach((el) => el.remove()) } catch (e) { /* best-effort */ }
  }
  try {
    // issue #16：被隐藏的会话行与展开按钮在卸载时还原——adapter 停用（上游
    // 改版）或插件停用后，不能把「看不见的会话」留在官方侧栏上。
    document.querySelectorAll('[data-dsm-hidden]').forEach((row) => {
      row.style.display = ''
      row.removeAttribute('data-dsm-hidden')
    })
    document.querySelectorAll('[data-dsm-overflow-hidden], [data-dsm-overflow-base]').forEach((btn) => {
      // 文案可能被我们改写过：dataset 里存着上游原文，卸载时连文案一起还原。
      const base = btn.getAttribute('data-dsm-overflow-base')
      if (base != null && btn.textContent !== base) btn.textContent = base
      btn.style.display = ''
      btn.removeAttribute('data-dsm-overflow-hidden')
      btn.removeAttribute('data-dsm-overflow-base')
      btn.removeAttribute('data-dsm-overflow-write')
      btn.removeAttribute('data-dsm-overflow-ver')
    })
  } catch (e) { /* best-effort */ }
  try {
    document.querySelectorAll('[data-dsm-group-hidden]').forEach((owner) => {
      owner.style.display = owner.dataset.dsmPrevDisplay || ''
      owner.removeAttribute('data-dsm-group-hidden')
      delete owner.dataset.dsmPrevDisplay
    })
  } catch (e) { /* best-effort */ }
}

function createSidebarAdapter() {
  let disabled = false
  let misses = 0
  const findFiber = (el) => {
    const k = Object.keys(el).find((kk) => kk.startsWith('__reactFiber') || kk.startsWith('__reactInternalInstance'))
    return k ? el[k] : null
  }
  // 识别一行侧栏树节点：返回 { node, group }（会话行 / 工作区标题行）。
  // 两种都没有 = 识别落空，累计到阈值即整体停用。
  const recognize = (row) => {
    const out = { node: null, group: null }
    if (disabled || !row || typeof row !== 'object') return out
    let f = findFiber(row)
    let guard = 0
    while (f && guard++ < 300) {
      const props = f.memoizedProps
      if (props && props.node && typeof props.node === 'object') out.node = props.node
      // DSH 的会话行接收 `node`，工作区标题行（ProjectRowItem）接收 `group`。
      if (props && props.group && typeof props.group === 'object') out.group = props.group
      f = f.return
    }
    if (!out.node && !out.group) {
      if (++misses >= SIDEBAR_ADAPTER_MAX_MISSES && !disabled) {
        disabled = true
        // 停用 = 承认对上游结构失去认知：此刻侧栏上残留的注入节点已经失去
        // 幂等维护（paint 不再跑），必须整体撤下，绝不能把半残行为留在
        // 官方 UI 上。
        dsmTeardownSidebarAug()
        try { console.warn('[dsh-lyin-sessions-manager] 侧栏注入 adapter v' + SIDEBAR_ADAPTER_VERSION + ' 已停用：未识别到已知的 DSH 侧栏节点结构（上游可能已改版）') } catch (e) {}
      }
    } else if (misses > 0) {
      misses = 0
    }
    return out
  }
  // 只取 `group` 的静默识别：命中即停，**不参与 miss 预算**。展开计数的
  // workspace 行识别属非关键路径（拿不到就保持上游原文案），不能让它的落空
  // 把整套侧栏增强熔断；命中即返也省掉继续上溯整条 fiber 链。
  const recognizeGroupQuiet = (row) => {
    if (disabled || !row || typeof row !== 'object') return null
    let f = findFiber(row)
    let guard = 0
    while (f && guard++ < 300) {
      const props = f.memoizedProps
      if (props && props.group && typeof props.group === 'object') return props.group
      f = f.return
    }
    return null
  }
  return {
    version: SIDEBAR_ADAPTER_VERSION,
    get disabled() { return disabled },
    findFiber,
    recognize,
    recognizeGroupQuiet,
  }
}
const sidebarAdapter = createSidebarAdapter()

// apply(ctx) 可能被再次调用（HMR / profile 重载）：用模块级守卫保证观察器、
// 定时器与 document 级监听器只装一份，绝不叠加（叠加会造成重复提示与后台 CPU 增长）。
let sidebarMenuAugInstalled = false
function installSidebarSessionMenuAug(ctx) {
  if (typeof document === 'undefined') return
  if (sidebarMenuAugInstalled) return
  sidebarMenuAugInstalled = true
  const AUG = 'data-dsm-aug'
  let styleInjected = false
  let activeSubClose = null
  let hoverTimer = null

  // Walk the React fiber chain from the portalled menu element up to the
  // SessionNodeItem component, which carries `node.id` (the session id).
  // Portalled menus are one-off surfaces: fiber walking here does NOT count
  // toward the row adapter's miss budget (a non-session menu is normal, not a
  // sign of upstream drift).
  const sessionInfoFromMenu = (menuEl) => {
    let f = sidebarAdapter.findFiber(menuEl)
    let guard = 0
    while (f && guard++ < 300) {
      const p = f.memoizedProps
      if (p && p.node && typeof p.node.id === 'string' && p.node.id) {
        return { id: p.node.id, cwd: p.node.cwd || p.node.workspacePath || null }
      }
      f = f.return
    }
    return null
  }
  const closeMenu = () => {
    try { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) } catch (e) {}
    try { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) } catch (e) {}
  }
  const escapeHtml = (s) => {
    const d = document.createElement('div')
    d.textContent = s == null ? '' : String(s)
    return d.innerHTML
  }
  // v3.16.0：提示 / 删除确认 / 移动都收敛到模块级动作层，数据注册那条路径也调同一份。
  const toast = dsmMenuToast
  const ensureStyle = () => {
    if (styleInjected) return
    const s = document.createElement('style')
    s.dataset.dsm = 'aug'
    s.textContent = SIDEBAR_AUG_CSS
    document.head.appendChild(s)
    styleInjected = true
  }
  const closeMoveSubmenu = () => {
    if (activeSubClose) { const f = activeSubClose; activeSubClose = null; f() }
  }
  const openMoveSubmenu = (moveBtn, info) => {
    ensureStyle()
    closeMoveSubmenu()
    const sub = document.createElement('div')
    sub.className = 'dsm-sub'
    sub.setAttribute('role', 'menu')
    sub.setAttribute('data-dsm-sub', '')
    sub.innerHTML = '<div class="dsm-sub-loading">加载工作区…</div>'
    const r = moveBtn.getBoundingClientRect()
    // Fixed-position card: once the async content renders it can be tall or
    // wide enough to hang past the viewport edges, so re-clamp both anchors
    // against the rendered size.
    const placeSub = () => {
      sub.style.top = Math.max(8, Math.min(Math.round(r.top - 4), window.innerHeight - sub.offsetHeight - 8)) + 'px'
      sub.style.left = Math.max(8, Math.min(Math.round(r.right + 10), window.innerWidth - sub.offsetWidth - 8)) + 'px'
    }
    document.body.appendChild(sub)
    placeSub()
    const closeSub = () => {
      activeSubClose = null
      if (sub.parentNode) sub.remove()
      document.removeEventListener('mousedown', onDocDown, true)
      window.removeEventListener('blur', closeSub)
    }
    const onDocDown = (e) => {
      if (sub.contains(e.target) || moveBtn.contains(e.target)) return
      closeSub()
    }
    // Keep DSH's own outside-click handler from closing the parent menu while
    // the pointer is over our submenu (it lives outside the portalled card).
    sub.addEventListener('mousedown', (e) => e.stopPropagation())
    // Hover bridging: moving from the trigger button across the 10px gap to
    // the submenu must not dismiss it; entering the submenu cancels the
    // pending close timer set on the button's mouseleave.
    sub.addEventListener('mouseenter', () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null } })
    sub.addEventListener('mouseleave', () => { hoverTimer = setTimeout(() => closeSub(), 160) })
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
    window.addEventListener('blur', closeSub)
    activeSubClose = closeSub
    Promise.all([
      postJSON('/archived-sessions/workspaces', {}),
      postJSON('/archived-sessions/sessions', {}),
    ]).then(([ws, sess]) => {
      const items = ws.items || []
      const cur = (sess.items || []).find((x) => x.sessionId === info.id)
      const curPath = cur ? cur.workspacePath : (info.cwd || null)
      if (!items.length) { sub.innerHTML = '<div class="dsm-sub-empty">（暂无可用工作区）</div>'; placeSub(); return }
      sub.innerHTML = ''
      items.forEach((w) => {
        const isCur = !!curPath && w.path === curPath
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'dsm-sub-item'
        b.setAttribute('role', 'menuitem')
        b.disabled = isCur
        const name = document.createElement('span')
        name.className = 'dsm-sub-name'
        name.textContent = w.title || pathName(w.path) || w.workspaceId
        b.appendChild(name)
        if (isCur) {
          const c = document.createElement('span')
          c.className = 'dsm-sub-cur'
          c.textContent = '当前'
          b.appendChild(c)
        }
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          e.preventDefault()
          closeSub()
          closeMenu()
          postActiveAware('/archived-sessions/move', { sessionId: info.id, targetPath: w.path })
            .then((r) => {
              // 会话被 DSH 打开（活跃/未关闭）时服务端只登记排队：磁盘与工作区分组都没动。
              // 这条路径原先无条件报「移动成功」——2026-09-10 用户报的「说移动成功但还在
              // 原工作区」就是这个。必须按服务端结果如实说明。
              const label = w.title || pathName(w.path) || '目标工作区'
              if (r && r.queued) {
                toast(r.notes && r.notes.length ? r.notes.join(' ') : '会话正被 DSH 打开，已排队待移动；重启 DSH 后会自动完成（请先别打开它）。')
                return
              }
              toast(r && r.already ? `已在「${label}」` : `已移到「${label}」`)
            })
            .catch((ee) => toast('移动失败：' + String((ee && ee.message) || ee)))
        })
        sub.appendChild(b)
      })
      placeSub()
    }).catch((e) => {
      sub.innerHTML = '<div class="dsm-sub-err">' + escapeHtml(String((e && e.message) || e)) + '</div>'
      placeSub()
    })
  }
  // v3.16.0：删除确认也收敛到模块级动作层（数据注册那条路径同样调用）。
  const openDeleteConfirm = dsmOpenDeleteConfirm
  const augmentMenu = (menuEl, info) => {
    if (menuEl.querySelector('[' + AUG + ']')) return
    const viewport = menuEl.querySelector('[role="presentation"]') || menuEl.firstElementChild
    if (!viewport) return
    const proto = menuEl.querySelector('[role="menuitem"]')
    if (!proto) return
    const protoWrap = proto.parentElement
    const protoCls = proto.className
    const protoWrapCls = protoWrap ? protoWrap.className : ''
    const ICON_MOVE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4"/><path d="M10 13l2 2 2-2"/></svg>'
    const ICON_DEL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>'
    const ICON_UNREAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>'
    const mk = (label, svg, danger) => {
      const wrap = protoWrap ? protoWrap.cloneNode(false) : document.createElement('div')
      if (protoWrapCls) wrap.className = protoWrapCls
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('role', 'menuitem')
      btn.className = protoCls // same `.item` class DSH uses → identical layout/alignment
      const icon = document.createElement('span')
      icon.style.cssText = 'display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;color:' + (danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)')
      icon.innerHTML = svg
      const lab = document.createElement('span')
      lab.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      lab.textContent = label
      btn.appendChild(icon)
      btn.appendChild(lab)
      if (danger) btn.style.color = 'var(--dsw-alias-state-error-primary)'
      btn.setAttribute(AUG, '')
      wrap.appendChild(btn)
      return { wrap, btn }
    }
    const move = mk('移动会话', ICON_MOVE, false)
    const del = mk('删除会话', ICON_DEL, true)
    const mark = mk(dsmLoadManual().has(info.id) ? '标记已读' : '标记未读', ICON_UNREAD, false)
    const moveCapability = dsmActionCapability('relocateSession') || dsmActionCapability('move')
    if (!moveCapability || !moveCapability.available) {
      move.btn.disabled = true
      move.btn.title = (moveCapability && moveCapability.reason) || '正在检查当前版本的移动能力'
    }
    if (mark.btn.firstChild) mark.btn.firstChild.style.color = 'var(--dsw-alias-state-business-primary)'
    const chev = document.createElement('span')
    chev.style.cssText = 'margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1'
    chev.textContent = '›'
    move.btn.appendChild(chev)
    move.btn.addEventListener('mouseenter', () => {
      if (!document.querySelector('[data-dsm-sub]')) openMoveSubmenu(move.btn, info)
    })
    move.btn.addEventListener('mouseleave', () => {
      hoverTimer = setTimeout(() => closeMoveSubmenu(), 160)
    })
    move.btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault() })
    del.btn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      closeMoveSubmenu()
      openDeleteConfirm(info.id)
    })
    mark.btn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      closeMoveSubmenu()
      dsmToggleManual(info.id)
      closeMenu()
    })
    viewport.appendChild(move.wrap)
    viewport.appendChild(del.wrap)
    // 标记未读 goes to the very top of the menu (above DSH's native items).
    viewport.insertBefore(mark.wrap, viewport.firstElementChild)
    // DSH's portalled Menu clamped its position using the height it measured
    // before this shim injected rows, so the grown card can hang past the
    // viewport bottom and cover the sidebar foot. Reuse the host's own
    // placement by firing the resize event it listens for while open.
    window.dispatchEvent(new Event('resize'))
  }

  const seen = new WeakSet()
  const obs = new MutationObserver(() => {
    if (sidebarAdapter.disabled) return
    // 0.2.2 起宿主把会话菜单交给官方 contextMenus（portal 进 shell.overlay），
    // 这条路已经取不到 sessionId（见文件头的适配层说明）。只有 !menuMode 时才
    // 继续扫 DOM，避免在老宿主之外每开一次菜单都白跑一遍 fiber 上溯。
    if (dsmMenuMode === 'contextMenus') return
    const menus = document.querySelectorAll('body > [role="menu"]')
    menus.forEach((menuEl) => {
      if (seen.has(menuEl)) return
      const info = sessionInfoFromMenu(menuEl)
      if (!info) return // not a session menu (e.g. settings / header dropdown)
      seen.add(menuEl)
      try { augmentMenu(menuEl, info) } catch (e) { /* best-effort DOM shim */ }
      // 真的注入进 DOM 才算「走的是 dom」——仅凭没装 contextMenus 就报 dom，会把
      // 「宿主改版导致两条路都不通」误报成「正常兜底」，那正是这次没被发现的原因。
      if (!dsmMenuMode && menuEl.querySelector('[' + AUG + ']')) dsmMenuReportMode('dom')
    })
  })
  obs.observe(document.body, { childList: true, subtree: false })
  // 实测能用的那条路直接装上；装不上就退回上面那套 DOM shim（旧宿主）。
  installContextMenus(ctx)
}

// ---- 会话右键菜单：官方 contextMenus 数据注册（v3.16.0）--------------------
// 实际启用的通道：'contextMenus'（0.2.2+ 官方数据注册）/ 'dom'（旧版 DOM 注入）/
// null（尚未判定）。随能力探测一并报给 host，用户报「菜单三项不见了」时不必开
// devtools 就能定位走的是哪条路——这次就是靠「三项静默消失」才发现的，所以把
// 通道状态做成可观测字段，而不是只留在代码注释里。
let dsmMenuMode = null
function dsmMenuReportMode(mode) {
  // 归一化后再存：只有这两个值有意义，别把调用点的拼写差异带进上报字段。
  dsmMenuMode = menuChannelOf(mode === 'contextMenus', mode === 'dom')
  if (!dsmMenuMode) return
  try { postJSON('/archived-sessions/capabilities', { menuMode: dsmMenuMode }).catch(() => {}) } catch (e) { /* 诊断字段尽力而为 */ }
}

function installContextMenus(ctx) {
  // 必须走 ctx.inject 等就绪，不能直接 ctx.get：apply 执行时客户端服务常尚未提供，
  // get 拿到 undefined 就会整块跳过（HANDOFF §4.1 的老教训，v0.3.0–v0.3.3 反复栽在这）。
  if (!ctx || typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['contextMenus'], (scope) => {
      try { registerContextMenus(scope, scope.contextMenus) } catch (e) { /* 注册失败退回 DOM shim */ }
    })
  } catch (e) {
    // inject 本身不可用（旧宿主没有该服务）→ 静默返回，DOM shim 继续兜底。
    return false
  }
  return true
}

function registerContextMenus(scope, svc) {
  if (!svc || typeof svc.register !== 'function' || typeof scope.effect !== 'function') return false
  const ctx = scope
  const reg = (input) => {
    try {
      ctx.effect(() => svc.register(input), 'dsm menu: ' + input.id)
      return true
    } catch (e) {
      // 同一个 (target, id) 重复注册会 throw。HMR 下旧 effect 若尚未回收就会走到
      // 这里——绝不能让一条注册失败把另外两条也带下去。
      return false
    }
  }
  // 官方会话项 order：pin 100 / rename 200 / fork 300 / 复制 ID 450 / 归档 600。
  // 标记未读排最前；移动与删除用 afterContent 排进 footer，按危险度递增。
  const okMark = reg({
    id: 'dsm.mark-unread',
    target: 'session',
    order: 50,
    resolve: ({ sessionId }) => {
      const id = String(sessionId)
      return [{ id: 'toggle', label: markUnreadLabel(dsmLoadManual().has(id)), run: () => { dsmToggleManual(id) } }]
    },
  })
  const okMove = reg({
    id: 'dsm.move-session',
    target: 'session',
    order: 700,
    resolve: ({ sessionId }) => {
      const id = String(sessionId)
      const disabled = (reason) => [{
        id: 'move',
        label: '移动会话',
        afterContent: true,
        disabled: true,
        ...(reason ? { failureLabel: reason } : {}),
      }]
      const cap = moveCapabilityOf(dsmCapabilities)
      if (!cap.available) return disabled(cap.reason)
      // resolve 有 1000ms 上限：只读预热好的快照，绝不在里面现拉接口。
      const workspaces = dsmMenuCachedWorkspaces()
      if (!workspaces.length) {
        // 首次打开时快照可能还没热起来：先返一个占位，同时后台预热，下次打开就齐了。
        dsmMenuRefreshSnapshot(true)
        return disabled('正在加载工作区，请再打开一次菜单')
      }
      const targets = moveTargets(workspaces, dsmMenuCachedPathOf(id))
      if (!targets.length) return disabled('没有可移动的目标工作区')
      return [{
        id: 'move',
        label: '移动会话',
        afterContent: true,
        children: targets.map((t) => ({
          id: 'ws:' + t.path,
          label: t.label,
          disabled: t.current,
          failureLabel: '移动失败',
          run: () => { dsmMenuMoveTo(id, t.path, t.label.replace('（当前）', '')) },
        })),
      }]
    },
  })
  const okDel = reg({
    id: 'dsm.delete-session',
    target: 'session',
    order: 800,
    resolve: ({ sessionId }) => [{
      id: 'delete',
      label: '删除会话',
      afterContent: true,
      danger: true,
      run: () => { dsmOpenDeleteConfirm(String(sessionId)) },
    }],
  })
  // 一条都没注册上（例如服务是残桩）→ 不接管，交回 DOM shim。
  if (!okMark && !okMove && !okDel) return false
  dsmMenuEnsureStyle()
  dsmMenuRefreshSnapshot().catch(() => {})
  dsmMenuReportMode('contextMenus')
  return true
}

// Left-side per-session status dot (DOM shim). The color is driven by DSH's
// REAL session status, read from the row's own StateDot ([data-state]):
//   手动标记未读（蓝） = 用户在 ⋯ 菜单或点击圆点手动标记，localStorage 持久化（最高优先级）
//   工作中（黄）       = DSH state 'ongoing'（旧版兼容 'running'）
//   需用户反馈（琥珀） = DSH state 'warning'（有追问需用户反馈）
//   完成后未读（绿）   = DSH state 'done' 且用户尚未读过（read 集合）
//   完成已读（不显示） = DSH state 'done' 且已读过（read 集合持久化）
// 手动未读集合 + read 集合均持久化于 localStorage；打开过即记入 read，绿点不再出现。
// 另外：进入回收站的会话会整行隐藏（不出现在「未分组」里）。
function installSidebarStatusDots() {
  if (typeof document === 'undefined') return
  const DOT = 'data-dsm-dot'
  // issue #16：被插件隐藏的行打标记；展开计数的扣减统计靠它（数据层不可用时兜底）。
  const DSM_HIDDEN_ATTR = 'data-dsm-hidden'
  // 空分组：整组被我们藏起时打在**分组容器**上的标记（见 dsmSyncEmptyGroups）。
  const GROUP_UNIT_ATTR = 'data-dsm-group-hidden'
  // 展开按钮上的数据集：上游原文（基线）、上次写入值、口径版本、是否被我们藏起。
  const DSM_OVERFLOW_BASE = 'data-dsm-overflow-base'
  const DSM_OVERFLOW_WRITE = 'data-dsm-overflow-write'
  const DSM_OVERFLOW_VER = 'data-dsm-overflow-ver'
  const DSM_OVERFLOW_HIDDEN = 'data-dsm-overflow-hidden'
  let overflowDebugged = false
  const debugOverflowOnce = (msg) => {
    if (overflowDebugged) return
    overflowDebugged = true
    try { console.debug('[dsh-lyin-sessions-manager] 展开计数：' + msg) } catch (e) { /* 控制台不可用 */ }
  }
  // 展开按钮的文案基线 / 上次写入值存在 dataset（而非 WeakMap）：HMR / 插件
  // 重装后新闭包里 WeakMap 是空的，会把「已扣减的文案」再当上游原文扣一次；
  // dataset 跟随节点存活，卸载时还能据此还原原文案。data-dsm-* 不在
  // MutationObserver 的 attributeFilter 里，不会自触发重绘。
  if (!document.querySelector('style[data-dsm=aug]')) {
    const s = document.createElement('style')
    s.dataset.dsm = 'aug'
    s.textContent = SIDEBAR_AUG_CSS
    document.head.appendChild(s)
  }
  const rowNode = (row) => sidebarAdapter.recognize(row).node
  const rowId = (row) => { const node = rowNode(row); return node ? node.id : null }
  let curActive = null
  const activeRowId = () => {
    const sel = document.querySelector('[role="treeitem"][aria-selected="true"]')
    return sel ? rowId(sel) : null
  }
  // Dot colors per the user's scheme. We read DSH's REAL session status from the
  // row's own StateDot (its [data-state] attr) and recolor it:
  //   ongoing/running → 黄  工作中
  //   warning  → 琥珀 有追问需用户反馈
  //   done     → 绿  完成后未读（读过则不再显示）
  //   error    → 红  出错/需关注（与 DSH 自带 StateDot 一致）
  //   (manual  → 蓝  手动标记未读，最高优先级)
  const manualUnread = dsmLoadManual()
  // v3.6.2 #2：原 WeakSet「首绘一次即终身免改」升级为 WeakMap 所有权记录
  // row → { id, text, authoritative }。权威标题**后到**时回填仍由我们持有文本的
  // 行；官方（重命名等）改写文本后所有权移交，绝不覆盖 DSH Core 的实时更新。
  const titleBaselines = new WeakMap()
  // 空分组兜底：DSH 会把「日志已不在原处」的会话重新归到「未分组」组里（删
  // 除后最明显）。我们把行隐藏了，但空组标题会留下来——所以组内没有**可能
  // 出现**的会话时，把整个分组容器一起隐藏；重新出现时自动还原。
  //
  // 容器定位：各版本的顶层分组容器都没有稳定的 role/class —— `role="group"`
  // 从 0.1.7 到 0.2.1 只出现在**子分组**容器上（一个包着整段子分组的 div），
  // 顶层分组是无 role 的普通 div（`groupSection`）。所以以
  // `data-row-key="workspace:*"`（0.1.7 起稳定）为锚点，取它的父元素当容器：
  // 本组的会话行与展开按钮都是这个容器的子节点。
  //
  // 判定走数据层（与展开计数同一口径）：只有 group.sessions 里「非空白、且
  // 不在回收站/墓碑/空白集合」的条数确实为 0 才藏。只看 DOM 会把「上游折叠
  // 后还没渲染出来的可见会话」误判成空组，连标题带展开按钮一起藏掉——那些
  // 会话就再也点不到了。
  //
  // 原 display 记在容器的 dataset 上（而不是 WeakMap）：还原路径无法遍历
  // WeakMap，dataset 让「谁被我们藏过、原来是什么」随时可查可还原。
  const setGroupHidden = (scope, hidden) => {
    if (hidden) {
      if (!scope.hasAttribute(GROUP_UNIT_ATTR)) {
        scope.dataset.dsmPrevDisplay = scope.style.display || ''
        scope.setAttribute(GROUP_UNIT_ATTR, '')
      }
      if (scope.style.display !== 'none') scope.style.display = 'none'
      return
    }
    if (!scope.hasAttribute(GROUP_UNIT_ATTR)) return
    const prev = scope.dataset.dsmPrevDisplay || ''
    if (scope.style.display !== prev) scope.style.display = prev
    scope.removeAttribute(GROUP_UNIT_ATTR)
    delete scope.dataset.dsmPrevDisplay
  }
  // 元素自身到 stopAt（不含）之间有没有被藏起来。只看我们自己的两处标记与
  // style.display：不碰 getComputedStyle（每帧调用的代价太高）。
  const isShownWithin = (el, stopAt) => {
    let node = el
    while (node && node !== stopAt) {
      if (node.style && node.style.display === 'none') return false
      if (node.hasAttribute && (node.hasAttribute(GROUP_UNIT_ATTR) || node.hasAttribute(DSM_HIDDEN_ATTR))) return false
      node = node.parentElement
    }
    return true
  }
  // issue #16 补丁：本组「会话行」的收集器。
  //
  // 原先各处一律按 `scope.children` 找会话行，隐含假设「上游把 `[role=treeitem]`
  // 直接放在分组容器下」。在 0.2.1-rc.2 的侧栏里这个假设不成立：上游把每个会话行
  // 包进一层 `<span class="_root_*">` 再放进 `groupSection`，于是 `children` 拿到
  // 的全是 SPAN（没有 role、没有 data-row-key）。
  //
  // 后果不是「少算几个数」，而是整段校准被短路：`rendered` 恒为空 → 命中
  // 「DOM 里没有会话行」的保护分支直接 return → 按钮上的 data-dsm-* 一个都不写、
  // 计数永远不校准。用户看到的就是「点了展开没反应」或数字与实际不符。
  //
  // 因此改为：先按直接子节点找；一个都没找到时，再向下找（wrapper），
  // 仍要求命中 `[role=treeitem][data-row-key^="session:"]`，且不跨越嵌套子分组。
  const groupSessionRows = (scope, btn) => {
    const out = []
    if (!scope || !scope.children) return out
    for (const el of scope.children) {
      if (el === btn || !el.getAttribute) continue
      const k = el.getAttribute('data-row-key') || ''
      if (el.getAttribute('role') === 'treeitem' && k.startsWith('session:')) out.push(el)
    }
    if (out.length) return out
    // wrapper 结构兜底：只在「直接子节点没有会话行」时启用，避免与上一种形态重复计数。
    let rows = null
    try {
      rows = scope.querySelectorAll('[role="treeitem"][data-row-key^="session:"]')
    } catch (e) { return out }
    for (const el of rows) {
      // 跳过属于嵌套子分组的行：它最近的分组容器不是本 scope。
      let owner = el.parentElement
      let ok = true
      while (owner && owner !== scope) {
        if (owner.getAttribute && owner.getAttribute('role') === 'group') { ok = false; break }
        owner = owner.parentElement
      }
      if (ok) out.push(el)
    }
    return out
  }
  // 分组容器定位：从工作区标题行向上找「无 role 的普通容器」（顶层分组的
  // groupSection）。上游可能把标题行包在 wrapper span 里，因此不能只取
  // parentElement —— 那会拿到 SPAN，使空分组判定整段失效。
  const groupContainerOf = (row) => {
    let el = row ? row.parentElement : null
    for (let depth = 0; el && depth < 4; depth++) {
      if (typeof el.getAttribute !== 'function') return null
      // role="group" 是子分组容器，role="tree" 是列表根，都不能当顶层组容器。
      if (!el.getAttribute('role')) return el
      el = el.parentElement
    }
    return null
  }
  function dsmSyncEmptyGroups(purgedNow) {
    let rows = null
    try { rows = document.querySelectorAll('[role="treeitem"][data-row-key^="workspace:"]') } catch (e) { return }
    if (!rows || !rows.length) return
    const purged = purgedNow instanceof Set ? purgedNow : new Set()
    // 被插件藏起来的 id 集合只在真的需要判定时建一次（绝大多数帧用不到）。
    let hiddenIds = null
    const hiddenIdSet = () => {
      if (hiddenIds) return hiddenIds
      hiddenIds = new Set()
      if (dsmTrashIds) for (const id of dsmTrashIds) hiddenIds.add(id)
      for (const id of purged) hiddenIds.add(id)
      for (const [id, info] of dsmLineage.entries()) if (info && info.empty) hiddenIds.add(id)
      return hiddenIds
    }
    rows.forEach((row) => {
      try {
        // 容器必须是无 role 的普通元素（顶层分组）。子分组容器 role="group"
        // 里装的是整段子分组，不能当组容器用——拿它当容器会把整段子分组藏掉。
        // 上游把标题行包在 wrapper span 里时 parentElement 不是组容器，
        // 因此向上找到真正的 groupSection（见 groupContainerOf）。
        const scope = groupContainerOf(row)
        if (!scope || scope === document.body) return
        // v3.12.0 工作区归档：整组折叠优先于其它判定——用户显式归档了这个工作区，
        // 就整组藏起来（含仍在渲染的行）。恢复走面板「工作区归档」里的恢复按钮。
        const group = sidebarAdapter.recognizeGroupQuiet(row)
        if (dsmArchivedWsKeys.size) {
          const cwd = group && typeof group.cwd === 'string' ? group.cwd : null
          const key = cwd ? workspaceKeyOf(cwd) : ''
          if (key && dsmArchivedWsKeys.has(key)) { setGroupHidden(scope, true); return }
        }
        // 组内还有没被我们藏起来的会话行 → 绝不藏（也顺手还原）。
        // 行可能被上游包在 wrapper span 里（见 groupSessionRows 的说明），
        // 因此用收集器而不是直接遍历 scope.children。
        let rendered = 0
        for (const el of groupSessionRows(scope, row)) {
          if (el.hasAttribute(DSM_HIDDEN_ATTR)) continue
          rendered++
        }
        if (rendered > 0) { setGroupHidden(scope, false); return }
        // 容器里可能还挂着子分组（上游把嵌套工作区渲染在 role="group" 的
        // div 里）。只要还有子分组对用户可见，就绝不能藏父容器——那会把整
        // 段子分组一起带走。
        for (const nested of scope.querySelectorAll('[data-row-key^="workspace:"]')) {
          if (nested === row) continue
          if (!isShownWithin(nested, scope)) continue
          setGroupHidden(scope, false)
          return
        }
        // 渲染行全被我们藏了（或一行都没渲染）：只有数据层能证明「真空」才藏。
        // 拿不到 group.sessions / 数组为空 = 不知道 → 按非空处理，保持显示。
        const sessions = group && Array.isArray(group.sessions) ? group.sessions : null
        // v0.7.0（吸收上游 PR #20）：当前会话就在本组时绝不藏——上游只为它渲染
        // 一条 blank 行，而插件把 blank 行一律隐藏，按存活数判空会把正在用的
        // 工作区连标题和「+」一起藏掉。
        setGroupHidden(scope, shouldHideEmptyGroup(
          aliveSessionCount(sessions, hiddenIdSet()),
          group != null && group.containsCurrent === true,
        ))
      } catch (e) { /* 单组失败不影响其它组 */ }
    })
  }
  // issue #16：「展开其余 N 个会话」的 N 是上游按数据层算的（0.2.0-rc.2 叫
  // collapsedSessionRows，0.2.1-rc.2 改叫 watermarkRows），它看不到插件用
  // display:none 藏起来的回收站/空白行，于是 N 虚高；点开只是把更多已隐藏行
  // 塞进 DOM，画面不动，很像「会话丢了」。
  //
  // 只改**文案与显隐**，不碰上游的展开状态机（watermark / 点击行为），也不改
  // 任何行自身的可见性判定。
  //
  // 口径（F1）：上游 N 是「水位线之外未渲染的行数」，和「整组被插件藏起来的
  // 行数」不重叠，相减会重复扣减、点开一次就翻负，把仍有可见行的按钮藏掉
  // （上游只有这一个展开入口 → 会话不可达）。这里改用
  //   还能出现几行 = 本组可见总数（非 blank、且不会被插件藏）- 已渲染可见行数
  // 空白行两边都排除（F2）：上游 watermarkRows 里 `if (session.blank) return true`
  // —— 空白行永远保留、从不计入 N。
  //
  // 数据层拿不到 group.sessions 时**什么都不改**（F6）：DOM 兜底在数学上不成立，
  // 写一个看起来合理却会算错的数比不改更糟。
  const OVERFLOW_SIGS = new WeakMap()
  // 签名只看「便宜且能反映变化」的量：本组已渲染可见会话行（数量 + 首尾 id）、
  // 按钮自身文案与显隐、三个集合的大小。流式输出时 paint 每帧都跑，但侧栏结构
  // 绝大多数帧没变 —— 命中签名就直接跳过 fiber 走链（F4）。
  const overflowSignature = (scope, btn, purgedNow) => {
    let n = 0
    let firstKey = ''
    let lastKey = ''
    for (const el of groupSessionRows(scope, btn)) {
      if (el.hasAttribute(DSM_HIDDEN_ATTR)) continue
      n++
      const k = el.getAttribute('data-row-key') || ''
      if (!firstKey) firstKey = k
      lastKey = k
    }
    return n + '|' + firstKey + '|' + lastKey + '|' + (btn.textContent || '') + '|' + (btn.style.display || '') +
      '|' + (dsmTrashIds ? dsmTrashIds.size : -1) + '|' + purgedNow.size + '|' + dsmLineage.size
  }
  function dsmSyncOverflowLabels(purgedNow) {
    let buttons = null
    try { buttons = document.querySelectorAll('[data-row-key^="overflow:"]') } catch (e) { return }
    if (!buttons || !buttons.length) return
    try {
      buttons.forEach((btn) => {
        // 工作区标题行与本组的会话行同属一个 groupSection（上游 renderGroup 的
        // 直接子节点；子分组在另一个 role=group 容器里）→ 只按直接子节点找，
        // 不再做全文档属性前缀扫描。
        const scope = btn.parentElement
        if (!scope || !scope.children) return
        const sig = overflowSignature(scope, btn, purgedNow)
        if (OVERFLOW_SIGS.get(btn) === sig) return
        const key = (btn.getAttribute('data-row-key') || '').slice('overflow:'.length)
        // 工作区标题行：先按直接子节点找；上游 0.2.1-rc.2 把它也包进 wrapper 时
        // 再向下找一层（与 groupSessionRows 同一套兜底思路）。
        const wsKey = 'workspace:' + key
        let wsRow = null
        for (const el of scope.children) {
          if (el.getAttribute && el.getAttribute('data-row-key') === wsKey) { wsRow = el; break }
        }
        if (!wsRow) {
          try {
            wsRow = scope.querySelector('[data-row-key="' + wsKey.replace(/"/g, '\\"') + '"]')
          } catch (e) { wsRow = null }
        }
        const group = wsRow ? sidebarAdapter.recognizeGroupQuiet(wsRow) : null
        const nodes = group && Array.isArray(group.sessions) ? group.sessions : null
        if (!nodes) {
          // 数据层不可用：还原成上游原文案并放开按钮，绝不猜数字。
          restoreOverflowButton(btn)
          OVERFLOW_SIGS.set(btn, overflowSignature(scope, btn, purgedNow))
          return
        }
        // 分组折叠时上游把 `sessions` 收回成空数组（`expanded ? [...].map(...) : []`），
        // 所以「空数组」不等于「这组没有会话」。若照旧走下面的空集保护，折叠态的
        // 分组永远不会被校准 —— 而展开按钮本身就只在折叠态出现，等于整段逻辑永久失效。
        //
        // 上游同时给了 `sessionCount`（= 组内会话总数，与展开状态无关），用它来判定：
        // 到底是真的没会话，还是只是还没展开。注意 `sessionCount` 已过上游的
        // `sessionVisible` 过滤（排除 archived 与空白会话），但仍可能包含本插件
        // 软删到回收站、尚未从会话列表摘掉的条目 —— 所以算可见数时要再扣一次。
        const groupCount = group && typeof group.sessionCount === 'number' ? group.sessionCount : null
        const collapsed = !nodes.length && groupCount != null && groupCount > 0
        // 本组「上游会列出、且不会被插件藏起来」的会话集合。
        const ids = new Set()
        for (const node of (nodes && nodes.length ? nodes : [])) {
          if (!node || node.blank) continue
          const id = node.id != null ? String(node.id) : ''
          if (!id) continue
          if ((dsmTrashIds && dsmTrashIds.has(id)) || purgedNow.has(id)) continue
          const li = dsmLineage.get(id)
          if (li && li.empty) continue
          ids.add(id)
        }
        // 已渲染进 DOM 的可见行：本组会话行里不在隐藏标记中的那些。
        // 用 `data-dsm-hidden` 而非 style.display 判定——上游折叠父级时行自身
        // 的 display 仍是空串，按 style 判会把看不见的行算成已渲染。
        const rendered = []
        for (const el of groupSessionRows(scope, btn)) {
          const k = el.getAttribute('data-row-key') || ''
          rendered.push({ id: k.slice('session:'.length), pluginHidden: el.hasAttribute(DSM_HIDDEN_ATTR) })
        }
        // 空集/口径不匹配的保护：数据层说「一条都没有」但 DOM 里明明有会话行，
        // 说明 group.sessions 的语义变了（懒加载、上游又换了过滤条件）。此时按
        // 未知处理，绝不能算出 0 把按钮藏掉 —— 那是把可见会话变成不可达。
        // 折叠态（collapsed）不算「空集」：那是上游把 sessions 收回的正常表现，
        // 继续走下面的计数分支，否则展开按钮永远得不到校准。
        if (!nodes.length && !collapsed) {
          restoreOverflowButton(btn)
          OVERFLOW_SIGS.set(btn, overflowSignature(scope, btn, purgedNow))
          return
        }
        if (!ids.size && rendered.length) {
          restoreOverflowButton(btn)
          OVERFLOW_SIGS.set(btn, overflowSignature(scope, btn, purgedNow))
          return
        }
        // 折叠态：上游把 `group.sessions` 收回成空数组，而展开按钮正是这时候
        // 出现的 —— 也就是说「数据层拿不到成员」和「按钮需要校准」同时发生，
        // 旧实现于是在这里直接 return，展开计数永远得不到校准（issue #16 的
        // 「点开没反应 / 数字不动」就是这么来的）。
        //
        // 折叠时不再依赖成员 id，改用两条与展开状态无关的信息：
        //   1) `group.sessionCount` —— 组内会话总数（上游按工作区统计）；
        //   2) `dsmTrashCountByCwd` —— host 下发的「本工作区回收站条数」。
        // 两者相减即为展开后实际会出现的行数；折叠时 DOM 里没有会话行，
        // 已渲染可见数按 0 计。
        if (collapsed) {
          const wsCwd = group && typeof group.cwd === 'string' ? group.cwd : null
          const trashInGroup = wsCwd != null && dsmTrashCountByCwd ? (dsmTrashCountByCwd.get(wsCwd) || 0) : null
          const visibleTotal = collapsedVisibleTotal(groupCount, trashInGroup)
          if (visibleTotal == null) {
            // 老 host / 拿不到 cwd：不猜数字，保持上游原文案。
            restoreOverflowButton(btn)
            OVERFLOW_SIGS.set(btn, overflowSignature(scope, btn, purgedNow))
            return
          }
          const more = remainingRows(visibleTotal, 0)
          applyOverflowPlan(btn, more, '折叠 总数 ' + groupCount + ' / 回收站 ' + trashInGroup)
          OVERFLOW_SIGS.set(btn, overflowSignature(scope, btn, purgedNow))
          return
        }
        const renderedVisible = countRenderedVisible(rendered, ids)
        const more = remainingRows(ids.size, renderedVisible)
        applyOverflowPlan(btn, more, '可见 ' + ids.size + ' / 已渲染 ' + renderedVisible)
        OVERFLOW_SIGS.set(btn, overflowSignature(scope, btn, purgedNow))
      })
    } catch (e) {
      // 非关键路径：失败就保持上游原样，不影响本次 paint 的其它注入（F5）。
      try { console.debug('[dsh-lyin-sessions-manager] 展开计数校准跳过：' + (e && e.message)) } catch (e2) {}
    }
  }
  // 把计划落到按钮上：文案基线 / 上次写入值 / 口径版本都记在 dataset
  // （F8：跨版本残留的旧基线不会延续到下个版本），HMR 重装后也不会二次处理。
  function applyOverflowPlan(btn, more, detail) {
    const raw = btn.textContent || ''
    const ver = String(SIDEBAR_ADAPTER_VERSION)
    const fresh = btn.getAttribute(DSM_OVERFLOW_VER) === ver
    const last = fresh ? btn.getAttribute(DSM_OVERFLOW_WRITE) : null
    let baseline = fresh ? btn.getAttribute(DSM_OVERFLOW_BASE) : null
    // 首次见到，或上游重渲染换了文案（含点击展开后的新 N）→ 以当前文案为新基准。
    if (baseline == null || raw !== last) baseline = raw
    btn.setAttribute(DSM_OVERFLOW_BASE, baseline)
    btn.setAttribute(DSM_OVERFLOW_VER, ver)
    // F3：上游 N 藏在基线文案里。若我们算出的「还能出现几行」反而比上游 N 大，
    // 说明数据层与 DOM 的口径已经不一致（上游改了 group.sessions 的过滤语义、
    // 或将来插件改用官方归档 API）——收敛回上游 N 并留一条 debug，把「静默
    // 失效」变成可观测。注意必须用**基线**里的 N：当前文案可能是我们写过的值。
    const bm = baseline.match(/(\d[\d,]*)/)
    const upstream = bm ? Number(bm[1].replace(/,/g, '')) : null
    if (more != null && upstream != null && upstream > 0 && more > upstream) {
      more = upstream
      debugOverflowOnce((detail || '') + '，超过上游计数 ' + upstream + '，已按上游计数收敛')
    }
    const plan = overflowPlan(baseline, more)
    if (plan.hide) {
      if (btn.style.display !== 'none') btn.style.display = 'none'
      if (!btn.hasAttribute(DSM_OVERFLOW_HIDDEN)) btn.setAttribute(DSM_OVERFLOW_HIDDEN, '')
      btn.setAttribute(DSM_OVERFLOW_WRITE, baseline)
      return
    }
    if (btn.hasAttribute(DSM_OVERFLOW_HIDDEN)) {
      btn.style.display = ''
      btn.removeAttribute(DSM_OVERFLOW_HIDDEN)
    }
    if (plan.changed) {
      // 同值不写：写入会触发 characterData 观察 → 重绘，必须保持幂等。
      if (btn.textContent !== plan.text) btn.textContent = plan.text
      btn.setAttribute(DSM_OVERFLOW_WRITE, plan.text)
    } else {
      if (btn.textContent !== baseline) btn.textContent = baseline
      btn.setAttribute(DSM_OVERFLOW_WRITE, baseline)
    }
  }
  function restoreOverflowButton(btn) {
    const verbatim = btn.getAttribute(DSM_OVERFLOW_BASE)
    if (verbatim != null && btn.textContent !== verbatim) btn.textContent = verbatim
    if (btn.hasAttribute(DSM_OVERFLOW_HIDDEN)) {
      btn.style.display = ''
      btn.removeAttribute(DSM_OVERFLOW_HIDDEN)
    }
  }
  const paint = () => {
    if (sidebarAdapter.disabled) return
    // Recompute the active session on every paint so the active row is never
    // shown from a stale `curActive` (the click that changes aria-selected
    // mutates the DOM and triggers paint immediately, before the tick()
    // would have run — without this, the clicked session flashed green).
    const activeId = activeRowId()
    // Clicking into a manually-marked session auto-clears the manual unread
    // flag (it becomes read on open) — only on the active transition, so a
    // flag set while already viewing it isn't wiped until you re-enter it.
    if (activeId !== curActive && activeId) {
      if (manualUnread.has(activeId)) {
        manualUnread.delete(activeId)
        dsmSaveManual()
      }
      // v0.2.8：进入会话 = 用户亲眼确认了它的终态 → ①删面板条目；②清 runSeen，
      // 否则状态机会永远把它判成「刚完成」。这是状态机的正确复位点。
      // 注意：若该会话正在 running，下一拍 paint 会重新 add runSeen 并登记为
      // running——语义正确（正在跑的就该出现在「进行中」）。
      quickAccessRegistry.delete(String(activeId))
      dsmRunSeen.delete(String(activeId))
      dsmTurnKind.delete(String(activeId))
    }
    curActive = activeId
    // 每次 paint 只聚合一次：父会话 id → 子代理数（O(n)，避免每行重算）。
    const purgedNow = dsmLoadPurged()
    const kidsByParent = (() => {
      const m = new Map()
      for (const [id, info] of dsmLineage.entries()) {
        if (info.origin !== 'subagent' || !info.parentSession) continue
        // 已进回收站 / 已彻底删除的子代理不计数：否则删掉了徽标数字还挂着。
        if ((dsmTrashIds && dsmTrashIds.has(id)) || purgedNow.has(id)) continue
        m.set(info.parentSession, (m.get(info.parentSession) || 0) + 1)
      }
      return m
    })()
    const rows = document.querySelectorAll('[role="treeitem"]')
    // 兜底清理：父行被 React 移除 / 复用后残留的子代理容器立刻摘掉，
    // 避免孤儿容器越堆越多。
    document.querySelectorAll('[data-dsm-subs]').forEach((box) => {
      const pid = box.getAttribute('data-dsm-subs')
      const prev = box.previousElementSibling
      if (!prev || rowId(prev) !== pid) box.remove()
    })
    rows.forEach((row) => {
      const id = rowId(row)
      if (!id) return
      // Trashed sessions belong in 回收站, not the sidebar (DSH would group
      // them under "未分组"). Hide the row entirely and skip its dot. So do
      // hard-purged sessions — they're gone for good and must never resurface
      // (otherwise DSH re-renders the orphan under a "未分组" group).
      const purged = purgedNow
      if ((dsmTrashIds && dsmTrashIds.has(id)) || purged.has(id)) {
        if (row.style.display !== 'none') row.style.display = 'none'
        // issue #16：标记「这一行是插件隐藏的」，供展开计数扣减使用（数据层
        // 拿不到 group.sessions 时也能按 DOM 兜底统计）。属性不进 observer 的
        // attributeFilter，不会自触发重绘。
        if (row.getAttribute(DSM_HIDDEN_ATTR) !== 'trash') row.setAttribute(DSM_HIDDEN_ATTR, 'trash')
        const d = row.querySelector('[' + DOT + ']'); if (d) d.remove()
        quickAccessRegistry.delete(String(id)) // 行被隐藏：从快捷面板移除
        dsmDropSubList(row, id)
        dsmDropJobList(row, id)
        return
      }
      // ---- 血缘分层披露（issue #6）--------------------------------------
      // 优先级：回收站/墓碑隐藏 > 纯净视图隐藏（仅空白行） > 原生显示。
      // 子代理行按 DSH 设计不进侧栏（ui-subagent README 明文）；万一上游
      // 改回渲染，这里只做缩进视觉、绝不隐藏——侧栏没有展开入口，藏了
      // 就再也找不回来。
      const li = dsmLineage.get(id)
      const isSub = !!(li && li.origin === 'subagent')
      const isEmpty = !!(li && li.empty)
      // React 会复用行 DOM：每次先按当前 id 重置血缘视觉，再按需加回。
      // classList 的 add/remove 对已处于目标状态的行是无操作（不触发
      // MutationObserver），徽标节点只允许「缺失才创建」。
      row.classList.remove('dsm-row-sub')
      // 选中行标记：徽标/标签的「选中才显示」靠它驱动（CSS 侧）。
      // toggle 同值时不动 DOM 属性，不会触发 MutationObserver。
      row.classList.toggle('dsm-row-active', id === activeId)
      row.style.removeProperty('--dsm-indent')
      let hideLineage = false
      if (li && isSub) {
        row.classList.add('dsm-row-sub')
        if (getComputedStyle(row).position === 'static') row.style.position = 'relative'
        const depth = Math.max(0, (li.delegationDepth || 1) - 1)
        if (depth > 0) row.style.setProperty('--dsm-indent', String(depth * 10) + 'px')
      } else if (li && isEmpty) {
        // 空白行一律隐藏（原纯净视图行为固化，见 dsmLineage 注释）。
        hideLineage = true
      }
      if (hideLineage) {
        if (row.style.display !== 'none') row.style.display = 'none'
        if (row.getAttribute(DSM_HIDDEN_ATTR) !== 'empty') row.setAttribute(DSM_HIDDEN_ATTR, 'empty')
        const d = row.querySelector('[' + DOT + ']'); if (d) d.remove()
        quickAccessRegistry.delete(String(id)) // 行被隐藏：从快捷面板移除
        dsmDropSubList(row, id)
        dsmDropJobList(row, id)
        return
      }
      if (row.style.display === 'none') row.style.display = ''
      // 行重新可见（已从回收站恢复 / 空白状态消失）：摘掉隐藏标记，展开计数
      // 立刻把这一条还回「可展开」的数量里。
      if (row.hasAttribute(DSM_HIDDEN_ATTR)) row.removeAttribute(DSM_HIDDEN_ATTR)
      if (!isEmpty && li && li.parentSession && li.origin !== 'subagent') {
        // fork 分支行：绿「⑂ 分支」chip，点击滚动并高亮父会话行。
        // v3.6.2 #3：chip 每次 paint 幂等同步（存在才不建，但 tooltip/父 id
        // 随最新权威数据刷新）——旧实现「创建即定格」，父标题后到时 tooltip
        // 永远停在降级文案；点击改读 dataset，React 复用行 DOM 也不会切错父。
        const parentTitle = dsmAuthoritativeTitles.get(li.parentSession)
        const tip = parentTitle ? '分支于：' + parentTitle : '分支会话（点击查看来源会话）'
        let fork = row.querySelector('[data-dsm-tag="fork"]')
        if (!fork) {
          fork = document.createElement('button')
          fork.type = 'button'
          fork.dataset.dsmTag = 'fork'
          fork.className = 'dsm-tag dsm-tag-fork'
          fork.textContent = '⑂ 分支'
          fork.addEventListener('click', (e) => {
            e.stopPropagation(); e.preventDefault()
            const target = e.currentTarget.dataset.dsmForkParent || ''
            const rows = document.querySelectorAll('[role="treeitem"]')
            for (const other of rows) {
              if (rowId(other) === target) {
                other.scrollIntoView({ block: 'center', behavior: 'smooth' })
                other.classList.add('dsm-row-flash')
                setTimeout(() => other.classList.remove('dsm-row-flash'), 1200)
                break
              }
            }
          })
          row.appendChild(fork)
        }
        if (fork.dataset.dsmForkParent !== li.parentSession) fork.dataset.dsmForkParent = String(li.parentSession)
        if (fork.title !== tip) { fork.title = tip; fork.setAttribute('aria-label', tip) }
      } else {
        const staleFork = row.querySelector('[data-dsm-tag="fork"]')
        if (staleFork) staleFork.remove()
      }
      if (!isEmpty && !isSub) {
        const kids = kidsByParent.get(id)
        const existingKids = row.querySelector('[data-dsm-kids]')
        const open = dsmSubsOpen.has(id)
        // 徽标 DOM 随血缘常驻，显隐交给 CSS（选中 / 悬停 / 键盘聚焦）。已
        // 展开的父行加 dsm-row-open 让徽标常驻可见——否则切走之后就再也
        // 收不回来了。隐藏状态不占位：标题拿全宽，悬停才让位给徽标。
        row.classList.toggle('dsm-row-open', open)
        if (kids) {
          const text = (open ? '▾ ' : '▸ ') + kids + ' 子代理'
          let badge = existingKids
          if (!badge) {
            badge = document.createElement('button')
            badge.type = 'button'
            badge.dataset.dsmKids = ''
            badge.className = 'dsm-kids-badge'
            badge.addEventListener('click', (e) => {
              e.stopPropagation(); e.preventDefault()
              dsmToggleSubs(badge)
            })
            row.appendChild(badge)
          }
          // 父会话 id 存 dataset、每次 paint 刷新：React 复用行 DOM 时旧闭包
          // 里的 id 可能已过期，点击时读 dataset 才不会切错父会话。
          if (badge.dataset.dsmParentId !== id) badge.dataset.dsmParentId = id
          // 同值赋值会替换文本节点、触发 observer——只在变化时写。
          if (badge.textContent !== text) badge.textContent = text
          const label = (open ? '收起' : '展开') + '该会话的 ' + kids + ' 个子代理'
          if (badge.getAttribute('aria-label') !== label) {
            badge.setAttribute('aria-label', label)
            badge.title = label
          }
          if (badge.getAttribute('aria-expanded') !== String(open)) badge.setAttribute('aria-expanded', String(open))
          if (open) dsmSyncSubList(row, id)
          else dsmDropSubList(row, id)
        } else {
          // 没有子代理：徽标与可能残留的子代理容器一并摘掉。
          if (existingKids) existingKids.remove()
          dsmDropSubList(row, id)
        }
      } else {
        row.classList.remove('dsm-row-open')
        const staleKids = row.querySelector('[data-dsm-kids]')
        if (staleKids) staleKids.remove()
      }
      // ---- v3.14.0 后台任务小三角 ----------------------------------------
      // 会话回合结束后它留下的 job 可能还在跑。这里给这样的行挂一个「▸ N」。
      // 与子代理徽标刻意分开：语义不同（子代理是「下钻会话」，后台任务是
      // 「本会话还有活儿在跑」），同时存在时两个徽标都该看得见。
      if (!isEmpty && !isSub) {
        const jobRows = dsmJobMap.get(id)
        const existingJob = row.querySelector('[data-dsm-jobs-badge]')
        if (jobRows && jobRows.length) {
          const open = dsmJobsOpen.has(id)
          const text = jobBadgeText(jobRows.length, open)
          let badge = existingJob
          if (!badge) {
            badge = document.createElement('button')
            badge.type = 'button'
            badge.dataset.dsmJobsBadge = ''
            badge.className = 'dsm-jobs-badge'
            badge.addEventListener('click', (e) => {
              e.stopPropagation(); e.preventDefault()
              dsmToggleJobs(badge)
            })
            // 用户要的是「会话前的小三角」——放在状态点之后、标题之前，而不是
            // 像子代理徽标那样贴右边（那个是计数，这个是「这行还有活儿」）。
            // 不能直接插成 firstChild：插件自己的状态点是 `position:absolute;
            // left:6px`，插在它前面会被压在下面。挂在宿主状态点之后最稳。
            const hostDot = row.querySelector('[data-state]')
            if (hostDot && hostDot.parentNode === row) row.insertBefore(badge, hostDot.nextSibling)
            else row.insertBefore(badge, row.firstChild)
          }
          // 同子代理徽标：id 存 dataset，React 复用行 DOM 后点哪个行读哪个 id。
          if (badge.dataset.dsmJobParentId !== id) badge.dataset.dsmJobParentId = id
          if (badge.textContent !== text) badge.textContent = text
          const label = (open ? '收起' : '展开') + '该会话的 ' + jobRows.length + ' 个后台任务'
          if (badge.getAttribute('aria-label') !== label) {
            badge.setAttribute('aria-label', label)
            badge.title = label
          }
          if (badge.getAttribute('aria-expanded') !== String(open)) badge.setAttribute('aria-expanded', String(open))
          // 展开态让整行保持 dsm-row-open，否则徽标随鼠标移开就消失、列表收不回来。
          if (open) row.classList.add('dsm-row-open')
          if (open) dsmSyncJobList(row, id)
          else dsmDropJobList(row, id)
        } else {
          if (existingJob) existingJob.remove()
          dsmDropJobList(row, id)
        }
      } else {
        const staleJob = row.querySelector('[data-dsm-jobs-badge]')
        if (staleJob) staleJob.remove()
        dsmDropJobList(row, id)
      }
      // DSH's cold list baseline can expose a stale header title until the
      // Session is opened. Paint the latest log-folded title from the host
      // authority without materializing the Session or changing its log.
      const authoritativeTitle = dsmAuthoritativeTitles.get(id)
      {
        const base = titleBaselines.get(row)
        // 零成本快路径：已定型且权威没更新 → 不查 DOM 不比较。
        if (!base || base.id !== id || (authoritativeTitle && authoritativeTitle !== base.authoritative)) {
          const node = rowNode(row) || {}
          const expected = new Set([node.title, node.displayTitle, node.name].filter((value) => typeof value === 'string'))
          const spans = [...row.children].filter((el) => el.tagName === 'SPAN' && !el.querySelector('[data-state]') && (el.textContent || '').trim())
          let titleEl = null
          if (base && base.id === id) {
            // 回填路径：只认我们上次写入/记录的那段文本，绝不猜别的 span。
            titleEl = spans.find((el) => (el.textContent || '') === base.text) || spans.find((el) => expected.has((el.textContent || '').trim())) || null
          } else {
            titleEl = spans.find((el) => expected.has((el.textContent || '').trim())) || spans[0] || null
          }
          if (titleEl) {
            const d = titleBackfillDecision({
              rendered: titleEl.textContent || '',
              baseline: base && base.id === id ? { text: base.text, authoritative: base.authoritative } : null,
              authoritative: authoritativeTitle || '',
            })
            if (d) {
              if (d.changed && titleEl.textContent !== d.text) titleEl.textContent = d.text
              titleBaselines.set(row, { id, text: d.nextBaseline.text, authoritative: d.nextBaseline.authoritative })
            }
          }
        }
      }
      // ===== v0.2.8：插件自持状态机（实证 DSH 源码后的正确实现）==========
      // App.asar 里 @deepseek-ai/dsh-client-ui-workspace 的真实实现：
      //   sessionNode(): running = status.running; completed = status.completionUnread===true
      //   sessionStatuses(): ongoing(running) / warning(pendingInteraction) /
      //                      done(completed) / idle(其他)
      // 三个致命事实（推翻旧假设）：
      //   ① DSH 侧栏**没有 error 状态**——出错后 running=false，只落 done/idle；
      //   ② done 需要 completionUnread=true，而用户一直盯着该会话时它不置位；
      //   ③ idle 是「普通空闲」，不该进快捷面板。
      // 因此不能被动读瞬时态：插件自己观察 running→非running 的转变来判定
      // 「刚完成」，用 dsmRunSeen（会话是否曾进入 running）区分「刚跑完」与
      // 「一直空闲」。
      const sd = row.querySelector('[data-state]')
      const dshState = sd ? String(sd.getAttribute('data-state') || '') : ''
      const isRunning = dshState === 'ongoing' || dshState === 'running'
      const isWarning = dshState === 'warning'
      const sid = String(id)
      // 曾进入 running 的标记（会话维度，进程内）。
      if (isRunning) dsmRunSeen.add(sid)
      // v0.2.8：running→停止 的转变沿触发一次 turn-kind 查询，据 reason.kind 判定
      // 正常完成 / 出错（DSH 侧栏无 error 态，只能由日志的 turn/end 提供）。
      if (!isRunning && dsmRunSeen.has(sid) && !dsmTurnKind.has(sid)) {
        // 只登记「待分类」；真正查询推迟到面板可见时（见面板 tick），
        // 避免会话一结束就让宿主解码整本日志。
        dsmTurnKind.set(sid, 'pending')
      }
      const turnKind = dsmTurnKind.get(sid)
      const failedKinds = { error: 1, aborted: 1, interrupted: 1 }
      // v3.14.0：这个会话还有后台任务在跑。它是「刚完成」的独立依据——用户点进
      // 会话会把 runSeen 清掉（视为已读），但只要作业还没收尾，它就该继续留在
      // 「刚完成」里，否则就回到用户抱怨的那个局面：会话看起来干完了，实际还有
      // 东西在后台占资源，而侧栏上找不到是谁。
      const hasBgJobs = (dsmJobMap.get(sid) || []).length > 0
      let qaState = null
      if (manualUnread.has(sid)) qaState = 'manual'
      else if (isWarning) qaState = 'feedback'
      else if (isRunning) qaState = 'running'
      else if (dsmRunSeen.has(sid)) qaState = (turnKind && failedKinds[turnKind]) ? 'error' : 'done'
      else if (hasBgJobs) qaState = 'done'
      // 「曾经跑过、现在不跑」= 刚结束：reason.kind 为 error/aborted/interrupted
      // 归「出错」，其余归「刚完成」。
      if (qaState) {
        const bl = titleBaselines.get(row)
        quickAccessRegistry.set(sid, {
          sessionId: sid,
          state: qaState,
          title: (bl && bl.text) || ((row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
        })
      } else if (quickAccessRegistry.has(sid)) {
        quickAccessRegistry.delete(sid)
      }
    })
    dsmSyncEmptyGroups(purgedNow)
    // issue #16：等隐藏标记落定后再校准展开计数（数据层优先，DOM 标记兜底）。
    dsmSyncOverflowLabels(purgedNow)
  }
  dsmRepaintDots = paint
  const paintToast = (msg, kind) => {
    const t = document.createElement('div')
    t.className = 'dsm-toast' + (kind === 'err' ? ' dsm-toast-err' : '')
    t.textContent = msg
    t.setAttribute('role', 'status')
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:8px;background:#2C2C2A;color:#F1EFE8;font-size:12px;line-height:1.5;z-index:9999;cursor:pointer'
    t.addEventListener('click', () => t.remove())
    document.body.appendChild(t)
    // T2：排队结果文案动辄几十字，固定 4200ms 读不完（3.6.0 已为面板 toast 立过
    // toastDurationFor，这里把侧栏通道并进来）。
    setTimeout(() => t.remove(), toastDurationFor(msg, kind))
  }
  dsmNotifySink = paintToast
  // ---- 侧栏就地展开子代理（issue #6）------------------------------------
  // DSH 按设计不渲染子代理行（ui-subagent 明文 "omitted from the ordinary
  // sidebar"），所以插件自己把它们在父行下方补渲染出来：点击徽标就地展开，
  // 不需要跳转到任何别处。数据来自 lineage-tree（官方 header 血缘 + live
  // 标记），带短期缓存；删除后整表失效重取。
  const DSM_KEY_SUBS = 'dsm-subs-open-v1'
  const dsmSubsOpen = new Set()
  try { for (const id of JSON.parse(localStorage.getItem(DSM_KEY_SUBS) || '[]')) if (typeof id === 'string') dsmSubsOpen.add(id) } catch (e) {}
  const dsmSaveSubsOpen = () => { try { localStorage.setItem(DSM_KEY_SUBS, JSON.stringify([...dsmSubsOpen])) } catch (e) {} }
  const dsmSubTrees = new Map()
  const SUB_TTL_MS = 15000
  async function dsmFetchSubTree(pid) {
    const cached = dsmSubTrees.get(pid)
    if (cached && Date.now() - cached.ts < SUB_TTL_MS) return cached
    dsmSubTrees.set(pid, { ts: Date.now(), status: 'loading', nodes: (cached && cached.nodes) || [] })
    try {
      const r = await postJSON('/archived-sessions/lineage-tree', { sessionId: pid })
      dsmSubTrees.set(pid, { ts: Date.now(), status: 'ready', nodes: (r && r.nodes) || [] })
    } catch (e) {
      dsmSubTrees.set(pid, { ts: Date.now(), status: 'error', nodes: [], error: String((e && e.message) || e) })
    }
    if (dsmRepaintDots) dsmRepaintDots()
    return dsmSubTrees.get(pid)
  }
  async function dsmSubAction(sid, kind) {
    try {
      await postJSON('/archived-sessions/delete', { sessionId: sid })
      if (kind === 'purge') {
        await postJSON('/archived-sessions/trash/purge', { sessionId: sid })
        dsmMarkPurged([sid])
        paintToast('已彻底删除该子代理')
      } else {
        paintToast('已移入回收站')
      }
      // 乐观剔除：服务端重取是异步的（且 DSH 的内存会话列表可能还挂着刚删掉
      // 的子代理），先把这个 id 从所有已缓存的树里摘掉，立刻重绘，不等网络。
      dsmDropSubagentFromTrees(sid)
      // 后台重取：loading 期间沿用上一步的乐观结果（dsmFetchSubTree 保留旧
      // nodes），新数据到达后再刷新一次，不会闪回「加载中」。
      for (const pid of [...dsmSubTrees.keys()]) dsmFetchSubTree(pid)
      dsmLoadTrashIds()
      if (dsmRepaintDots) dsmRepaintDots()
    } catch (e) { paintToast('操作失败：' + String((e && e.message) || e)) }
  }
  // 从所有缓存的子代理树里递归摘掉一个 id（含它的整棵子树）。
  function dsmDropSubagentFromTrees(sid) {
    const target = String(sid)
    const prune = (nodes) => (nodes || []).filter((n) => String(n.sessionId) !== target).map((n) => ({ ...n, children: prune(n.children) }))
    for (const [pid, rec] of dsmSubTrees) {
      if (!rec || !Array.isArray(rec.nodes)) continue
      dsmSubTrees.set(pid, { ...rec, nodes: prune(rec.nodes) })
    }
  }
  function dsmToggleSubs(badge) {
    const pid = badge && badge.dataset ? badge.dataset.dsmParentId : null
    if (!pid) return
    if (sidebarAdapter.disabled) {
      paintToast('侧栏适配器已停用（上游结构变化），请改从 设置 → 会话管理 查看子代理')
      return
    }
    if (dsmSubsOpen.has(pid)) { dsmSubsOpen.delete(pid); dsmSubTrees.delete(pid) } else { dsmSubsOpen.add(pid) }
    dsmSaveSubsOpen()
    if (dsmRepaintDots) dsmRepaintDots()
  }
  function dsmDropSubList(row, pid) {
    const parent = row.parentNode
    if (!parent) return
    for (const el of parent.children) {
      if (el.getAttribute && el.getAttribute('data-dsm-subs') === pid) { el.remove(); break }
    }
  }
  // 把某父会话的子代理树同步到它下方。全程幂等：容器只在缺失时创建，内容
  // 只在签名变化时重写——否则自己的写入会再次触发 MutationObserver 死循环。
  function dsmSyncSubList(row, pid) {
    const parent = row.parentNode
    if (!parent) return
    const open = dsmSubsOpen.has(pid)
    let box = null
    for (const el of parent.children) {
      if (el.getAttribute && el.getAttribute('data-dsm-subs') === pid) { box = el; break }
    }
    if (!open) { if (box) box.remove(); return }
    const rec = dsmSubTrees.get(pid)
    if (!rec) { dsmFetchSubTree(pid); return }
    if (!box) {
      box = document.createElement('div')
      box.setAttribute('data-dsm-subs', pid)
      box.className = 'dsm-subs'
      parent.insertBefore(box, row.nextSibling)
    } else if (box.nextElementSibling !== row.nextSibling && box.previousElementSibling !== row) {
      // React 重排后容器可能不在原位：搬回父行下方。
      parent.insertBefore(box, row.nextSibling)
    }
    const flat = []
    const walk = (nodes, depth) => { for (const n of nodes || []) { flat.push([n, depth]); if (depth < 4) walk(n.children, depth + 1) } }
    walk(rec.nodes, 0)
    // v3.6.2 #8：树里 title 为 null（未暖/失败）的子节点用侧栏权威标题回落
    // 参与签名与渲染——权威后到时签名变化，展开态就地补写，不再定格短 id。
    const effTitle = (n) => n.title || dsmAuthoritativeTitles.get(String(n.sessionId)) || ''
    const sig = rec.status + '|' + flat.map(([n, d]) => [n.sessionId, effTitle(n), n.live ? 1 : 0, n.sizeBytes, d].join(':')).join(';')
    if (box.dataset.dsmSig === sig) return
    box.dataset.dsmSig = sig
    box.textContent = ''
    if (rec.status === 'loading' && !flat.length) {
      const p = document.createElement('div'); p.className = 'dsm-sub-note'; p.textContent = '加载子代理…'; box.appendChild(p); return
    }
    if (rec.status === 'error') {
      const p = document.createElement('div'); p.className = 'dsm-sub-note'; p.textContent = '子代理加载失败：' + (rec.error || '未知错误'); box.appendChild(p); return
    }
    if (!flat.length) {
      const p = document.createElement('div'); p.className = 'dsm-sub-note'; p.textContent = '该会话没有子代理'; box.appendChild(p); return
    }
    const canPurgeSub = dsmActionCapability('physicalPurge', 'purge')
    for (const [n, depth] of flat) {
      const r = document.createElement('div')
      r.className = 'dsm-sub-row' + (n.live ? ' dsm-sub-live' : '')
      r.style.paddingLeft = String(14 + depth * 12) + 'px'
      // 整行可点：走官方 sessions.open / openSubagent 打开这个子代理会话。
      // 行内按钮自己 stopPropagation，不会误触发。
      r.title = '打开这个子代理会话'
      r.addEventListener('click', async () => {
        const res = await dsmOpenSessionById(n.sessionId, n.parentSession || pid)
        if (res === 'ok') return
        const msg = openSubagentToast(res, n.title, 'sidebar')
        paintToast(msg.text, msg.kind)
      })
      const name = document.createElement('span')
      name.className = 'dsm-sub-name'
      name.textContent = effTitle(n) || (String(n.sessionId).slice(0, 8) + '…')
      name.title = n.sessionId
      r.appendChild(name)
      const meta = document.createElement('span')
      meta.className = 'dsm-sub-meta'
      meta.textContent = n.live ? '运行中' : (fmtBytes(n.sizeBytes) || '已结束')
      r.appendChild(meta)
      const acts = document.createElement('span')
      acts.className = 'dsm-sub-acts'
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'dsm-sub-btn'
      del.textContent = '删除'
      del.title = '移入回收站，可在回收站恢复'
      del.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); dsmSubAction(n.sessionId, 'delete') })
      acts.appendChild(del)
      // 彻底删除是破坏性操作，只放在会话管理面板里（那里有二次确认、回收站
      // 与墓碑一整套安全网）。侧栏只提供「删除」（进回收站，可恢复）。
      r.appendChild(acts)
      box.appendChild(r)
    }
  }
  // ---- v3.14.0 侧栏就地展开后台任务 ---------------------------------------
  // 与上面的子代理列表同构（幂等容器 + 签名比对），但数据不来自 lineage-tree，
  // 而是 host 随 sidebar-state 下发的 backgroundJobs 快照——所以这里没有 fetch，
  // 也没有 TTL：`dsmJobMap` 每轮轮询整表刷新，同步函数只负责把当下快照画出来。
  function dsmToggleJobs(badge) {
    const sid = badge && badge.dataset ? badge.dataset.dsmJobParentId : null
    if (!sid) return
    if (dsmJobsOpen.has(sid)) dsmJobsOpen.delete(sid)
    else dsmJobsOpen.add(sid)
    dsmSaveJobsOpen()
    if (dsmRepaintDots) dsmRepaintDots()
  }
  function dsmDropJobList(row, sid) {
    const parent = row.parentNode
    if (!parent) return
    for (const el of parent.children) {
      if (el.getAttribute && el.getAttribute('data-dsm-jobs') === sid) { el.remove(); break }
    }
  }
  function dsmSyncJobList(row, sid) {
    const parent = row.parentNode
    if (!parent) return
    const open = dsmJobsOpen.has(sid)
    let box = null
    for (const el of parent.children) {
      if (el.getAttribute && el.getAttribute('data-dsm-jobs') === sid) { box = el; break }
    }
    if (!open) { if (box) box.remove(); return }
    const rows = dsmJobMap.get(sid) || []
    // 快照里已经没有这个会话的活作业了：收起列表并顺手清掉展开态，否则用户
    // 下次还会看到一个永远空着的展开区。
    if (!rows.length) {
      if (box) box.remove()
      if (dsmJobsOpen.delete(sid)) dsmSaveJobsOpen()
      return
    }
    if (!box) {
      box = document.createElement('div')
      box.setAttribute('data-dsm-jobs', sid)
      box.className = 'dsm-subs dsm-jobs'
      parent.insertBefore(box, row.nextSibling)
    } else if (box.nextElementSibling !== row.nextSibling && box.previousElementSibling !== row) {
      // React 重排后容器可能不在原位：搬回会话行下方。
      parent.insertBefore(box, row.nextSibling)
    }
    // 签名里带上「算到某一分钟为止的时长」：纯 startedAt 不变的快照签名恒定，
    // 面板就再也不会重画「运行时长」（用户看到的将是一个冻住的「1 分钟」）。
    // 秒级用 floor(now/1000) 会让签名每拍都变、整块列表反复重建，没必要。
    const now = Date.now()
    const sig = rows.map((j) => [j.id, j.label, j.status, Math.floor((now - (j.startedAt || now)) / 60000)].join(':')).join(';')
    if (box.dataset.dsmSig === sig) return
    box.dataset.dsmSig = sig
    box.textContent = ''
    const shown = rows.slice(0, JOB_BADGE_MAX_ROWS)
    for (const job of shown) {
      const r = document.createElement('div')
      r.className = 'dsm-sub-row dsm-job-row'
      r.title = job.label + '\n状态：' + (job.status || '未知') + '\n任务 ID：' + job.id
      const name = document.createElement('span')
      name.className = 'dsm-sub-name'
      name.textContent = job.label
      r.appendChild(name)
      const meta = document.createElement('span')
      meta.className = 'dsm-sub-meta dsm-job-age'
      meta.textContent = job.startedAt ? jobDurationLabel(now - job.startedAt) : (job.status === 'stopping' ? '收尾中' : '运行中')
      r.appendChild(meta)
      box.appendChild(r)
    }
    if (rows.length > shown.length) {
      const more = document.createElement('div')
      more.className = 'dsm-sub-note'
      more.textContent = '还有 ' + (rows.length - shown.length) + ' 个后台任务未列出'
      box.appendChild(more)
    }
  }
  // MutationObserver 增量驱动为主（childList + 属性 + 文本），彻底替代高频率
  // 全表定时扫描；保留一个低频兜底 tick 处理无 DOM 变化的状态迁移，且后台
  // 标签页完全不跑。回收站/墓碑集合的刷新也挂在这个兜底上（每 8 拍 ≈ 32s）。
  let raf = 0
  const schedulePaint = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; paint() }) }
  const FALLBACK_TICK_MS = 4000
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    // v3.6.2 C：预热在途时每拍（4s）都拉 sidebar-state，补齐结果立刻浮现；
    // 空闲时维持低频 32s（3.4.1 移除全表轮询的性能决策不回退——这里轮询的
    // 是轻量 authority 路由，且仅在有活可补的窗口期加速）。T1：精判同闸。
    // v3.14.0：有后台任务在跑时也加速到每拍——作业结算了三角该尽快消失，
    // 卡在 32s 台阶上会让人以为那活儿一直没完。只在真有时才提速，空闲照旧。
    const cadence = (dsmWarmPending || dsmRefinePending || dsmJobMap.size) ? 1 : 8
    if (++dsmTrashTick % cadence === 0) dsmLoadTrashIds()
    paint()
  }
  tick()
  dsmLoadTrashIds()
  // v3.6.2 C：冷启动快速二拍——首拉响应可能仍被空白精判/预热排队压着，
  // 1.5s 后再拉一次，把「⑂ 分支」等后到信息的台阶从 32s 缩到秒级。
  const coldSecondBeat = setTimeout(() => dsmLoadTrashIds(), 1500)
  paint()
  const obs = new MutationObserver(schedulePaint)
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'aria-selected', 'class', 'style'],
    characterData: true,
  })
  const tickTimer = setInterval(tick, FALLBACK_TICK_MS)
  // 插件卸载（HMR / 停用）时整场清退：没有这一步，interval 和 observer 会
  // 跟着旧闭包活到页面关闭，注入节点也会留在侧栏上。
  return () => {
    clearInterval(tickTimer)
    clearTimeout(coldSecondBeat)
    obs.disconnect()
    dsmNotifySink = null
    dsmTeardownSidebarAug()
  }
}

// Cross-workspace drag/drop for the native DSH sidebar. DSH does not expose a
// sidebar-row plugin slot, so the adapter discovers session/workspace rows from
// their React fiber nodes, while the actual move remains entirely host-owned.
// The existing “移动会话” menu is also the keyboard-accessible fallback.
// 同上：拖拽增强的观察器 / interval / document 级 pointerdown|drag* 监听器只装一份。
let sidebarDragInstalled = false
// 「当前拖的是一条会话行」——自动滚动只认这个状态。从 Finder 拖文件、拖选文本、
// 拖图片进窗口同样会触发 dragover，那些绝不该把侧栏滚起来。
let dsmSessionDragActive = false
function installSidebarWorkspaceDrag() {
  if (typeof document === 'undefined') return
  if (sidebarDragInstalled) return
  sidebarDragInstalled = true
  let sessions = new Map()
  let dragging = null
  let moving = false

  // 识别统一走 sidebarAdapter（可版本化、可整体降级）；adapter 停用后拖拽
  // 行为整体退出，不残留在官方侧栏上。
  const sessionForRow = (row) => {
    const { node, group } = sidebarAdapter.recognize(row)
    return sessionForNodes(group ? [node, group].filter(Boolean) : [node], sessions)
  }
  const workspaceForRow = (row) => {
    // A session row's fiber chain also contains its parent workspace node.
    // Reject it explicitly so only the visible workspace header is a drop zone.
    if (sessionForRow(row)) return null
    const { group } = sidebarAdapter.recognize(row)
    return group ? workspaceForNodes([group]) : null
  }
  const eventRow = (event) => {
    for (const item of event.composedPath ? event.composedPath() : []) {
      if (item instanceof Element && item.getAttribute('role') === 'treeitem') return item
    }
    return event.target instanceof Element ? event.target.closest('[role="treeitem"]') : null
  }
  const toast = (message) => {
    const el = document.createElement('div')
    el.className = 'dsm-toast'
    el.setAttribute('role', 'status')
    el.textContent = message
    document.body.appendChild(el)
    setTimeout(() => el.remove(), toastDurationFor(message))  // T2：并轨按字数定时
  }
  const clearVisuals = () => {
    document.querySelectorAll('.dsm-drag-source,.dsm-drop-target').forEach((el) => el.classList.remove('dsm-drag-source', 'dsm-drop-target'))
  }
  const decorateRows = () => {
    if (sidebarAdapter.disabled) return
    document.querySelectorAll('[role="treeitem"]').forEach((row) => {
      const session = sessionForRow(row)
      const ws = workspaceForRow(row)
      if (session) {
        row.setAttribute('aria-description', '可拖动到其他工作区；键盘用户可通过更多菜单中的移动会话操作')
      }
      if (ws) row.setAttribute('data-dsm-workspace-drop', '')
    })
  }
  const refresh = async () => {
    try {
      const sessionResult = await postJSON('/archived-sessions/sessions', {})
      sessions = new Map((sessionResult.items || []).map((item) => [String(item.sessionId), item]))
      decorateRows()
    } catch (e) { /* sidebar enhancement remains optional */ }
  }

  // Capture before DSH's delegated React handlers. DSH reserves the same
  // native drag gesture for reordering sessions inside one group; only a real
  // workspace-heading target is intercepted here, so same-group sorting keeps
  // its official behavior.
  // 指针按下先于 dragstart 数十到数百毫秒，正好用来给「Map 里还没有的行」预热：
  // replace the 5s poll with a just-in-time fetch, so a brand-new session is
  // draggable on the first gesture without a background poll.
  document.addEventListener('pointerdown', (event) => {
    if (moving) return
    const row = eventRow(event)
    if (!row || sessionForRow(row)) return
    maybeRefresh()
  }, true)

  document.addEventListener('dragstart', (event) => {
    dsmSessionDragActive = false
    if (sidebarAdapter.disabled) return
    const moveCapability = dsmActionCapability('relocateSession') || dsmActionCapability('move')
    if (!moveCapability || !moveCapability.available) return
    const row = eventRow(event)
    const item = row && sessionForRow(row)
    if (!item || moving) return
    dragging = item
    dsmSessionDragActive = true
    row.classList.add('dsm-drag-source')
  }, true)
  document.addEventListener('dragover', (event) => {
    const row = eventRow(event)
    const target = row && workspaceForRow(row)
    if (!dragging || !target || moving) return
    if (!canDropOnWorkspace(dragging, target)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    document.querySelectorAll('.dsm-drop-target').forEach((el) => { if (el !== row) el.classList.remove('dsm-drop-target') })
    row.classList.add('dsm-drop-target')
  }, true)
  document.addEventListener('drop', async (event) => {
    const row = eventRow(event)
    const item = dragging
    const target = row && workspaceForRow(row)
    if (!item || !target || moving || !canDropOnWorkspace(item, target)) return
    event.preventDefault()
    event.stopPropagation()
    moving = true
    clearVisuals()
    row.classList.add('dsm-drag-busy')
    try {
      const result = await postActiveAware('/archived-sessions/move', { sessionId: item.sessionId, targetPath: target.path })
      // 会话被 DSH 打开时服务端只登记排队：磁盘与工作区分组都没动。这条路径绝不能
      // 本地改行 + 报成功——那会让用户以为移动已完成，而侧栏刷新后该行又跳回原工作区
      //（用户 2026-09-10 报的「说移动成功但还在原工作区」就是这个）。排队时只如实说明。
      if (result && result.queued) {
        await dsmLoadTrashIds()
        toast(result.notes && result.notes.length ? result.notes.join(' ') : '会话正被 DSH 打开，已排队待移动；重启 DSH 后会自动完成（请先别打开它）。')
        return
      }
      sessions.set(item.sessionId, { ...item, workspacePath: result.workspacePath || target.path, workspaceTitle: result.workspaceTitle || target.title })
      await dsmLoadTrashIds()
      toast(result && result.already
        ? `已在「${result.workspaceTitle || target.title}」`
        : `已移到「${result.workspaceTitle || target.title}」`)
    } catch (error) {
      toast('移动失败：' + String((error && error.message) || error))
    } finally {
      moving = false
      dragging = null
      dsmSessionDragActive = false
      row.classList.remove('dsm-drag-busy')
      decorateRows()
    }
  }, true)
  document.addEventListener('dragend', () => {
    dragging = null
    dsmSessionDragActive = false
    clearVisuals()
  }, true)

  let decorateTimer = null
  const scheduleDecorate = () => {
    if (decorateTimer) return
    decorateTimer = requestAnimationFrame(() => { decorateTimer = null; decorateRows() })
  }
  refresh()
  const observer = new MutationObserver(scheduleDecorate)
  observer.observe(document.body, { childList: true, subtree: true })
  // 原先这里每 5s 无脑全表刷新一次。该接口在 host 侧要遍历全部会话，
  // 大库（issue #1: 49 会话 / 14 万帧）上每次都是一次重活，页面挂着就一直占宿主 CPU，
  // 连累 session.history 之类 RPC 超时。拖拽元数据根本不需要 5s 精度：
  //   - 背景标签页完全不刷新
  //   - 前台每 60s 兜底一次
  //   - 标签页重新可见、或真正开始拖拽而 Map 里没有该行时，按需刷新
  let lastRefreshAt = Date.now()
  const maybeRefresh = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    lastRefreshAt = Date.now()
    return refresh()
  }
  const REFRESH_MS = 60000
  const refreshTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    if (Date.now() - lastRefreshAt < REFRESH_MS) return
    maybeRefresh()
  }, REFRESH_MS)
  dsmSidebarCleanup = () => clearInterval(refreshTimer)
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      if (Date.now() - lastRefreshAt < 30000) return
      maybeRefresh()
    })
  }
}

/**
 * 拖拽自动滚动：会话列表经常比侧栏高得多，把会话往列表顶端（或底端）拖时，
 * 视口外的工作区标题够不着。这里只观察原生 drag 事件、只滚侧栏里那个
 * role="tree" 的滚动容器，不参与、也不改变 DSH 自己的拖放判定。
 *
 * 安装纪律（HMR 安全）：cordis 的 HMR 是「先 apply 新模块，再跑旧模块的
 * cleanup」。按版本号 early-return 会让新实例误以为自己已经装好，紧接着旧
 * cleanup 把监听器摘掉 —— 自动滚动从此永久失效。所以这里**无条件**摘掉上一代，
 * 再用 token 认领自己这一份；cleanup 只在 token 还对得上时才动手。
 */
const DRAG_AUTO_SCROLL_VERSION = 2
const DRAG_AUTO_SCROLL_KEY = Symbol.for('dsh.sessions-manager.drag-auto-scroll')
const DRAG_AUTO_SCROLL_EDGE = 64
const DRAG_AUTO_SCROLL_MAX_STEP = 20
const DRAG_AUTO_SCROLL_HOVER_SYNC_MS = 120
// 侧栏外拖拽时不必每个 dragover 都重新上溯 DOM：容器没找到就按这个间隔重试。
const DRAG_AUTO_SCROLL_RESOLVE_RETRY_MS = 120

function installSidebarDragAutoScroll() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  const previous = globalThis[DRAG_AUTO_SCROLL_KEY]
  if (previous && typeof previous.dispose === 'function') {
    try { previous.dispose() } catch (error) { /* 上一代坏了也要继续装新的 */ }
  }
  const token = Symbol('dsm-drag-auto-scroll')
  const state = { x: 0, y: 0, raf: 0, container: null, lastResolve: 0, lastHoverSync: 0, dataTransfer: null }
  // 先读 role（属性，O(1)）再算样式：原先每个祖先都跑一次 querySelector，60 次/秒
  // 的 dragover 在长侧栏上等于持续子树扫描。
  const scrollableTreeAt = (node) => {
    let el = node instanceof Element ? node : null
    while (el !== null && el !== document.body && el !== document.documentElement) {
      if (el.getAttribute('role') === 'tree') {
        const overflowY = window.getComputedStyle(el).overflowY
        if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
          && el.scrollHeight - el.clientHeight > 1) return el
      }
      el = el.parentElement
    }
    return null
  }
  // 光标停在列表上方（侧栏标题一带）时 target 已经不在列表里；挑「横向覆盖光标、
  // 且最靠左」的那棵树——文档里可能还有别的 role="tree"（设置面板等），
  // 盲取 querySelector 的第一个会滚错容器。
  const sidebarTreeUnder = () => {
    let best = null
    let bestLeft = Infinity
    document.querySelectorAll('[role="tree"]').forEach((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      if (state.x < rect.left || state.x > rect.right) return
      if (rect.left < bestLeft) { best = el; bestLeft = rect.left }
    })
    return best
  }
  const resolveContainer = (target) => scrollableTreeAt(target) || scrollableTreeAt(sidebarTreeUnder())
  const speedAt = (container) => {
    const rect = container.getBoundingClientRect()
    return dragAutoScrollStep({
      y: state.y,
      top: rect.top,
      bottom: rect.bottom,
      edge: DRAG_AUTO_SCROLL_EDGE,
      maxStep: DRAG_AUTO_SCROLL_MAX_STEP,
    })
  }
  // 滚动之后光标下的行换了，浏览器不会补发 dragover；补一条合成事件，让目标
  // 高亮（本插件）与插入标记（DSH 原生排序）跟着滚动后的位置走。
  // 必须复用真实拖拽的 dataTransfer：空 DataTransfer 没有 types，上游若按 types
  // 判定「这是不是会话拖拽」，会把插入标记判成非拖拽，反而清掉高亮。
  const syncHover = () => {
    if (!dsmSessionDragActive) return
    const now = Date.now()
    if (now - state.lastHoverSync < DRAG_AUTO_SCROLL_HOVER_SYNC_MS) return
    state.lastHoverSync = now
    if (typeof DragEvent !== 'function' || !state.dataTransfer) return
    const target = document.elementFromPoint(state.x, state.y)
    if (target === null) return
    try {
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: state.x,
        clientY: state.y,
        dataTransfer: state.dataTransfer,
      }))
    } catch (error) { /* 合成事件失败不影响滚动本身 */ }
  }
  const tick = () => {
    state.raf = 0
    const container = state.container
    // 没有可滚容器就不必空转 rAF：下一次 dragover 会重新启动循环。
    if (!dsmSessionDragActive || container === null || !container.isConnected) return
    const step = speedAt(container)
    if (step !== 0) {
      const before = container.scrollTop
      container.scrollTop = before + step
      if (container.scrollTop !== before) syncHover()
    }
    state.raf = window.requestAnimationFrame(tick)
  }
  const stop = () => {
    state.container = null
    state.lastResolve = 0
    state.dataTransfer = null
    if (state.raf !== 0) window.cancelAnimationFrame(state.raf)
    state.raf = 0
  }
  const onDragOver = (event) => {
    // 真实拖拽的 dataTransfer 只在事件期间有效，缓存给滚动后的合成 dragover 复用。
    if (event.dataTransfer) state.dataTransfer = event.dataTransfer
    if (!dsmSessionDragActive) { stop(); return }
    if (event.clientX === 0 && event.clientY === 0) return
    state.x = event.clientX
    state.y = event.clientY
    if (state.container === null || !state.container.isConnected) {
      const target = event.target instanceof Element ? event.target : null
      // 光标已经在列表行上（treeitem）时立刻解析，不必等重试窗口；只有在侧栏
      // 之外拖着走时才节流，避免每帧上溯 DOM。
      const insideList = target !== null && target.closest('[role="treeitem"]') !== null
      const now = Date.now()
      if (insideList || now - state.lastResolve >= DRAG_AUTO_SCROLL_RESOLVE_RETRY_MS) {
        state.lastResolve = now
        state.container = resolveContainer(target)
      }
    }
    if (state.container !== null && state.raf === 0) state.raf = window.requestAnimationFrame(tick)
  }
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('dragend', stop, true)
  document.addEventListener('drop', stop, true)
  window.addEventListener('blur', stop)
  const dispose = () => {
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('dragend', stop, true)
    document.removeEventListener('drop', stop, true)
    window.removeEventListener('blur', stop)
    stop()
    const current = globalThis[DRAG_AUTO_SCROLL_KEY]
    if (current !== undefined && current.token === token) delete globalThis[DRAG_AUTO_SCROLL_KEY]
  }
  globalThis[DRAG_AUTO_SCROLL_KEY] = { version: DRAG_AUTO_SCROLL_VERSION, token, dispose }
  return dispose
}

export function apply(ctx) {
  dsmClientCtx = ctx
  // 主样式（含全局面板 .dsm-qa-* / 面板 .archv-* / 侧栏 .dsm-*）：插件加载即注入
  // document.head。原先只挂在 SessionPanel 的 <style>{CSS}</style> 里——设置面板
  // 不打开，全局面板（main slot）就裸奔（用户实测「完全没观测到 UI 升级」的
  // 直接原因）。settings 面板内联副本保留（双注入幂等，rebuild 面板不闪样式）。
  try {
    if (typeof document !== 'undefined' && document.head) {
      const s = document.createElement('style')
      s.textContent = CSS
      document.head.appendChild(s)
    }
  } catch (e) { /* 注入失败时退化为面板内联样式 */ }
  // v0.2.2：快捷面板外观（预设 + 可调参数）尽早应用，避免首帧闪默认样式。
  applyQaStyle()
  // v3.13.0 胶囊联动：歌词插件换皮肤 / 调材质 / 换高亮色时都会在当前 document
  // 上派发各自的 CustomEvent（见 dsh-netease-lyrics 的 writeDisplay /
  // writeNoticePrefs / writeColors），另加 window 的 storage 兜底（跨标签页
  // 写入时只有 storage 事件）。只有「跟随」态需要重算，普通预设直接跳过，
  // 不给非联动用户增加任何开销。
  const capsuleAc = typeof AbortController !== 'undefined' ? new AbortController() : null
  if (capsuleAc && typeof window !== 'undefined' && window.addEventListener) {
    const onCapsuleChange = () => {
      try { if (readQaStyle().preset !== FOLLOW_PRESET) return } catch (e) { return }
      applyQaStyle()
    }
    for (const name of CAPSULE_EVENTS) window.addEventListener(name, onCapsuleChange, { signal: capsuleAc.signal })
    window.addEventListener('storage', onCapsuleChange, { signal: capsuleAc.signal })
    ctx.effect(() => () => capsuleAc.abort())
  }
  dsmLoadCapabilities()
  // 活跃会话心跳：页面隐藏时不发（用户没在看；host 侧 TTL 到期后自然失效，
  // 于是「无法证明活跃」→ 放行移动，不会把会话永久锁死）。
  const beat = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    reportActiveSession(false).catch(() => {})
  }
  beat()
  const beatTimer = setInterval(beat, DSM_ACTIVE_HEARTBEAT_MS)
  const beatAc = typeof AbortController !== 'undefined' ? new AbortController() : null
  if (beatAc && typeof document !== 'undefined' && document.addEventListener) {
    // 标签页重新可见：立刻补一次（切回来后第一件事就可能是移动）。
    document.addEventListener('visibilitychange', () => { if (!document.hidden) beat() }, { signal: beatAc.signal })
  }
  ctx.effect(() => () => { clearInterval(beatTimer); if (beatAc) beatAc.abort() })
  installSettingsNavIcons(ctx)
  installSidebarSessionMenuAug(ctx)
  // 侧栏增强的卸载清退挂到 cordis effect：插件停用/HMR 时 interval、
  // MutationObserver 与全部注入 DOM 一并回收（否则泄漏到页面关闭）。
  const disposeSidebarDots = installSidebarStatusDots()
  if (disposeSidebarDots) ctx.effect(() => disposeSidebarDots)
  installSidebarWorkspaceDrag()
  // 拖拽自动滚动只挂原生 drag 监听，插件停用 / HMR 时靠返回的 disposer 摘干净。
  // 不能写成 `ctx.effect(() => () => globalThis[key].dispose())`：HMR 时旧 cleanup
  // 晚于新 apply 执行，按全局键摘除会连新一代的监听器一起摘掉（即 install 那段
  // 注释里说的死锁）。
  const disposeDragAutoScroll = installSidebarDragAutoScroll()
  if (disposeDragAutoScroll) ctx.effect(() => disposeDragAutoScroll)
  const workspacesSvc = ctx.get('workspaces')
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'session-manager', order: 90, label: '会话管理' },
      (props) => <SessionPanel {...props} workspacesSvc={workspacesSvc} />,
    ),
  )

  // v0.2.3：footer 次选入口按用户要求移除（全局面板入口已足够）；组件与注册
  // 代码一并删除，避免死代码。
  try {
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: 'dsm-quick-access-panel', order: 56, label: '进行中的会话' },
        () => (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.2a6.8 6.8 0 0 1 6.8 6.8A6.8 6.8 0 0 1 8 14.8 6.8 6.8 0 0 1 1.2 8 6.8 6.8 0 0 1 8 1.2zm0 1.5a5.3 5.3 0 1 0 0 10.6 5.3 5.3 0 0 0 0-10.6z" fillOpacity=".35" />
          </svg>
        ),
      ),
    )
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key: 'dsm-quick-access-panel' },
        (props) => <DsmQuickAccessPanel {...props} />,
      ),
    )
  } catch (e) { /* 旧宿主无 panellist/main slot 时静默 */ }
  // v0.4.2（任务3）：**对外暴露会话跳转能力**——供其他插件（典型场景：
  // dsh-netease-lyrics 的「会话区提示」点击跳转）复用。稳定契约：
  //   window.__dshSessionsManager = { version, openSession(id) -> boolean }
  // openSession 走本插件已验证的双核心桥（旧核心 sessions.open / 新核心
  // uiWorkspace.openSession），因此调用方无需自己处理宿主差异。
  // 同一能力也尝试注册为客户端 cordis 服务 'lyinSessions'（可用则用）。
  try {
    const api = {
      version: '3.18.0',
      openSession(id) {
        const target = id === null || id === undefined ? '' : String(id)
        if (!target) return false
        try {
          const svc = dsmSessionsService()
          if (!svc || typeof svc.open !== 'function') return false
          svc.open(target)
          return true
        } catch (e) { return false }
      },
    }
    if (typeof window !== 'undefined') window.__dshSessionsManager = api
    dsmDebugLog('api:exposed', 'openSession=' + typeof api.openSession)
  } catch (e) { dsmDebugLog('api:expose-failed', String((e && e.message) || e)) }

  // v0.4.0：接入 uiSession 权威状态（客户端服务，覆盖全部会话）。用 ctx.inject
  // 等待就绪（与 v0.3.4 同一教训：直接 ctx.get 会拿到 undefined）。拿不到就
  // 保持 null，面板自动回退 DOM 采集，行为不退化。
  try {
    ctx.inject(['uiSession'], (scope) => {
      const svc = scope.uiSession
      const store = svc && svc.sessionStatus
      dsmDebugLog('uiSession:probe', 'svc=' + !!svc, 'store=' + !!store,
        'keys=' + (svc ? Object.keys(svc).slice(0, 20).join(',') : '-'))
      // v0.5.1：「最近活跃」改用客户端会话商店的时间戳（见 dsmSessionListStore 注释）。
      // 这一行是**长期保留**的一行诊断：GUI 无 console，而「商店是否就绪」决定了
      // 次级区能不能拿到时间，排障时第一眼就要看到它。
      try {
        const listStore = svc && svc.sessions && svc.sessions.list
        if (listStore && typeof listStore.getSnapshot === 'function') {
          dsmSessionListStore = listStore
          dsmDebugLog('session-list:store-ready')
        } else {
          dsmDebugLog('session-list:store-missing')
        }
      } catch (e) { dsmDebugLog('session-list:store-FATAL', String((e && e.message) || e)) }
      if (!store || typeof store.getSnapshot !== 'function') return
      dsmUiSessionStatus = store
      if (typeof store.subscribe === 'function') {
        scope.effect(() => store.subscribe(() => {
          if (typeof dsmRepaintDots === 'function') dsmRepaintDots()
        }))
      }
      dsmDebugLog('uiSession:ready')
    })
  } catch (e) { dsmDebugLog('uiSession:FATAL', String((e && e.message) || e)) }

  // v0.3.4：右侧栏标签页——**根因修复：用 ctx.inject 等待服务就绪**。
  // 诊断日志实证（~/.dsh/sessions-manager/debug.log）：
  //   rail:probe sr=false tabsReg=false registry=false
  // 即 apply 执行时 sidebarRight / sidebarRightTabs 尚未提供，`ctx.get(...)`
  // 拿到 undefined，整块注册被跳过 → body slot 从未注册 → 点击标签页只能看到
  // shell 的 tab.unavailable 兜底（卡片时有时无 = 时序竞态）。
  // cordis 的正确姿势是 ctx.inject([...], scope => ...)（真实插件 ui-chat /
  // ui-sidebar-browser 一律如此），依赖就绪后才执行注册。
  try {
    const RAIL_KIND = 'dsm-quick-access'
    const RAIL_ID = 'dsm-lyin-sessions-manager/quick-access'
    ctx.inject(['sidebarRightTabs'], (scope) => {
      const tabs = scope.sidebarRightTabs
      // sidebarRight 只用于「打开标签页」入口，拿不到也不影响注册，故不进 inject
      // 列表（少一个硬依赖，旧宿主也能注册）。
      const sr = scope.get ? scope.get('sidebarRight') : null
      dsmDebugLog('rail:probe2', 'tabs=' + !!tabs, 'sr=' + !!sr)
      if (!tabs || typeof tabs.register !== 'function') {
        dsmDebugLog('rail:no-tabs-registry')
        return
      }
      tabs.register({
        id: RAIL_ID,
        kind: RAIL_KIND,
        priority: 'extension',
        title: () => '进行中的会话',
        // guide 卡片（右栏空态列表的条目；点击直接 open(entry.kind)）。
        guide: [{
          id: 'attention',
          order: 25,
          title: () => '进行中的会话',
          description: () => '运行中 / 待处理 / 出错 / 刚完成的会话',
          icon: ({ size = 26, className } = {}) => (
            <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.2a6.8 6.8 0 0 1 6.8 6.8A6.8 6.8 0 0 1 8 14.8 6.8 6.8 0 0 1 1.2 8 6.8 6.8 0 0 1 8 1.2zm0 1.5a5.3 5.3 0 1 0 0 10.6 5.3 5.3 0 0 0 0-10.6z" fillOpacity=".35" />
            </svg>
          ),
        }],
      })
      dsmDebugLog('rail:register-ok', RAIL_ID, RAIL_KIND)
      // keyed slot 以 definition 的 **id** 分发（app.asar:1597 entryKey）。
      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register(
          { name: 'sidebar.right.pane.tab', key: RAIL_ID },
          () => <DsmQuickAccessPanel compact />,
        ),
      )
      scope.slots.inject('sidebar.right.pane.tab.title', () =>
        scope.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: RAIL_ID },
          () => <span>进行中的会话</span>,
        ),
      )
      dsmOpenQuickAccessTab = (sessionId) => {
        try {
          const target = sessionId || dsmRailTarget().id || ''
          const ctl = sr || (scope.get ? scope.get('sidebarRight') : null)
          if (ctl && typeof ctl.openTabIn === 'function' && target) {
            ctl.openTabIn(String(target), RAIL_KIND)
            return true
          }
        } catch (e) { /* 打开失败：退化为全局面板入口 */ }
        return false
      }
    })
  } catch (e) { dsmDebugLog('rail:FATAL', String((e && e.message) || e)) }
}