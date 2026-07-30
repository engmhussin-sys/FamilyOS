export interface IConfigValidationIssue {
  key: string;
  severity: 'FATAL' | 'WARNING';
  message: string;
}

export interface IStartupValidationReport {
  isValid: boolean;
  checkedAt: string;
  issues: IConfigValidationIssue[];
}
