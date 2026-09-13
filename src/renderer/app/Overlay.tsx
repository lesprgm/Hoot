import React from "react";
import type { DisplayOption } from "../../shared/types";
import type { PlacedRegion } from "../overlay/layout";
import { SPRITE_STATE_LABEL, QUADRANT_IDS } from "./traits";

export function Sprite({ state, progress, hasNotch }: { state: string; progress: number | null; hasNotch: boolean }): React.ReactElement {
  const isWorking = state === "computer_use_running" || state === "thinking" || state === "speaking";
  return (
    <div className={`sprite sprite-state-${state}${hasNotch ? " sprite-has-notch" : " sprite-no-notch"}`}>
      <div className="sprite-ring">
        {progress !== null ? (
          <svg viewBox="0 0 100 100" className="ring-svg">
            <circle cx="50" cy="50" r="46" fill="none" stroke="#4a6fe0" strokeWidth="6" strokeDasharray={`${progress * 289} 289`} strokeLinecap="round" transform="rotate(-90 50 50)" />
          </svg>
        ) : null}
      </div>
      <div
        className={`sprite-art${isWorking ? " sprite-art-working" : " sprite-art-idle"}`}
        role="img"
        aria-label={`agent is ${SPRITE_STATE_LABEL[state] ?? state}`}
      >
      </div>
    </div>
  );
}

export function QuadrantCard({ quadrant, option, focused, progress, region, compact, locked }: { quadrant: string; option: DisplayOption | null; focused: boolean; progress: number | null; region: PlacedRegion; compact: boolean; locked: boolean }): React.ReactElement {
  return (
    <div className={`quadrant-target${compact ? " compact" : ""}`} data-gaze-region={quadrant} style={{ left: region.x, top: region.y, width: region.width, height: region.height }}>
    <div className={`quadrant quadrant-${quadrant.toLowerCase()}${focused ? " focused" : ""}${progress !== null ? " dwelling" : ""}${region.overlapped ? " overlaps-window" : ""}${locked ? " locked" : ""}`}>
      {progress !== null ? <div className="quadrant-progress" style={{ transform: `scaleX(${Math.max(0.05, progress)})` }} /> : null}
      <div className="quadrant-key">{quadrant}</div>
      <div className="quadrant-label">{option ? option.label : "…"}</div>
    </div>
    </div>
  );
}

export function QuadrantGrid({ options, focused, progress, regions, compact, locked }: { options: DisplayOption[]; focused: string | null; progress: Record<string, number>; regions: PlacedRegion[]; compact: boolean; locked: boolean }): React.ReactElement {
  return (
    <div className={`quadrant-grid${locked ? " locked" : ""}`} aria-busy={locked}>
      {QUADRANT_IDS.map((q) => {
        const option = options.find((o) => o.quadrant === q);
        const region = regions.find((r) => r.id === q);
        return region ? <QuadrantCard key={q} quadrant={q} option={option ?? null} focused={focused === q} progress={progress[q] ?? null} region={region} compact={compact} locked={locked} /> : null;
      })}
    </div>
  );
}
