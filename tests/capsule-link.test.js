// v3.13.0：「面板外观跟随歌词胶囊」的纯判定层回归。
//
// 目标：胶囊侧的 7 种皮肤 + 材质参数能稳定翻译成面板的 --dsmqa-* 变量；
// 输入缺失/脏数据时不炸也不产出非法 CSS 值（非法 rgba 会让整条声明失效，
// 面板会突然变成透明、文字看不见）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAPSULE_COLOR_KEY,
  CAPSULE_DISPLAY_KEY,
  CAPSULE_EVENTS,
  CAPSULE_FOLLOW_READY,
  CAPSULE_NOTICE_KEY,
  CAPSULE_STYLES,
  CAPSULE_STYLE_LABEL,
  FOLLOW_PRESET,
  QA_STYLE_VAR_KEYS,
  capsuleFollowInfo,
  capsuleStyleOf,
  hexToRgbTriplet,
  normalizeCapsuleConfig,
  qaVarsFromCapsule,
} from '../src/client/capsule-link.js'

// ---- 常量与存储键 --------------------------------------------------------

test('capsule link: storage keys and events mirror the lyrics plugin constants', () => {
  assert.equal(CAPSULE_DISPLAY_KEY, 'dsh.netease-lyrics.display.v1')
  assert.equal(CAPSULE_NOTICE_KEY, 'dsh.netease-lyrics.notice.v1')
  assert.equal(CAPSULE_COLOR_KEY, 'dsh.netease-lyrics.colors.v1')
  assert.deepEqual([...CAPSULE_EVENTS], [
    'dsh-netease-lyrics-display',
    'dsh-netease-lyrics-notice',
    'dsh-netease-lyrics-colors',
  ])
  // 跟随哨兵不能和任何真实预设同名，否则 readQaStyle 会先查到预设表。
  assert.equal(FOLLOW_PRESET, 'follow-capsule')
  assert.ok(!CAPSULE_STYLES.includes(FOLLOW_PRESET))
})

test('capsule link: every capsule style has a label and the 5 ready ones are mapped', () => {
  assert.deepEqual([...CAPSULE_STYLES], ['default', 'frosted', 'wishes', 'ember', 'arknights', 'persona', 'solid'])
  for (const key of CAPSULE_STYLES) {
    assert.equal(typeof CAPSULE_STYLE_LABEL[key], 'string', 'missing label for ' + key)
    assert.ok(CAPSULE_STYLE_LABEL[key].length > 0)
  }
  assert.deepEqual([...CAPSULE_FOLLOW_READY], ['default', 'frosted', 'wishes', 'ember', 'solid'])
})

test('capsule link: applyQaStyle var whitelist covers every var the mapping can emit', () => {
  for (const key of Object.keys(qaVarsFromCapsule(null, null))) {
    assert.ok(QA_STYLE_VAR_KEYS.includes(key), 'var not in cleanup whitelist: ' + key)
  }
  for (const style of CAPSULE_STYLES) {
    const vars = qaVarsFromCapsule({ display: { capsuleStyle: style } }, null)
    for (const key of Object.keys(vars)) {
      assert.ok(QA_STYLE_VAR_KEYS.includes(key), 'var not in cleanup whitelist: ' + key + ' (style ' + style + ')')
    }
  }
})

// ---- 输入收敛 ------------------------------------------------------------

test('capsule link: capsuleStyleOf collapses unknown / dirty names onto default', () => {
  assert.equal(capsuleStyleOf('frosted'), 'frosted')
  assert.equal(capsuleStyleOf('  EMBER '), 'ember')
  assert.equal(capsuleStyleOf('nope'), 'default')
  assert.equal(capsuleStyleOf(''), 'default')
  assert.equal(capsuleStyleOf(null), 'default')
  assert.equal(capsuleStyleOf(42), 'default')
  assert.equal(capsuleStyleOf({}), 'default')
})

test('capsule link: normalizeCapsuleConfig works with nothing at all', () => {
  for (const raw of [null, undefined, {}, 'junk', 42, []]) {
    const cfg = normalizeCapsuleConfig(raw)
    assert.equal(cfg.style, 'default')
    assert.equal(cfg.panelOpacity, 100)
    assert.equal(cfg.grain, 30)
    assert.equal(cfg.tint, 35)
    assert.equal(cfg.ring, 70)
    assert.equal(cfg.accent, '#8b7cff')
    assert.equal(cfg.akAccent, '#5B8DEF')
    assert.equal(cfg.emberGlow, 100)
    assert.equal(cfg.emberPace, 100)
    assert.equal(cfg.activeColor, '')
  }
})

