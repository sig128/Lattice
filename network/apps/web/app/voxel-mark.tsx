"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Phase = "standing" | "walking" | "waving" | "idle";

export function VoxelMark() {
  const [phase, setPhase] = useState<Phase>("standing");

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return setPhase("idle");
    if (sessionStorage.getItem("lattice.voxel.arrived")) return setPhase("idle");
    setPhase("walking");
    const wave = window.setTimeout(() => setPhase("waving"), 2_350);
    const settle = window.setTimeout(() => {
      setPhase("idle");
      sessionStorage.setItem("lattice.voxel.arrived", "1");
    }, 4_150);
    return () => { window.clearTimeout(wave); window.clearTimeout(settle); };
  }, []);

  return (
    <Link className="voxel-home" href="/" aria-label="Lattice — home" data-phase={phase} onMouseEnter={() => phase === "idle" && setPhase("waving")} onMouseLeave={() => phase === "waving" && setPhase("idle")} onFocus={() => phase === "idle" && setPhase("waving")} onBlur={() => phase === "waving" && setPhase("idle")}>
      <svg className={`voxel-robot ${phase}`} viewBox="0 0 52 58" aria-hidden="true">
        <g className="robot-body">
          <g className="head">
            <polygon className="face-top light" points="13,8 29,1 43,8 27,15" />
            <polygon className="face-side dark" points="43,8 43,25 27,32 27,15" />
            <polygon className="face-front mid" points="13,8 27,15 27,32 13,25" />
            <polygon className="visor" points="13,14 27,20 27,27 13,21" />
            <polygon className="eye" points="16,16 20,18 20,22 16,20" />
            <polygon className="eye" points="23,19 26,20 26,24 23,23" />
          </g>
          <g className="torso">
            <polygon className="face-top light" points="18,32 29,27 38,32 27,37" />
            <path className="torso-grid" d="M18 32l9 5v13l-9-5zm9 5l11-5v13l-11 5zm-5-2.2v12.4M31 35.2v12.4M18 38l9 5 11-5" />
            <path className="torso-hole" d="M22 37l5 2.7v6L22 43zm5 2.7l6-2.7v6l-6 2.7" />
          </g>
          <g className="arm arm-left">
            <polygon className="mid" points="14,33 19,35 19,46 14,44" />
            <polygon className="dark" points="10,39 14,41 14,49 10,47" />
          </g>
          <g className="arm arm-right">
            <polygon className="dark" points="38,33 42,35 42,46 38,44" />
            <polygon className="mid" points="42,40 46,38 46,47 42,49" />
          </g>
          <g className="leg leg-left">
            <polygon className="mid" points="19,46 25,49 25,55 19,52" />
            <polygon className="dark" points="17,52 25,55 22,58 14,55" />
          </g>
          <g className="leg leg-right">
            <polygon className="dark" points="28,48 34,45 34,53 28,56" />
            <polygon className="mid" points="28,56 35,53 39,56 31,59" />
          </g>
        </g>
      </svg>
    </Link>
  );
}
