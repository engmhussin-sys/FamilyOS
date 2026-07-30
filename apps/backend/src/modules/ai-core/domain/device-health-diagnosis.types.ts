export interface IDeviceHealthDiagnosis {
  deviceId: string;
  trustLevel: string | null;
  riskLevel: string;
  riskReasons: string[];
  /** Sprint 6 — Runtime Recovery signals folded into AI Core, per the
   * "Runtime components only generate structured signals; AI Core
   * consumes them" principle. Read from the same cached telemetry
   * `listFamilyDevices` already exposes — not a new signal source. */
  runtimeStatus: {
    accessibilityServiceEnabled: boolean | null;
    enforcementActive: boolean | null;
  };
  /** AI-generated plain-language summary. Degrades gracefully — see
   * AiDiagnosticsService's docstring — the trust/risk fields above are
   * always accurate even if this one says "unavailable." */
  summary: string;
  generatedAt: Date;
}