test('capsule link: normalizeCapsuleConfig clamps the numeric knobs', () => {
  const cfg = normalizeCapsuleConfig({
    display: { capsuleStyle: 'ember', panelOpacity: 5 },
    notice: { glassGrain: 999, glassTint: -20, glassRing: '60', emberGlow: 900, emberPace: 10 },
    colors: { active: '#FF0000' },
  })
  assert.equal(cfg.style, 'ember')
  assert.equal(cfg.panelOpacity, 20, 'panelOpacity floor is 20')
  assert.equal(cfg.grain, 100)
  assert.equal(cfg.tint, 0)
  assert.equal(cfg.ring, 60, 'numeric strings are accepted')
  assert.equal(cfg.emberGlow, 200)
  assert.equal(cfg.emberPace, 50, 'pace floor is 50')
  assert.equal(cfg.activeColor, '#ff0000')

  const high = normalizeCapsuleConfig({ display: { panelOpacity: 250 } })
  assert.equal(high.panelOpacity, 100)
})

test('capsule link: normalizeCapsuleConfig rejects malformed colors and theme akAccent', () => {
  assert.equal(normalizeCapsuleConfig({ notice: { glassAccent: 'red' } }).accent, '#8b7cff')
  assert.equal(normalizeCapsuleConfig({ notice: { glassAccent: '#GGGGGG' } }).accent, '#8b7cff')
  assert.equal(normalizeCapsuleConfig({ colors: { active: '#abc' } }).activeColor, '')
  // akAccent: "theme" 在胶囊侧表示「用宿主品牌色」，这里不能当成十六进制色。
  assert.equal(normalizeCapsuleConfig({ notice: { akAccent: 'theme' } }).akAccent, '#5B8DEF')
  assert.equal(normalizeCapsuleConfig({ notice: { akAccent: '#ff8800' } }).akAccent, '#ff8800')
})

// ---- UI 提示 -------------------------------------------------------------

test('capsule link: capsuleFollowInfo flags the two not-yet-ported styles', () => {
  const ready = capsuleFollowInfo({ display: { capsuleStyle: 'wishes' } })
  assert.equal(ready.style, 'wishes')
  assert.equal(ready.label, CAPSULE_STYLE_LABEL.wishes)
  assert.equal(ready.ready, true)
  assert.equal(ready.fallback, '')

  const ak = capsuleFollowInfo({ display: { capsuleStyle: 'arknights' } })
  assert.equal(ak.ready, false)
  assert.equal(ak.fallback, 'mono-hud')
  assert.ok(ak.label.includes('方舟'))

  const persona = capsuleFollowInfo({ display: { capsuleStyle: 'persona' } })
  assert.equal(persona.fallback, 'moon')

  // 脏输入也必须有可用提示，不能抛。
  assert.equal(capsuleFollowInfo(null).style, 'default')
})

// ---- 主映射 --------------------------------------------------------------

test('capsule link: qaVarsFromCapsule emits a complete var set for every style', () => {
  for (const style of CAPSULE_STYLES) {
    const vars = qaVarsFromCapsule({ display: { capsuleStyle: style } }, null)
    for (const key of QA_STYLE_VAR_KEYS) {
      assert.equal(typeof vars[key], 'string', key + ' missing for style ' + style)
      assert.ok(vars[key].length > 0, key + ' empty for style ' + style)
    }
    // 任何 rgba(...) 里的通道数必须正确，否则整条 CSS 声明失效。
    const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(vars['--dsmqa-bg'])
    assert.ok(m, 'bad --dsmqa-bg for ' + style + ': ' + vars['--dsmqa-bg'])
    for (const ch of [m[1], m[2], m[3]]) assert.ok(Number(ch) >= 0 && Number(ch) <= 255)
    const a = Number(m[4])
    assert.ok(a >= 0.3 && a <= 1, 'alpha out of range for ' + style + ': ' + a)
    assert.ok(/px$/.test(vars['--dsmqa-blur']))
    assert.ok(/px$/.test(vars['--dsmqa-radius']))
    assert.ok(/px$/.test(vars['--dsmqa-width']))
  }
})

test('capsule link: panelOpacity drives the panel background alpha', () => {
  const vars = qaVarsFromCapsule({ display: { capsuleStyle: 'default', panelOpacity: 60 } }, null)
  assert.ok(vars['--dsmqa-bg'].endsWith(',0.60)'), vars['--dsmqa-bg'])
  const full = qaVarsFromCapsule({ display: { capsuleStyle: 'default', panelOpacity: 100 } }, null)
  assert.ok(full['--dsmqa-bg'].endsWith(',1.00)'), full['--dsmqa-bg'])
})

test('capsule link: panel sliders win over the capsule snapshot', () => {
  const vars = qaVarsFromCapsule(
    { display: { capsuleStyle: 'frosted', panelOpacity: 40 } },
    { radius: 4, blur: 2, opacity: 0.5, width: 900 },
  )
  assert.equal(vars['--dsmqa-radius'], '4px')
  assert.equal(vars['--dsmqa-blur'], '2px')
  assert.equal(vars['--dsmqa-width'], '900px')
  assert.ok(vars['--dsmqa-bg'].endsWith(',0.50)'), vars['--dsmqa-bg'])
  // 只给一个细参数时其余仍取胶囊/默认值。
  const partial = qaVarsFromCapsule({ display: { capsuleStyle: 'frosted' } }, { radius: 6 })
  assert.equal(partial['--dsmqa-radius'], '6px')
  assert.equal(partial['--dsmqa-blur'], '20px', 'frosted default blur')
})

