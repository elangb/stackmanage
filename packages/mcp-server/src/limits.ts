export const SERVER_NAME = 'stackmanage-mcp';
export const SERVER_VERSION = '0.1.0';
export const PROTOCOL_READ_ONLY = true;

/** Hard ceilings for every text result. Callers may request less, never more. */
export const LIMITS = Object.freeze({
  maxLogBytes: 1_048_576,
  defaultLogBytes: 65_536,
  maxConfigBytes: 240_000,
  maxStateRecordBytes: 524_288,
  maxServiceRecords: 10,
  maxSites: 100,
  maxInstallations: 10,
  readTimeoutMs: 5_000
});
