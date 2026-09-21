import React from "react";
import type { ContextSnapshot, GazeSample } from "../../shared/types";
import { confirmRegions, type OverlaySurface } from "../overlay/layout";
import { api, type ViewState } from "../bridge";

const surfaceOf = (): OverlaySurface => ({ width: window.innerWidth, height: window.innerHeight });

export function ConsequentialCard({ summary }: { summary: string }): React.ReactElement {
  return (
    <>
      <div className="center-card consequential">
        <div className="center-title">Consequential action — final confirmation</div>
        <div className="center-intent">{summary}</div>
      </div>
      <DecisionChoices labels={["APPROVE", "CHANGE", "READ / EXPLAIN", "CANCEL"]} />
    </>
  );
}

export function SteeringCard({ status, options }: { status: string; options: Array<{ label: string }> }): React.ReactElement {
  return (
    <>
      <div className="center-card steering">
        <div className="center-title">Steer the task</div>
        <div className="center-intent">{status}</div>
      </div>
      <DecisionChoices labels={options.map((option) => option.label)} />
    </>
  );
}

export function RecoveryCard({ summary, options }: { summary: string; options: Array<{ label: string }> }): React.ReactElement {
  return (
    <>
      <div className="center-card recovery">
        <div className="center-title">Recovery</div>
        <div className="center-intent">{summary}</div>
      </div>
      <DecisionChoices labels={options.map((option) => option.label)} />
    </>
  );
}

export function ContextBadge({ snapshot, focused }: { snapshot: ContextSnapshot; focused: string | null }): React.ReactElement {
  const blocked = snapshot.access === "blocked";
  const paused = snapshot.access === "paused";
  const sessionScope = snapshot.contextScope === "session";
  const appName = snapshot.window?.appName ?? "No active app";
  const screenshot = snapshot.sources.find((source) => source.kind === "screenshot");
  const detail = blocked
    ? "Context is blocked until you allow this session."
    : paused
      ? "Paused; no new context is captured or sent."
      : screenshot?.state === "available"
        ? sessionScope ? "Session-scoped window snapshot available to the decoder." : "App-scoped window snapshot available to the decoder."
        : sessionScope ? "Session-scoped app metadata available to the decoder." : "App-scoped metadata available to the decoder.";
  const toggleId = "context_toggle";
  const toggleLabel = paused ? "RESUME" : "PAUSE";
  return (
    <div className={`context-badge context-${snapshot.access}`} role="status" aria-live="polite">
      <div className="context-badge-copy">
        <span className="context-badge-title">CONTEXT {blocked ? "BLOCKED" : paused ? "PAUSED" : "ON"}</span>
        <span className="context-badge-app">{appName}</span>
        <span className="context-badge-detail">{detail}</span>
      </div>
      {!sessionScope ? (
        <button
          data-context-control="context_approve_session"
          className={`context-badge-button${focused === "context_approve_session" ? " active" : ""}`}
          onClick={() => void api.approveContextSession()}
        >
          ALLOW SESSION
        </button>
      ) : null}
      {!blocked ? (
        <button
          data-context-control={toggleId}
          className={`context-badge-button${focused === toggleId ? " active" : ""}`}
          onClick={() => void api.toggleContext()}
        >
          {toggleLabel}
        </button>
      ) : null}
    </div>
  );
}

function DecisionChoices({ labels }: { labels: string[] }): React.ReactElement {
  return <>{confirmRegions(surfaceOf()).map((region, index) => (
    <div className="quadrant-target" key={region.id} data-gaze-region={region.id} style={{ left: region.x, top: region.y, width: region.width, height: region.height }}>
      <div className="choice"><b>{region.id}</b><span>{labels[index] ?? "…"}</span></div>
    </div>
  ))}</>;
}

export function SetupWizard({ onCalibrate, onRecalibrate, onQuit, calibrating, canRestore, ready, allowUnverified }: { onCalibrate: () => void; onRecalibrate: () => void; onQuit: () => void; calibrating: boolean; canRestore: boolean; ready: boolean; allowUnverified: boolean }): React.ReactElement {
  return (
    <div className="wizard">
      <h2>{calibrating ? "Preparing your camera…" : canRestore ? "Your eye calibration is saved" : "Calibrate your eyes"}</h2>
      <p>{canRestore ? "Start with your saved calibration. Choose Recalibrate if your camera or seating position has changed." : allowUnverified ? "Demo mode: look at five dots to fit the real camera stream. Accuracy checks will be skipped." : "Look at each of five dots, then click while keeping your gaze on it. Four separate accuracy checks follow."}</p>
      <p>{window.innerWidth} × {window.innerHeight} logical pixels · {window.devicePixelRatio}× display scale</p>
      <p>{allowUnverified ? "Accuracy is not guaranteed in this explicit demo mode." : "Gaze controls stay disabled until calibration passes."} Keep your usual seating position. Press Esc to cancel the dots.</p>
      <div className="wizard-actions">
        <button className="wizard-btn primary" disabled={calibrating || !ready} onClick={onCalibrate}>{!ready ? "Loading settings…" : calibrating ? "Starting camera…" : canRestore ? "Start eye control" : "Start eye calibration"}</button>
        {canRestore ? <button className="wizard-btn" disabled={calibrating} onClick={onRecalibrate}>Recalibrate</button> : null}
        <button className="wizard-btn quiet" onClick={onQuit}>Quit View</button>
      </div>
    </div>
  );
}

export function DebugHUD({ view, gaze, progress }: { view: ViewState; gaze: GazeSample | null; progress: Record<string, number> }): React.ReactElement {
  return (
    <div className="debug-hud">
      <div className="debug-title">Debug HUD</div>
      <div>state: {view.interactionState}</div>
      <div>mode: {view.appMode}</div>
      <div>sprite: {view.sprite}</div>
      <div>gaze: {gaze ? `${(gaze.xNorm * 100).toFixed(0)}%,${(gaze.yNorm * 100).toFixed(0)}%` : "—"}</div>
      <div>focused: {Object.keys(progress).join(",") || "—"}</div>
      <div>decoder: {view.config?.settings.decoderModel}</div>
    </div>
  );
}