test('capsule link: frosted honours grain / tint / ring knobs', () => {
  const low = qaVarsFromCapsule({ display: { capsuleStyle: 'frosted' }, notice: { glassTint: 0, glassRing: 0 } }, null)
  const high = qaVarsFromCapsule({ display: { capsuleStyle: 'frosted' }, notice: { glassTint: 100, glassRing: 100 } }, null)
  assert.notEqual(low['--dsmqa-wash'], high['--dsmqa-wash'])
  // ring 越大描边越亮
  const lowA = Number(/rgba\(139,124,255,([\d.]+)\)/.exec(low['--dsmqa-border'])[1])
  const highA = Number(/rgba\(139,124,255,([\d.]+)\)/.exec(high['--dsmqa-border'])[1])
  assert.ok(highA > lowA)
})

test('capsule link: ember honours the four ember knobs', () => {
  const dim = qaVarsFromCapsule({ display: { capsuleStyle: 'ember' }, notice: { emberGlow: 0, emberSpark: 0, emberHalo: 0 } }, null)
  const bright = qaVarsFromCapsule({ display: { capsuleStyle: 'ember' }, notice: { emberGlow: 200, emberSpark: 200, emberHalo: 200 } }, null)
  assert.notEqual(dim['--dsmqa-wash'], bright['--dsmqa-wash'])
  assert.notEqual(dim['--dsmqa-glow'], bright['--dsmqa-glow'])
  assert.equal(dim['--dsmqa-grain'], '0')
  assert.ok(Number(bright['--dsmqa-grain']) > 0)
})

test('capsule link: solid stays opaque even when the capsule knob says 40', () => {
  const viaCapsule = qaVarsFromCapsule({ display: { capsuleStyle: 'solid', panelOpacity: 40 } }, null)
  assert.ok(viaCapsule['--dsmqa-bg'].endsWith(',1.00)'), 'solid ignores panelOpacity: ' + viaCapsule['--dsmqa-bg'])
  const viaSlider = qaVarsFromCapsule({ display: { capsuleStyle: 'solid' } }, { opacity: 0.6 })
  assert.ok(viaSlider['--dsmqa-bg'].endsWith(',0.60)'), 'explicit slider still applies: ' + viaSlider['--dsmqa-bg'])
  assert.equal(viaCapsule['--dsmqa-blur'], '0px')
})

test('capsule link: arknights borrows the ak accent and keeps a scanline wash', () => {
  const vars = qaVarsFromCapsule({ display: { capsuleStyle: 'arknights' }, notice: { akAccent: '#ff8800' } }, null)
  assert.ok(vars['--dsmqa-wash'].includes('repeating-linear-gradient'), vars['--dsmqa-wash'])
  assert.ok(vars['--dsmqa-wash'].includes('#ff8800'), 'wash uses the ak accent: ' + vars['--dsmqa-wash'])
  assert.ok(vars['--dsmqa-border'].includes('255,136,0'), vars['--dsmqa-border'])
})

test('capsule link: lyric highlight colour becomes the panel accent when given', () => {
  const plain = qaVarsFromCapsule({ display: { capsuleStyle: 'default' } }, null)
  const tinted = qaVarsFromCapsule({ display: { capsuleStyle: 'default' }, colors: { active: '#22C55E' } }, null)
  assert.equal(plain['--dsmqa-glow'], 'transparent')
  assert.equal(tinted['--dsmqa-glow'], 'rgba(34,197,94,0.20)')
  assert.equal(tinted['--dsmqa-border'], 'rgba(34,197,94,0.28)')
  // 语义色只在 default / solid 上替换描边，避免把 wishes 的紫蓝环改成绿色。
  const wishes = qaVarsFromCapsule({ display: { capsuleStyle: 'wishes' }, colors: { active: '#22C55E' } }, null)
  assert.notEqual(wishes['--dsmqa-border'], 'rgba(34,197,94,0.28)')
  assert.equal(wishes['--dsmqa-glow'], 'rgba(34,197,94,0.20)')
})

test('capsule link: hexToRgbTriplet never emits a malformed triplet', () => {
  assert.equal(hexToRgbTriplet('#8b7cff'), '139,124,255')
  assert.equal(hexToRgbTriplet('#FFFFFF'), '255,255,255')
  assert.equal(hexToRgbTriplet('#000000'), '0,0,0')
  for (const bad of ['', 'red', '#abc', '#GGGGGG', null, undefined, 12, {}]) {
    assert.equal(hexToRgbTriplet(bad), '127,127,127')
  }
})
