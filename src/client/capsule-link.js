// dsh-lyin-sessions-manager — 「面板外观跟随歌词胶囊」的纯判定层（v3.13.0）。
//
// 起因：同一位用户在 dsh-netease-lyrics 里调了很多胶囊样式（皮肤 + 材质参数），
// 又要单独为本插件的面板挑一套外观，两边各调一遍很烦。这里把胶囊那边的
// localStorage 快照翻译成面板的 --dsmqa-* 变量，做到「换胶囊，面板跟着变」。
//
// 本模块**不碰 DOM、不碰 localStorage**：输入是三个已经解析好的对象，输出是
// 变量表。读取与监听留在 src/client/index.jsx，测试直接喂数据。
//
// 三个来源键（与 dsh-netease-lyrics 的常量一一对应，改动要两边同步）：
//   dsh.netease-lyrics.display.v1  → capsuleStyle / panelOpacity
//   dsh.netease-lyrics.notice.v1   → glass* / ember* / akAccent（材质参数）
//   dsh.netease-lyrics.colors.v1   → original / translation / active（高亮色）

export const CAPSULE_DISPLAY_KEY = 'dsh.netease-lyrics.display.v1'
export const CAPSULE_NOTICE_KEY = 'dsh.netease-lyrics.notice.v1'
export const CAPSULE_COLOR_KEY = 'dsh.netease-lyrics.colors.v1'

// 胶囊侧 writeDisplay / writeNoticePrefs / writeColors 都会在写完 localStorage
// 后 dispatch 同名事件；另外任一窗口写入都会触发跨标签的 "storage"。
export const CAPSULE_EVENTS = Object.freeze([
  'dsh-netease-lyrics-display',
  'dsh-netease-lyrics-notice',
  'dsh-netease-lyrics-colors',
])

// 面板外观里的「跟随」哨兵。它不是 QA_STYLE_PRESETS 的键，readQaStyle 要单独放行。
export const FOLLOW_PRESET = 'follow-capsule'

// 胶囊侧 SKIN_IDS（7 种）。前 5 种有真正的映射，后 2 种暂时回落到近似外观。
export const CAPSULE_STYLES = Object.freeze([
  'default', 'frosted', 'wishes', 'ember', 'arknights', 'persona', 'solid',
])
export const CAPSULE_STYLE_LABEL = Object.freeze({
  default: '默认（毛玻璃圆角）',
  frosted: '渐变玻璃',
  wishes: '静谧祝愿（紫蓝柔光）',
  ember: '暗夜余烬（炭火余温）',
  arknights: '方舟观测（HUD 切角）',
  persona: '月相引路（P3 月夜）',
  solid: '实底卡片',
})
// 已经做了完整映射的 5 种；其余按 FALLBACK_STYLE 落到最近似的一种，UI 上标注。
export const CAPSULE_FOLLOW_READY = Object.freeze(['default', 'frosted', 'wishes', 'ember', 'solid'])
export const CAPSULE_FALLBACK_STYLE = Object.freeze({ arknights: 'mono-hud', persona: 'moon' })

// 面板变量的**完整封闭集合**：applyQaStyle 每次先按这张表清空、再逐条写。
// 预设自身不必给全（缺的落到 CSS 里的 var() 兜底），但清理必须全量，否则
// 「跟随 → 换回普通预设」会残留上一套的 wash / grain / glow。
export const QA_STYLE_VAR_KEYS = Object.freeze([
  '--dsmqa-bg', '--dsmqa-solid', '--dsmqa-fg', '--dsmqa-border',
  '--dsmqa-blur', '--dsmqa-radius', '--dsmqa-width', '--dsmqa-note',
  '--dsmqa-wash', '--dsmqa-grain', '--dsmqa-glow', '--dsmqa-sat',
])

