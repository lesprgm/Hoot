import type { PermissionStatus } from "../shared/types";

export async function checkPermissions(): Promise<PermissionStatus> {
  const status: PermissionStatus = { camera: "unknown", screenRecording: "unknown", accessibility: "unknown" };
  try {
    const { desktopCapturer, systemPreferences } = await import("electron");
    status.camera = normalizePermission(systemPreferences.getMediaAccessStatus("camera"));
    status.screenRecording = normalizePermission(systemPreferences.getMediaAccessStatus("screen"));
    status.accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
    if (sources && sources.length > 0) status.screenRecording = "granted";
  } catch {
    status.screenRecording = "denied";
  }
  return status;
}

function normalizePermission(value: string): PermissionStatus["camera"] {
  if (value === "granted" || value === "denied") return value;
  return "unknown";
}

export async function probeCamera(): Promise<boolean> {
  try {
    const { systemPreferences } = await import("electron");
    return systemPreferences.getMediaAccessStatus("camera") === "granted";
  } catch {
    return false;
  }
}
