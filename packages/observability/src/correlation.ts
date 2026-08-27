/**
 * Correlation IDs (PRD §10/§13): generated at ingress, propagated through
 * logs, scan runs, and audit entries via AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CorrelationContext {
  readonly correlationId: string;
  readonly jobId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function withCorrelation<T>(context: CorrelationContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? newCorrelationId();
}
