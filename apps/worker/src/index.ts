import { parseBounded, WorkerRequestSchema, WorkerResponseSchema } from '@stackmanage/core';

process.on('message', (input: unknown) => {
  let request;
  try { request = parseBounded(WorkerRequestSchema, input); }
  catch { return; } // Invalid/unsolicited traffic never executes an operation.
  const response = WorkerResponseSchema.parse({ apiVersion: 1, id: request.id, status: 'ready', pid: process.pid });
  if (process.connected) process.send?.(response, undefined, undefined, (error: Error | null) => { if (error) process.exitCode = 1; });
});
process.on('disconnect', () => process.exit(0));
