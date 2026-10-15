import ReactECharts from 'echarts-for-react'
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { C, FONT, itTimeLabel, legendBase } from './theme'

type O = Record<string, unknown>
const asArr = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : [])

/**
 * Enforces the shared chart style on every option, so individual charts can't drift:
 * legend top-left / inline / 8px squares / never paginated · no vertical gridlines · horizontal gridlines rgba(255,255,255,.04).
 */
/** Rough legend height for the current width: the legend never paginates, so long legends wrap onto more rows. */
function legendRows(l: O, series: unknown, width: number): number {
  if (!l || l.show === false || width <= 0) return 0
  const names = (Array.isArray(l.data) ? (l.data as unknown[]) : asArr(series).map((x) => (x as O)?.name))
    .map((x) => (typeof x === 'string' ? x : (x as O)?.name)).filter((x): x is string => typeof x === 'string' && !x.startsWith('_'))
  if (!names.length) return 0
  let rows = 1, line = 0
  for (const n of names) {
    const w = 8 + 5 + n.length * 6.6 + 14
    if (line + w > width - 16 && line > 0) { rows++; line = 0 }
    line += w
  }
  return rows
}

function normalize(option: O, width = 0): O {
  const out: O = { ...option }
  // make room for wrapped top legends so they never overlap the plot or the axis labels
  const lg = option.legend as O | undefined
  const g = option.grid as O | undefined
  if (lg && !Array.isArray(lg) && g && !Array.isArray(g) && (lg.top === undefined || lg.top === 0) && lg.bottom === undefined) {
    const rows = legendRows(lg, option.series, width)
    const need = rows ? rows * 20 + 14 : 0
    if (rows > 1 && typeof g.top === 'number' && g.top < need) out.grid = { ...g, top: need }
  }
  if (option.legend) {
    const fix = (l: O) => {
      if (!l || l.show === false) return l
      const { pageTextStyle: _p, pageIconColor: _i, ...rest } = l
      void _p; void _i
      return { ...rest, type: 'plain', icon: 'roundRect', itemWidth: 10, itemHeight: 4, itemGap: 16, left: rest.left ?? 0, inactiveColor: legendBase.inactiveColor,
        textStyle: { ...legendBase.textStyle, ...(rest.textStyle as O | undefined), fontSize: 12 } }
    }
    out.legend = Array.isArray(option.legend) ? (option.legend as O[]).map(fix) : fix(option.legend as O)
  }
  const fixAxis = (horizontalGrid: boolean) => (a0: O) => {
    if (!a0 || typeof a0 !== 'object') return a0
    // Italian month names on every time axis (ECharts defaults to English)
    const lbl = a0.axisLabel as O | undefined
    const a = a0.type === 'time' && !(lbl && lbl.formatter) ? { ...a0, axisLabel: { ...(lbl ?? {}), formatter: itTimeLabel } } : a0
    const split = a.splitLine as O | undefined
    if (!horizontalGrid) {
      // x axes: the first/last tick label is aligned inwards so it is never cut by the card edge ("5 Oct" → "Oct")
      const xl = (a.axisLabel as O | undefined) ?? {}
      const edge = (a.type === 'time' || a.type === 'value') && xl.alignMinLabel === undefined && xl.alignMaxLabel === undefined
        ? { axisLabel: { ...xl, alignMinLabel: 'left', alignMaxLabel: 'right' } } : {}
      return { ...a, ...edge, splitLine: { ...(split ?? {}), show: false } }
    }
    if (split?.show === false) return a
    return { ...a, splitLine: { ...(split ?? {}), lineStyle: { ...((split?.lineStyle as O) ?? {}), color: C.grid } } }
  }
  if (option.xAxis) out.xAxis = Array.isArray(option.xAxis) ? asArr(option.xAxis).map(fixAxis(false)) : fixAxis(false)(option.xAxis as O)
  if (option.yAxis) out.yAxis = Array.isArray(option.yAxis) ? asArr(option.yAxis).map(fixAxis(true)) : fixAxis(true)(option.yAxis as O)
  return out
}

/** Structural fingerprint of an option: top-level components, series (type/name/keys) and component counts. */
function optionShape(o: O): string {
  const keys = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x as O).sort().join(',') : '')
  return JSON.stringify([
    Object.keys(o).sort(),
    asArr(o.series).map((s) => { const x = s as O; return [x.type, x.name, x.id, keys(x), keys(x.markLine), keys(x.markArea), keys(x.markPoint), asArr((x.markLine as O)?.data).length, asArr((x.markPoint as O)?.data).length, asArr((x.markArea as O)?.data).length] }),
    ...['xAxis', 'yAxis', 'grid', 'visualMap', 'dataZoom', 'graphic', 'legend', 'title'].map((k) => [k, asArr(o[k]).length, asArr(o[k]).map(keys)]),
    asArr(((o.graphic as O)?.elements ?? o.graphic) as unknown).length,
  ])
}

/** Themed ECharts wrapper. Animates only on first paint so live re-renders don't replay animations. */
function EChartInner({
  option, height = 280, className, style, onEvents,
}: { option: Record<string, unknown>; height?: number | string; className?: string; style?: CSSProperties; onEvents?: Record<string, (p: unknown) => void> }) {
  const mounted = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => { mounted.current = true }, 800)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => {
    const el = box.current
    if (!el) return
    // width in 40px steps: enough to re-layout wrapped legends without re-rendering on every pixel
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth / 40) * 40))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const full = useMemo(
    () => ({
      backgroundColor: 'transparent',
      animation: !mounted.current,
      animationDuration: 350,
      animationDurationUpdate: 200,
      textStyle: { fontFamily: FONT },
      ...normalize(option, width),
    }),
    [option, width],
  )
  // same structure (series, axes, components) → merge: the update keeps tooltip and hover state;
  // different structure → full replace so nothing stale survives
  const shape = useMemo(() => optionShape(full), [full])
  const prevShape = useRef(shape)
  const replace = prevShape.current !== shape
  useEffect(() => { prevShape.current = shape }, [shape])  // after commit: render may run twice (StrictMode)
  // live charts get a new option on every tick and setOption(notMerge) closes the tooltip:
  // remember where the pointer is and reopen the tooltip there after each update
  const chart = useRef<ReactECharts>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const at = pointer.current
    if (!at) return
    const show = () => {
      const inst = chart.current?.getEchartsInstance()
      if (inst && !inst.isDisposed() && pointer.current) inst.dispatchAction({ type: 'showTip', x: pointer.current.x, y: pointer.current.y })
    }
    // twice: lazyUpdate may repaint one frame later and hide it again
    const raf = requestAnimationFrame(show)
    const tid = setTimeout(show, 80)
    return () => { cancelAnimationFrame(raf); clearTimeout(tid) }
  }, [full])
  return (
    <div ref={box} className={className} style={{ height, width: '100%', ...style }}
      onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top } }}
      onMouseLeave={() => { pointer.current = null }}>
    <ReactECharts
      ref={chart}
      option={full}
      notMerge={replace}
      lazyUpdate
      style={{ height: '100%', width: '100%' }}
      opts={{ renderer: 'canvas' }}
      onEvents={onEvents}
    />
    </div>
  )
}

const EChart = memo(EChartInner)
export default EChart
