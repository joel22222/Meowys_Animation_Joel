import { forwardRef, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Edges, Html, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'

/* Single infeed lane with ONE separator device (scanner + divider) at the END of the lane, two half-holds,
   and a shuttling platform on each side.
   - The separator sits behind the end of the belt, so bags never pass through it: each bag stops at it, is classified
     (irregular / rigid, plus mass) and is pushed left or right.
   - The divider sends irregular bags LEFT and rigid bags RIGHT, so a rigid bag is never stacked on an irregular one.
   - If the preferred side is full, the bag goes to the other side, which still has space (no buffer bays needed).
   - The infeed belts are FIXED at the door. The platform (orange) runs on a guide rail along the half-hold:
     back to the front to pick the bag up, along the hold to the slot, push it in, and back again.
   - Unloading is the reverse; bags leave through the same single lane.
   Props: sortOn = scanner + divider active (false = bags simply alternate left/right, for comparison). */

// ---------- constants ----------
const HL = 3.7, H = 1.2, W = 1.5, NS = 60, NT = 120
const LANE_Z0 = 6.0                        // where bags enter the single infeed lane (docking-base side)
const TIP0 = 0.4                           // belt end / pick-up point (m from the centreline). The belts are fixed.
const SPAWN_SYS = 4.4                      // seconds between bags on the single lane (about 13.6 bags/min)
const SPAWN_U = 8.8                        // seconds between bags per side when unloading (two sides, same rate)
const GAP_S = 2                            // unloading: the two platforms never send bags to the centre lane less than 2 s apart
const GATE = 0.3                           // bags wait here (m from the centre) on their own belt until the centre lane is free
const IRR_PCT = 55                         // simulation assumption: share of bags that are irregular (soft)
const PAL = ['#2f4b7c', '#b23a48', '#6b8e4e', '#c9a66b', '#3a7d7c', '#d98e32', '#4a4f57']
const FABRIC = ['#7a4e3a', '#2f5d50', '#7a2e3b', '#3d4f7a', '#8a6f3b', '#5a5a66'] // soft-bag fabric colours

// ===== BEGIN SIM (plain JS, no React/three needed) =====
const ease = (x) => x * x * (3 - 2 * x)

// 60 slots per side in loading order (far column first, bottom layer first)
const SLS = []
for (let c = 5; c >= 0; c--)
  for (let l = 0; l < 3; l++)
    for (const z of [-0.3, 0.3, -0.9, 0.9]) {
      if (l === 2 && Math.abs(z) > 0.6) continue // low ceiling at the sides
      SLS.push({ c, d: 0.9 + 0.5 * c, y: 0.21 + 0.34 * l, z, l, below: -1 })
    }
SLS.forEach((s) => { if (s.l > 0) s.below = SLS.findIndex((o) => o.c === s.c && o.z === s.z && o.l === s.l - 1) })

// platform motion: time to travel d metres from rest to rest at acceleration a (m/s^2), with a short minimum
const travelT = (d, a) => Math.max(0.5, 2 * Math.sqrt(Math.abs(d) / a))
const ACC_LOAD = 1.5, ACC_EMPTY = 2.0   // gentle with a bag on board, quicker when the platform is empty

// unloading order: nearest column first, top layer first (target always has exposed faces)
const UNLOAD_ORDER = SLS.map((_, i) => i).sort((a, b) =>
  SLS[a].d - SLS[b].d || SLS[b].y - SLS[a].y || Math.abs(SLS[a].z) - Math.abs(SLS[b].z) || SLS[a].z - SLS[b].z)

// bag attributes: deterministic pseudo-random so every run is repeatable (stands in for the door scanner)
const MASSES = [20, 21, 22, 23, 24, 26, 28, 30, 32]
const hash = (i) => { let h = ((i + 1) * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return h >>> 0 }
const ATTR = Array.from({ length: NT }, (_, m) => {
  const h = hash(m)
  return { mass: MASSES[h % 9], irr: (h >>> 8) % 100 < IRR_PCT }
})

const free = (st, i) => {
  const s = SLS[i]
  return st.occ[i] < 0 && !st.res[i] && (s.below < 0 || st.occ[s.below] >= 0 || st.res[s.below])
}
const planNormal = (st) => { for (let i = 0; i < NS; i++) if (free(st, i)) return i; return -1 } // lowest free slot, far end first
const used = (st) => st.occ.filter((v) => v >= 0).length + st.res.filter(Boolean).length

// the divider: side 1 = LEFT (irregular), side 0 = RIGHT (rigid). If the preferred side is full, use the other one.
const chooseSide = (sortOn, m, P) => {
  const want = sortOn ? (ATTR[m].irr ? 1 : 0) : m % 2
  const s = used(P[want]) >= NS ? 1 - want : want
  return { s, want }
}
function dryFill(sortOn) { // a full, already-sorted hold (start state for unloading)
  const P = [0, 1].map(() => ({ occ: Array(NS).fill(-1), res: Array(NS).fill(false) }))
  for (let m = 0; m < NT; m++) { const { s } = chooseSide(sortOn, m, P); P[s].occ[planNormal(P[s])] = m }
  return P.map((p) => p.occ)
}

// hx = platform position along the hold (distance from the hold centreline)
const mkArm = (s) => ({
  s, sg: s ? -1 : 1, tip: TIP0, hx: TIP0, ret: null, hz: 0, hy: 0.165, off: 0, act: [], nx: 0, timer: s ? SPAWN_U - GAP_S : SPAWN_U, man: false, // left platform starts 2 s after the right one
  occ: Array(NS).fill(-1), res: Array(NS).fill(false), order: [],
})
const mkG = (mode, sortOn) => ({ mode, sortOn, t: 0, done: 0, nx: 0, timer: SPAWN_SYS, overflow: 0, lastEnter: -99, finished: false, cap: '', key: '' })

const pad = (S, p, c) => S.R[p.s].padM?.color.set(c)

// one carry move between the belt end (u = 0) and the slot (u = 1).
// fA = share of the move spent shuttling along the hold (and lining up with the slot); the rest is the pusher's last half metre.
const setPos = (b, u, sl, p, fA) => {
  const A = Math.min(1, u / fA), B = Math.max(0, (u - fA) / (1 - fA)), ready = sl.d - 0.5
  p.hx = p.tip + (ready - p.tip) * ease(A)
  const bx = B > 0 ? ready + (sl.d - ready) * ease(B) : p.hx
  b.position.set(p.sg * bx, 0.33 + (sl.y - 0.33) * ease(A), sl.z * ease(A))
}
const carryPlan = (sl, p) => { const ta = travelT(sl.d - 0.5 - p.tip, ACC_LOAD); return [ta + 0.7, ta / (ta + 0.7)] }

const laneBusyAt = (S, z) => S.P.some((q) => q.act.some((a) => a.ph === 'in' && S.bags[a.m].position.z > z))
const laneOutBusy = (S) => S.P.some((q) => q.act.some((a) => a.ph === 'out' && S.bags[a.m].position.z < 1.2))

function side(S, p, dt) {
  const g = S.G, bags = S.bags, load = g.mode === 'load', sg = p.sg
  const man = p.act.some((a) => a.ph === 'place' || a.ph === 'pick' || a.ph === 'fetch')
  p.man = man

  // when idle (loading) the platform returns to the front, the belt end, to wait for the next bag
  if (man) p.ret = null
  else if (load && p.hx > p.tip + 0.001) {
    if (!p.ret) p.ret = { from: p.hx, tm: 0, dur: travelT(p.hx - p.tip, ACC_EMPTY) }
    p.ret.tm += dt
    const v = Math.min(1, p.ret.tm / p.ret.dur)
    p.hx = p.ret.from + (p.tip - p.ret.from) * ease(v)
    if (v >= 1) p.ret = null
  } else p.ret = null

  // unloading: one bag per side every SPAWN_U seconds
  if (!load) {
    p.timer += dt
    if (p.nx < p.order.length && p.timer >= SPAWN_U && !man) {
      p.timer = 0
      const slot = p.order[p.nx++], m = p.occ[slot]
      p.act.push({ m, ph: 'pick', sub: 'aim', tm: 0, u: 1, hz: 0, hy: 0.165, hx0: p.hx, slot, aimDur: Math.max(0.7, travelT(SLS[slot].d - 0.5 - p.hx, ACC_EMPTY)) })
    }
  }

  for (const a of p.act) {
    const b = bags[a.m], sl = SLS[a.slot]
    const other = p.act.some((o) => o !== a && (o.ph === 'place' || o.ph === 'pick' || o.ph === 'fetch'))
    if (a.ph === 'in') { // down the single lane, then the divider turns the bag onto this side's belt
      b.position.z -= 1.6 * dt
      if (b.position.z <= 0) { b.position.set(0, 0.33, 0); a.ph = 'belt' }
    } else if (a.ph === 'belt') {
      if (load) { // the bag only rides to the BELT END; the platform comes to it
        const d = Math.min(sg * b.position.x + 1.6 * dt, p.tip)
        b.position.set(sg * d, 0.33, 0)
        if (d >= p.tip - 0.001 && !other) { a.ph = 'fetch'; a.tm = 0; a.hx0 = p.hx }
      } else { // back toward the centre; wait at the gate until the centre lane is free and 2 s after the previous bag
        let d = sg * b.position.x - 1.6 * dt
        if (!a.cleared && d <= GATE) {
          d = GATE
          if (g.t - g.lastEnter >= GAP_S && !laneOutBusy(S)) { a.cleared = true; g.lastEnter = g.t }
        }
        b.position.set(sg * Math.max(d, 0), 0.33, 0)
        if (d <= 0) a.ph = 'out'
      }
    } else if (a.ph === 'fetch') { // platform comes back to the front to pick the bag up
      const dist = Math.abs(a.hx0 - p.tip), dur = dist < 0.01 ? 0.01 : travelT(dist, ACC_EMPTY)
      a.tm += dt
      const v = Math.min(1, a.tm / dur)
      p.hx = a.hx0 + (p.tip - a.hx0) * ease(v)
      if (v >= 1) { a.ph = 'place'; a.u = 0; [a.dur, a.fA] = carryPlan(sl, p) }
    } else if (a.ph === 'out') {
      b.position.z += 1.6 * dt
      if (b.position.z > 3.6) { b.visible = false; g.done++; a.ph = 'fin' }
    } else if (a.ph === 'place') {
      a.u += dt / a.dur
      if (a.u >= 1) { b.position.set(sg * sl.d, sl.y, sl.z); p.hx = sl.d - 0.5; p.occ[a.slot] = a.m; p.res[a.slot] = false; g.done++; a.ph = 'fin' }
      else setPos(b, a.u, sl, p, a.fA)
    } else if (a.ph === 'pick') {
      a.tm += dt
      if (a.sub === 'aim') { // platform moves out to the cleared space in front of the bag and lines up with it
        const v = Math.min(1, a.tm / a.aimDur), ready = sl.d - 0.5
        p.hx = a.hx0 + (ready - a.hx0) * ease(v)
        a.hz = sl.z * ease(v); a.hy = 0.33 + (sl.y - 0.33) * ease(v) - 0.17
        if (v >= 1) { a.sub = 'grasp'; a.tm = 0; pad(S, p, '#ffc400') }
      } else if (a.sub === 'grasp') {
        if (a.tm >= 0.6) {
          if (a.m % 7 === 3 && !a.tried) { a.tried = 1; a.sub = 'retry'; a.tm = 0; a.z0 = a.hz; a.y0 = a.hy; pad(S, p, '#e5322d') }
          else { a.sub = 'pull'; a.u = 1; [a.dur, a.fA] = carryPlan(sl, p); pad(S, p, '#2ecc71') }
        }
      } else if (a.sub === 'retry') {
        const v = Math.min(1, a.tm / 0.7)
        a.hz = a.z0 + 0.08 * ease(v); a.hy = a.y0 + 0.04 * ease(v)
        if (v >= 1) { a.sub = 'grasp'; a.tm = 0; pad(S, p, '#ffc400') }
      } else { // pull the bag onto the platform, carry it back to the front and hand it to the belt
        a.u -= dt / a.dur
        if (a.u <= 0) { a.ph = 'belt'; p.hx = p.tip; p.occ[a.slot] = -1; b.position.set(sg * p.tip, 0.33, 0) }
        else setPos(b, a.u, sl, p, a.fA)
      }
    }
  }
  p.act = p.act.filter((a) => a.ph !== 'fin')
  p.off += (load ? 1 : -1) * 1.6 * dt * (p.act.some((a) => a.ph === 'belt' || a.ph === 'in' || a.ph === 'out') ? 1 : 0)
}

function step(S, dt) {
  const g = S.G, load = g.mode === 'load'
  g.t += dt

  // loading: bags arrive on ONE lane, the scanner classifies, the divider picks the side
  if (load && g.nx < NT) {
    g.timer += dt
    if (g.timer >= SPAWN_SYS) {
      const m = g.nx, { s, want } = chooseSide(g.sortOn, m, S.P), p = S.P[s]
      const clear = !p.act.some((a) => a.ph === 'in' || a.ph === 'belt') && !laneBusyAt(S, LANE_Z0 - 0.9) // back-pressure
      if (clear) {
        g.timer = 0; g.nx++
        const b = S.bags[m]
        b.visible = true; b.position.set(0, 0.33, LANE_Z0); b.rotation.set(0, 0, 0)
        const i = planNormal(p); p.res[i] = true
        const over = g.sortOn && s !== want
        if (over) g.overflow++
        p.act.push({ m, ph: 'in', slot: i, over })
      }
    }
  }

  S.P.forEach((p) => side(S, p, dt))
  if (g.done >= NT && !S.P.some((p) => p.act.length)) g.finished = true

  const all = S.P.flatMap((p) => p.act)
  const f = (ph, sub) => all.some((a) => a.ph === ph && (!sub || a.sub === sub))
  const first = (fn) => all.find(fn)
  const info = (a) => { const t = ATTR[a.m]; return `${t.mass} kg, ${t.irr ? 'irregular' : 'rigid'}` }
  const newest = first((a) => a.ph === 'in' && S.bags[a.m].position.z < 1.2)
  g.cap = g.finished ? (load ? 'Hold full: irregular bags on the left, rigid bags on the right' : 'Hold empty: all bags returned out of the door')
    : newest ? (newest.over ? `Separator scans ${info(newest)}: irregular side is full, so it sends the bag right`
        : g.sortOn ? `Separator scans ${info(newest)}: pushes it ${ATTR[newest.m].irr ? 'LEFT (irregular)' : 'RIGHT (rigid)'}` : `Bag ${info(newest)}: alternating sides (sorting off)`)
    : f('fetch') ? 'Platform has returned to the front to pick up the bag'
    : f('pick', 'retry') ? 'Grasp slipped: platform repositions and retries'
    : f('pick', 'grasp') ? 'Suction pad tests its grip on the exposed face'
    : f('pick', 'aim') ? 'Platform moves to the cleared space in front of the top bag'
    : f('pick', 'pull') ? 'Grip confirmed: bag is pulled onto the platform and carried back to the belt'
    : f('place') ? 'Platform carries the bag along the hold and the pusher slides it into its slot'
    : f('in') ? 'Bag rides the single lane to the separator'
    : f('belt') ? (load ? 'Bag rides the fixed belt to the pick-up point' : 'Bags ride back; the second one waits 2 s so they never meet at the centre')
    : f('out') ? 'Bags leave through the door' : 'Waiting for the next bag'
}
// ===== END SIM =====

const Box = forwardRef(function Box({ size = [1, 1, 1], color, pos = [0, 0, 0] }, ref) {
  return (
    <mesh ref={ref} position={pos}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  )
})

const tag = { font: '600 12px system-ui', color: '#e6edf2', background: 'rgba(16,21,26,.8)', padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' }

// ---------- static hold and single lane ----------
function Hold({ sortOn }) {
  const { objs, shell } = useMemo(() => {
    const ell = (x, n = 40) => {
      const p = []
      for (let i = 0; i <= n; i++) {
        const a = (Math.PI * i) / n
        p.push(new THREE.Vector3(x, H * Math.sin(a), W * Math.cos(a)))
      }
      return p
    }
    const rib = new THREE.LineBasicMaterial({ color: '#6f8fa3' })
    const orange = new THREE.LineBasicMaterial({ color: '#ff6a1a' })
    const g = (pts) => new THREE.BufferGeometry().setFromPoints(pts)
    const objs = []
    for (let i = 0; i <= 14; i++) objs.push(new THREE.LineLoop(g(ell(-HL + (2 * HL * i) / 14)), rib))
    for (let j = 0; j <= 6; j++) {
      const a = (Math.PI * j) / 6, y = H * Math.sin(a), z = W * Math.cos(a)
      objs.push(new THREE.Line(g([new THREE.Vector3(-HL, y, z), new THREE.Vector3(HL, y, z)]), rib))
    }
    // door: only ONE lane has to fit through it
    objs.push(new THREE.LineLoop(g([[-0.5, 0.02, 1.3], [0.5, 0.02, 1.3], [0.5, 0.7, 1.3], [-0.5, 0.7, 1.3]].map((p) => new THREE.Vector3(...p))), orange))
    const pos = [], idx = [], n = 24, m = 14
    for (let i = 0; i <= m; i++)
      for (let j = 0; j <= n; j++) {
        const a = (Math.PI * j) / n
        pos.push(-HL + (2 * HL * i) / m, H * Math.sin(a), W * Math.cos(a))
      }
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j, b = a + n + 1
        idx.push(a, b, a + 1, b, b + 1, a + 1)
      }
    const shell = new THREE.BufferGeometry()
    shell.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    shell.setIndex(idx)
    return { objs, shell }
  }, [])

  return (
    <group>
      {objs.map((o, i) => <primitive key={i} object={o} />)}
      <mesh geometry={shell}>
        <meshBasicMaterial color="#6f8fa3" transparent opacity={0.09} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Box size={[2 * HL, 0.04, 3]} color="#1d262e" pos={[0, -0.02, 0]} />
      <Box size={[3.2, 0.04, 5]} color="#1d262e" pos={[0, -0.02, 4]} />
      {/* the single infeed lane */}
      <Box size={[0.62, 0.12, LANE_Z0 - 0.3]} color="#56626d" pos={[0, 0.08, (LANE_Z0 + 0.3) / 2]} />
      <Box size={[0.56, 0.02, LANE_Z0 - 0.3]} color="#20262c" pos={[0, 0.15, (LANE_Z0 + 0.3) / 2]} />
      <Html position={[-2.4, 0.95, 0]} center style={{ pointerEvents: 'none' }}>
        <div style={{ ...tag, color: '#f2b134' }}>LEFT: irregular{sortOn ? '' : ' (sorting off)'}</div>
      </Html>
      <Html position={[2.4, 0.95, 0]} center style={{ pointerEvents: 'none' }}>
        <div style={tag}>RIGHT: rigid{sortOn ? '' : ' (sorting off)'}</div>
      </Html>
    </group>
  )
}

// ---------- one fixed belt + guide rail + shuttling platform ----------
function Arm({ r }) {
  const steel = ['#56626d', '#616d78', '#6c7883', '#77838e']
  const o = '#ff6a1a'
  return (
    <group>
      {steel.map((c, i) => <Box key={i} color={c} ref={(el) => (r.segs[i] = el)} />)}
      <Box color="#20262c" ref={(el) => (r.belt = el)} />
      {Array.from({ length: 14 }, (_, i) => <Box key={i} size={[0.03, 0.006, 0.5]} color="#8b98a3" ref={(el) => (r.ticks[i] = el)} />)}
      <Box size={[1, 0.03, 0.03]} color="#9aa5ae" ref={(el) => (r.trk = el)} />
      <Box size={[0.05, 0.05, 2.7]} color={o} ref={(el) => (r.rail = el)} />
      <Box size={[0.12, 0.1, 0.2]} color={o} ref={(el) => (r.car = el)} />
      <Box size={[0.06, 1, 0.06]} color={o} ref={(el) => (r.mast = el)} />
      <Box size={[1, 0.03, 0.5]} color={o} ref={(el) => (r.tray = el)} />
      <mesh ref={(el) => (r.pad = el)} visible={false}>
        <boxGeometry args={[0.05, 0.2, 0.32]} />
        <meshStandardMaterial ref={(m) => (r.padM = m)} color="#ffc400" />
      </mesh>
    </group>
  )
}

// ---------- nicer irregular (soft) bags: a duffel and a soft-sided case, both inside the 0.46 x 0.32 x 0.56 slot envelope ----------
const dark = <meshStandardMaterial color="#1b1d21" roughness={0.7} />
function SoftBag({ color, kind, geo }) {
  const fabric = <meshStandardMaterial color={color} roughness={0.95} />
  if (kind === 0) { // duffel: rounded body, two straps around it, a top handle and a zip line
    return (
      <group>
        <mesh geometry={geo} scale={[1.35, 0.95, 1]}>{fabric}</mesh>
        {[-0.1, 0.1].map((z) => (
          <mesh key={z} position={[0, 0, z]} scale={[1.35, 0.95, 1]}>
            <torusGeometry args={[0.164, 0.011, 8, 28]} />{dark}
          </mesh>
        ))}
        <mesh position={[0, 0.146, 0]} rotation={[0, Math.PI / 2, 0]} scale={[1, 0.45, 1]}>
          <torusGeometry args={[0.1, 0.014, 8, 20, Math.PI]} />{dark}
        </mesh>
        <mesh position={[0, 0.15, 0]}><boxGeometry args={[0.014, 0.008, 0.46]} />{dark}</mesh>
      </group>
    )
  }
  return ( // soft-sided case: rounded body, two wrap straps, a carry handle
    <group>
      <RoundedBox args={[0.44, 0.3, 0.52]} radius={0.08} smoothness={4}>{fabric}</RoundedBox>
      {[-0.1, 0.1].map((x) => (
        <mesh key={x} position={[x, 0, 0]}><boxGeometry args={[0.03, 0.304, 0.524]} />{dark}</mesh>
      ))}
      <mesh position={[0, 0.152, 0]}><boxGeometry args={[0.16, 0.02, 0.035]} />{dark}</mesh>
    </group>
  )
}

// ---------- component ----------
export default function CargoLoader({ mode = 'load', sortOn = true, playing = true, speed = 8, resetKey = 0, onStatus }) {
  const sim = useRef(null)
  if (!sim.current) sim.current = { bags: [], R: [{ segs: [], ticks: [] }, { segs: [], ticks: [] }], P: [mkArm(0), mkArm(1)], G: mkG(mode, sortOn) }
  const boxGeo = useMemo(() => new THREE.BoxGeometry(0.46, 0.32, 0.56), [])
  const softGeo = useMemo(() => { const g = new THREE.CapsuleGeometry(0.16, 0.24, 6, 12); g.rotateX(Math.PI / 2); return g }, [])
  const divRef = useRef()

  useEffect(() => {
    const S = sim.current
    S.G = mkG(mode, sortOn)
    S.P = [mkArm(0), mkArm(1)]
    S.bags.forEach((b) => { b.visible = false; b.rotation.set(0, 0, 0) })
    if (mode === 'unload') { // start from a full, already-sorted hold
      dryFill(sortOn).forEach((occ, s) => {
        const p = S.P[s]
        p.occ = occ
        p.order = UNLOAD_ORDER.filter((i) => occ[i] >= 0)
        occ.forEach((m, i) => {
          if (m < 0) return
          const b = S.bags[m], sl = SLS[i]
          b.visible = true
          b.position.set(p.sg * sl.d, sl.y, sl.z)
        })
      })
    }
  }, [mode, sortOn, resetKey])

  function draw(dt) {
    const S = sim.current, g = S.G
    // divider flap swings toward the side of the bag that is about to reach it
    const near = S.P.flatMap((p) => p.act.map((a) => [p, a])).filter(([, a]) => a.ph === 'in').sort((x, y) => S.bags[x[1].m].position.z - S.bags[y[1].m].position.z)[0]
    const target = near ? near[0].sg * 0.75 : 0
    if (divRef.current) divRef.current.rotation.y += (target - divRef.current.rotation.y) * Math.min(1, dt * 6)

    for (const p of S.P) {
      const r = S.R[p.s], sg = p.sg, X = (d) => sg * d
      if (!r.rail) continue
      const m = p.act.find((a) => a.ph === 'place' || a.ph === 'pick' || a.ph === 'fetch')
      let bxd = p.hx
      if (m) {
        if (m.ph === 'pick' && m.sub !== 'pull') { p.hz = m.hz; p.hy = m.hy; bxd = SLS[m.slot].d }
        else { const bp = S.bags[m.m].position; p.hz = bp.z; p.hy = bp.y - 0.17; bxd = sg * bp.x }
      } else {
        const f = Math.min(1, dt * 6)
        p.hz += (0 - p.hz) * f; p.hy += (0.165 - p.hy) * f
      }
      const len = p.tip + 0.25
      r.segs.forEach((s, i) => {
        const x0 = (len * i) / 4, x1 = (len * (i + 1)) / 4 + (i < 3 ? 0.2 : 0)
        s.scale.set(x1 - x0, 0.12, 0.74 - 0.05 * i)
        s.position.set(X((x0 + x1) / 2), 0.08, 0)
      })
      r.belt.scale.set(len, 0.02, 0.6); r.belt.position.set(X(len / 2), 0.15, 0)
      r.trk.scale.x = 3.05; r.trk.position.set(X(2.175), 0.03, 0) // guide rail the platform runs on (fits the gap between the centre stacks)
      r.ticks.forEach((k, i) => {
        const d = i * 0.3
        k.visible = d < len
        k.position.set(X((((d + p.off) % len) + len) % len), 0.162, 0)
      })
      const rd = p.hx - 0.35 // the cross-rail, mast and platform travel together along the hold
      r.rail.position.set(X(rd), 0.06, 0)
      r.car.position.set(X(rd), 0.06, p.hz)
      r.mast.scale.y = Math.max(0.01, p.hy - 0.06)
      r.mast.position.set(X(rd), (p.hy + 0.06) / 2, p.hz)
      const tl = Math.max(0.6, bxd + 0.23 - rd)
      r.tray.scale.x = tl
      r.tray.position.set(X(rd + tl / 2), p.hy, p.hz)
      r.pad.visible = g.mode === 'unload' && !!m
      r.pad.position.set(X(rd + tl + 0.02), p.hy + 0.17, p.hz)
    }
  }

  useFrame((_, delta) => {
    const S = sim.current, g = S.G
    const dt = Math.min(0.05, delta)
    if (playing && !g.finished) step(S, dt * speed)
    draw(dt)
    const sec = Math.floor(g.t)
    const right = used(S.P[0]), left = used(S.P[1])
    const key = `${g.cap}|${g.done}|${sec}|${left}|${right}|${g.overflow}`
    if (key !== g.key) {
      g.key = key
      const rate = g.t > 8 ? (g.done / (g.t / 60)).toFixed(1) : '–'
      onStatus?.({ cap: g.cap, done: g.done, total: NT, sec, rate, left, right, overflow: g.overflow })
    }
  })

  const S = sim.current
  return (
    <group>
      <Hold sortOn={sortOn} />
      {/* the separator device (scanner + divider), behind the end of the lane so bags never pass through it */}
      <group ref={divRef} position={[0, 0.25, -0.42]}>
        <mesh>
          <boxGeometry args={[0.56, 0.12, 0.05]} />
          <meshStandardMaterial color="#ff6a1a" />
        </mesh>
        <mesh position={[0, 0.1, 0]}>
          <boxGeometry args={[0.14, 0.07, 0.08]} />
          <meshStandardMaterial color="#1e88e5" emissive="#0a4a8a" emissiveIntensity={0.6} />
        </mesh>
      </group>
      <Html position={[0, 0.65, -0.42]} center style={{ pointerEvents: 'none' }}><div style={tag}>Scanner + divider</div></Html>
      <Arm r={S.R[0]} />
      <Arm r={S.R[1]} />
      {ATTR.map((at, m) =>
        at.irr ? (
          <group key={m} ref={(el) => (S.bags[m] = el)} visible={false}>
            <SoftBag color={FABRIC[m % FABRIC.length]} kind={m % 2} geo={softGeo} />
          </group>
        ) : (
          <mesh key={m} ref={(el) => (S.bags[m] = el)} geometry={boxGeo} visible={false}>
            <meshStandardMaterial color={PAL[m % PAL.length]} roughness={0.7} />
            <Edges color="#0d1318" />
          </mesh>
        )
      )}
    </group>
  )
}