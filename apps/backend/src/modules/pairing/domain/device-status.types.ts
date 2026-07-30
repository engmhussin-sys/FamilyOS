/** Mirrors the Pairing Capability Snapshot (Decision-055) PLUS the fuller
 * permission/vendor fields Sprint 4's Device Capability Engine reports —
 * the "Full Capability Engine" that pairing-backend-domain-architecture.md
 * §2 always said would arrive later, now arriving. */
export interface IDeviceCapabilityReport {
  manufacturer: string;
  model: string;
  sdkInt: number;
  usageAccessGranted: boolean;
  accessibilityEnabled: boolean;
  overlayGranted: boolean;
  batteryOptimizationExempted: boolean;
  notificationsGranted: boolean;
  /** SHA-256 of the report's own contents, computed client-side —
   * Decision-019's caching contract: the server only needs to react
   * when this changes, not on every submission. */
  profileHash: string;
}

export interface IPolicySyncResponse {
  childId: string;
  policyVersion: string;
  dailyLimitMinutes: number | null;
  bedtimeStart: string | null;
  bedtimeEnd: string | null;
  focusModeEnabled: boolean;
  blockedPackages: string[];
}

export interface IHeartbeatTelemetryInput {
  batteryPercent?: number;
  availableStorageMb?: number;
  isConnected?: boolean;
  appVersion?: string;
  /** Sprint 5 — Runtime Enforcement Engine's status, self-reported by
   * the device on every heartbeat. Same self-report honesty caveat as
   * the pairing verify() risk signals: not independently verified
   * server-side. */
  accessibilityServiceEnabled?: boolean;
  enforcementActive?: boolean;
}

export interface IDeviceSummary {
  id: string;
  childId: string;
  childFirstName: string;
  platform: string;
  status: string;
  trustLevel: string | null;
  riskLevel: string;
  lastSeenAt: Date | null;
  capabilities: IDeviceCapabilityReport | null;
  /** Sprint 5 — read from Device.lastTelemetry's runtime fields,
   * same cached-current-state pattern as everything else in this file. */
  runtimeStatus: {
    accessibilityServiceEnabled: boolean | null;
    enforcementActive: boolean | null;
  };
}
