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
}
