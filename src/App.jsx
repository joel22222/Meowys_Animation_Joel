import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Experience } from "./components/Experience";

const btn = (on) => ({
  font: "inherit", fontSize: 14, padding: "6px 11px", borderRadius: 6, cursor: "pointer",
  border: "1px solid #3a4651", color: on ? "#10151a" : "#e6edf2", background: on ? "#e6edf2" : "transparent",
});
const dot = (c) => ({ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: c, marginRight: 6 });

export default function App() {
  const [mode, setMode] = useState("load");
  const [sortOn, setSortOn] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(8);
  const [resetKey, setResetKey] = useState(0);
  const [st, setSt] = useState({ cap: "Ready", done: 0, total: 120, sec: 0, rate: "–", left: 0, right: 0, overflow: 0 });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#10151a", color: "#e6edf2", fontFamily: "system-ui, sans-serif" }}>
      <Canvas camera={{ position: [5, 6, 10.5], fov: 40 }}>
        <Experience mode={mode} sortOn={sortOn} playing={playing} speed={speed} resetKey={resetKey} onStatus={setSt} />
      </Canvas>

      {/* legend + rule */}
      <div style={{ position: "absolute", top: 12, left: 14, fontSize: 13, lineHeight: 1.6, maxWidth: 320 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Single lane, scanner + divider</div>
        <div><span style={dot("#7a4e3a")} />Irregular (soft duffels and soft cases) → LEFT half-hold</div>
        <div><span style={dot("#4a4f57")} />Rigid → RIGHT half-hold</div>
        <div style={{ opacity: 0.7 }}>If a side is full, the bag goes to the side that has space</div>
      </div>

      <div style={{ position: "absolute", top: 12, right: 14, textAlign: "right", fontWeight: 600 }}>
        {st.done} / {st.total} bags
        <div style={{ fontWeight: 400, fontSize: 13, opacity: 0.7 }}>
          {Math.floor(st.sec / 60)}:{String(st.sec % 60).padStart(2, "0")} sim · {st.rate} bags/min
        </div>
        <div style={{ fontWeight: 400, fontSize: 13, color: "#f2b134" }}>
          Left {st.left}/60 · Right {st.right}/60 · Overflow to right: {st.overflow}
        </div>
      </div>

      <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 14, width: "min(720px, calc(100% - 20px))",
        background: "rgba(23,30,37,.88)", border: "1px solid #2f3b46", borderRadius: 10, padding: "10px 12px" }}>
        <p style={{ margin: "0 0 8px", minHeight: 22 }}>{st.cap}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
          <span style={{ display: "flex", gap: 4 }}>
            <button style={btn(mode === "load")} onClick={() => setMode("load")}>Loading</button>
            <button style={btn(mode === "unload")} onClick={() => setMode("unload")}>Unloading</button>
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button style={btn(sortOn)} onClick={() => setSortOn(true)}>Sorting on</button>
            <button style={btn(!sortOn)} onClick={() => setSortOn(false)}>Sorting off</button>
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button style={btn(false)} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
            <button style={btn(false)} onClick={() => setResetKey((k) => k + 1)}>Restart</button>
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            {[1, 4, 8].map((s) => (
              <button key={s} style={btn(speed === s)} onClick={() => setSpeed(s)}>{s}×</button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}