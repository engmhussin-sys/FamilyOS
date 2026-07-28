export interface IDeviceHealthDiagnosis {
  deviceId: string;
  trustLevel: string | null;
  riskLevel: string;
  riskReasons: string[];
  /** AI-generated plain-language summary. Degrades gracefully — see
   * AiDiagnosticsService's docstring — the trust/risk fields above are
   * always accurate even if this one says "unavailable." */
  summary: string;
  generatedAt: Date;
}
