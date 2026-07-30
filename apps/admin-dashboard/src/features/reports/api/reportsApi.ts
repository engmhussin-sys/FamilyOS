import { httpClient } from '../../../shared/lib/httpClient';
import { tokenStorage } from '../../../shared/lib/tokenStorage';

export interface ChildReport {
  childId: string;
  childFirstName: string;
  generatedAt: string;
  screenTimePolicy: { dailyLimitMinutes: number | null; focusModeEnabled: boolean } | null;
  trustLevel: string | null;
  recentViolationCount: number;
  riskHistory: { overallLevel: string; overallRisk: number; assessedAt: string }[];
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export const reportsApi = {
  getReport(childId: string, deviceId: string): Promise<ChildReport> {
    return httpClient<ChildReport>(`/reports/${childId}?deviceId=${deviceId}`);
  },

  /**
   * CSV export needs an authenticated raw-text fetch, not `httpClient`
   * (which always parses JSON) — built as its own small function rather
   * than complicating `httpClient` with a response-type parameter for
   * this one caller.
   */
  async downloadCsv(childId: string, deviceId: string, filename: string): Promise<void> {
    const token = tokenStorage.getAccessToken();
    const response = await fetch(
      `${API_BASE_URL}/reports/${childId}?deviceId=${deviceId}&format=csv`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new Error('Failed to export report.');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  },
};