const HEX6 = /^#[0-9a-f]{6}$/i
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)
const num = (raw, fallback) => {
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

// 胶囊皮肤名收敛：不在白名单里的一律当 default（胶囊侧读取也是这个口径）。
export function capsuleStyleOf(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return CAPSULE_STYLES.includes(s) ? s : 'default'
}

function hexOr(raw, fallback) {
  return typeof raw === 'string' && HEX6.test(raw) ? raw.toLowerCase() : fallback
}

// #rrggbb + 0..1 → #rrggbbaa。CSS 的 8 位十六进制在 Chromium 上一直可用，
// 比再写一层 color-mix 简单。
function withAlpha(hex, alpha) {
  const a = Math.round(clamp(num(alpha, 1), 0, 1) * 255).toString(16).padStart(2, '0')
  return hex + a
}

// 把三个 localStorage 对象收敛成一个稳定快照。任何一项缺失都能算出可用的默认值
// （用户没装歌词插件时，跟随模式应当退化成「默认毛玻璃」而不是报错或空白）。
export function normalizeCapsuleConfig(input) {
  const display = input && typeof input.display === 'object' && input.display ? input.display : {}
  const notice = input && typeof input.notice === 'object' && input.notice ? input.notice : {}
  const colors = input && typeof input.colors === 'object' && input.colors ? input.colors : {}

  return {
    style: capsuleStyleOf(display.capsuleStyle),
    // 胶囊面板不透明度 20–100（整数百分比），读时夹逼到合法域。
    panelOpacity: clamp(Math.round(num(display.panelOpacity, 100)), 20, 100),
    grain: clamp(num(notice.glassGrain, 30), 0, 100),
    tint: clamp(num(notice.glassTint, 35), 0, 100),
    ring: clamp(num(notice.glassRing, 70), 0, 100),
    accent: hexOr(notice.glassAccent, '#8b7cff'),
    akAccent: typeof notice.akAccent === 'string' && notice.akAccent !== 'theme'
      ? hexOr(notice.akAccent, '#5B8DEF')
      : '#5B8DEF',
    emberGlow: clamp(num(notice.emberGlow, 100), 0, 200),
    emberSpark: clamp(num(notice.emberSpark, 100), 0, 200),
    emberHalo: clamp(num(notice.emberHalo, 100), 0, 200),
    emberPace: clamp(num(notice.emberPace, 100), 50, 200),
    activeColor: hexOr(colors.active, ''),
  }
}

// 已经 normalize 过的快照带数值型 panelOpacity；裸的 localStorage 形状（含
// display/notice/colors 三个子对象）则没有。据此让调用方两种都能直接传。
function asCapsuleConfig(config) {
  const v = config && typeof config === 'object' ? config : null
  if (v && typeof v.style === 'string' && typeof v.panelOpacity === 'number') return v
  return normalizeCapsuleConfig(v)
}

// 跟随状态在 UI 上要说清的三件事：现在跟的是哪种胶囊、是否只是近似、参数从哪来。
export function capsuleFollowInfo(config) {
  const cfg = asCapsuleConfig(config)
  const ready = CAPSULE_FOLLOW_READY.includes(cfg.style)
  return {
    style: cfg.style,
    label: CAPSULE_STYLE_LABEL[cfg.style] || CAPSULE_STYLE_LABEL.default,
    ready,
    fallback: ready ? '' : (CAPSULE_FALLBACK_STYLE[cfg.style] || ''),
  }
}

// 主映射：胶囊快照 + 面板细参数 → --dsmqa-* 变量表。
// 细参数优先级高于胶囊（用户在面板里手动拖过滑杆，就按他拖的来）。
export function qaVarsFromCapsule(config, detail) {
  const cfg = asCapsuleConfig(config)
  const d = detail && typeof detail === 'object' ? detail : {}
  const alpha = clamp(
    Number.isFinite(d.opacity) ? d.opacity : cfg.panelOpacity / 100,
    0.3,
    1,
  )
  const radius = Number.isFinite(d.radius) ? d.radius : null
  const blur = Number.isFinite(d.blur) ? d.blur : null
  const width = Number.isFinite(d.width) ? d.width : null

  const vars = {}
  const base = (bgRgb, solid, fg, border, defBlur, defRadius, note, wash, grain, glow, sat) => {
    vars['--dsmqa-bg'] = `rgba(${bgRgb},${alpha.toFixed(2)})`
    vars['--dsmqa-solid'] = solid
    vars['--dsmqa-fg'] = fg
    vars['--dsmqa-border'] = border
    vars['--dsmqa-blur'] = (blur != null ? blur : defBlur) + 'px'
    vars['--dsmqa-radius'] = (radius != null ? radius : defRadius) + 'px'
    vars['--dsmqa-width'] = (width != null ? width : 760) + 'px'
    vars['--dsmqa-note'] = note
    vars['--dsmqa-wash'] = wash || 'none'
    vars['--dsmqa-grain'] = String(clamp(num(grain, 0), 0, 1))
    vars['--dsmqa-glow'] = glow || 'transparent'
    vars['--dsmqa-sat'] = String(num(sat, 1))
  }

  const grain01 = clamp(cfg.grain / 100, 0, 1)
  // 胶囊侧 glassRing 控制外圈亮度；这里换成描边透明度，70 为基准。
  const ringA = clamp(0.14 + (cfg.ring / 100) * 0.26, 0.14, 0.6).toFixed(2)

  switch (cfg.style) {
    case 'frosted':
      base(
        '26,27,32', '#1A1B20', '#F3F1EA',
        `rgba(139,124,255,${ringA})`,
        20, 14, 'rgba(243,241,234,.55)',
        `linear-gradient(135deg,${withAlpha('#8b7cff', (cfg.tint / 100) * 0.26)},transparent 46%,${withAlpha(cfg.accent, (cfg.tint / 100) * 0.22)})`,
        grain01 * 0.5,
        `rgba(139,124,255,${(0.10 + (cfg.ring / 100) * 0.18).toFixed(2)})`,
        1.3,
      )
      break
    case 'wishes':
      base(
        '18,20,44', '#12142C', '#E8E9FF',
        'rgba(199,204,255,.30)',
        26, 16, 'rgba(232,233,255,.58)',
        'linear-gradient(135deg,rgba(207,212,255,.26),rgba(91,103,216,.30))',
        0.18,
        'rgba(126,138,255,.34)',
        1.25,
      )
      break
    case 'ember':
      base(
        '13,7,5', '#0D0705', '#FFE9DA',
        `rgba(255,140,66,${(0.14 + (cfg.emberHalo / 200) * 0.14).toFixed(2)})`,
        16, 12, 'rgba(255,233,218,.55)',
        `radial-gradient(ellipse 70% 46% at 50% 0%,rgba(255,120,60,${((cfg.emberHalo / 200) * 0.16).toFixed(2)}),transparent 72%),linear-gradient(158deg,rgba(42,15,8,.42),rgba(13,7,5,.62))`,
        clamp((cfg.emberSpark / 200) * 0.30, 0, 0.32),
        `rgba(255,110,50,${((cfg.emberGlow / 200) * 0.22).toFixed(2)})`,
        1.08,
      )
      break
    case 'solid':
      // 实底：胶囊侧连 panelOpacity 都不生效（不透明卡没什么可混），这里只让
      // 细参数 opacity 改底色 alpha，其余固定。
      base(
        '20,20,22', '#141416', '#F2F2F2', 'rgba(255,255,255,.10)',
        0, 12, 'rgba(242,242,242,.55)', 'none', 0, 'transparent', 1,
      )
      vars['--dsmqa-bg'] = `rgba(20,20,22,${clamp(Number.isFinite(d.opacity) ? d.opacity : 1, 0.3, 1).toFixed(2)})`
      break
    case 'arknights':
      // 暂未移植：HUD 切角（clip-path）与框角需要额外 DOM 结构，先只借强调色与
      // 扫描线纹理，形状仍是圆角——UI 上会标注「近似」。
      base(
        '14,16,18', '#0E1012', '#E6EDF2',
        `rgba(${hexToRgbTriplet(cfg.akAccent)},${ringA})`,
        18, 8, 'rgba(230,237,242,.55)',
        `repeating-linear-gradient(0deg,${withAlpha(cfg.akAccent, 0.06)} 0 1px,transparent 1px 4px)`,
        grain01 * 0.2,
        `rgba(${hexToRgbTriplet(cfg.akAccent)},0.16)`,
        1.1,
      )
      break
    case 'persona':
      // 暂未移植：月相环与月亮阴影需要时间/相位计算，先借蓝白配色。
      base(
        '12,16,28', '#0C101C', '#EAF1FF',
        'rgba(127,184,255,.26)',
        22, 16, 'rgba(234,241,255,.55)',
        'radial-gradient(circle at calc(100% - 22px) 22px,rgba(238,244,255,.16) 0 9px,transparent 10px),linear-gradient(150deg,rgba(127,184,255,.16),transparent 60%)',
        0.14,
        'rgba(127,184,255,.24)',
        1.15,
      )
      break
    case 'default':
    default:
      base(
        '24,24,26', '#18181A', '#F1EFE8', 'rgba(127,127,127,.22)',
        14, 14, 'rgba(241,239,232,.55)', 'none', 0, 'transparent', 1,
      )
      break
  }

  // 歌词高亮色当强调色用：用户在歌词插件里调过「当前句高亮」，面板的悬停/选中
  // 描边跟着它走，比固定紫色更贴合他自己的配色。仅在跟随模式且值合法时生效。
  if (cfg.activeColor) {
    const rgb = hexToRgbTriplet(cfg.activeColor)
    vars['--dsmqa-glow'] = `rgba(${rgb},0.20)`
    if (cfg.style === 'default' || cfg.style === 'solid') {
      vars['--dsmqa-border'] = `rgba(${rgb},0.28)`
    }
  }
  return vars
}

// #rrggbb → "r,g,b"。内部用，非法输入当作中性灰（避免 rgba(,) 这种非法值）。
export function hexToRgbTriplet(hex) {
  const v = typeof hex === 'string' && HEX6.test(hex) ? hex.slice(1) : ''
  if (v.length !== 6) return '127,127,127'
  const r = parseInt(v.slice(0, 2), 16)
  const g = parseInt(v.slice(2, 4), 16)
  const b = parseInt(v.slice(4, 6), 16)
  return `${r},${g},${b}`
}
