import { OrbitControls } from "@react-three/drei";
import CargoLoader from "./Cargoloader";

export const Experience = ({ mode, sortOn, playing, speed, resetKey, onStatus }) => {
  return (
    <>
      <color attach="background" args={["#10151a"]} />
      <hemisphereLight args={["#ffffff", "#667788", 2.2]} />
      <directionalLight position={[-3, 6, 4]} intensity={2} />
      <OrbitControls makeDefault target={[0, 0.5, 1.5]} />
      <CargoLoader
        mode={mode}
        sortOn={sortOn}
        playing={playing}
        speed={speed}
        resetKey={resetKey}
        onStatus={onStatus}
      />
    </>
  );
};