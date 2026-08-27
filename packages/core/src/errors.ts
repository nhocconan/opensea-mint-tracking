/**
 * Typed error categories (PRD §14). Every provider/system failure maps to one
 * of these; messages must be safe to display (no headers, tokens, or raw
 * provider bodies — those live in evidence, sanitized, server-side).
 */
export type ErrorCategory =
  | "AuthRequired"
  | "RateLimited"
  | "RetryableProvider"
  | "InvalidPayload"
  | "PermanentConfig"
  | "NotFound"
  | "Forbidden"
  | "Conflict";

export class AppError extends Error {
  readonly category: ErrorCategory;
  /** Operator-facing remediation hint; must not contain secrets. */
  readonly hint?: string | undefined;
  readonly retryable: boolean;
  /** Retry-After seconds when the provider supplied one. */
  readonly retryAfterSeconds?: number | undefined;
  readonly statusCode: number;

  constructor(
    category: ErrorCategory,
    message: string,
    options: {
      hint?: string;
      retryAfterSeconds?: number;
      statusCode?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.category = category;
    this.hint = options.hint;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryable =
      category === "RetryableProvider" ||
      (category === "RateLimited" && options.retryAfterSeconds !== undefined);
    this.statusCode = options.statusCode ?? defaultStatus(category);
  }
}

function defaultStatus(category: ErrorCategory): number {
  switch (category) {
    case "AuthRequired":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "Conflict":
      return 409;
    case "RateLimited":
      return 429;
    case "InvalidPayload":
    case "PermanentConfig":
      return 400;
    case "RetryableProvider":
      return 502;
  }
}

/** True when a thrown value is safe to convert into an HTTP problem response. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Coerce any thrown value into a displayable message without leaking internals:
 * unknown non-Error throwables become a generic category label.
 */
export function safeErrorMessage(value: unknown, fallback = "unexpected error"): string {
  if (isAppError(value)) {
    return value.message;
  }
  if (value instanceof Error) {
    // Error.message from third-party clients can embed URLs with query keys;
    // strip query strings defensively.
    return value.message.replace(/[?]\S+/g, "?…");
  }
  return fallback;
}
