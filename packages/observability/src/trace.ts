/**
 * OpenTelemetry span wrapper (PRD §13). Depends only on @opentelemetry/api so
 * the app runs with zero overhead when no SDK is configured; when the
 * deployment sets OTEL_EXPORTER_OTLP_ENDPOINT, any compliant SDK registered
 * later receives the spans automatically.
 */
import { context, type Span, type SpanOptions, trace } from "@opentelemetry/api";

const TRACER_NAME = "hoodmint-radar";

export function tracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(TRACER_NAME);
}

/** Run fn inside a span; records errors and always ends the span. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  return tracer().startActiveSpan(name, options, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Attach the active correlation id to span attributes for log correlation. */
export function linkCorrelation(correlationId: string): void {
  const span = trace.getSpan(context.active());
  span?.setAttribute("hoodmint.correlation_id", correlationId);
}
