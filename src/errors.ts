export interface FieldProblem {
  field: string;
  message: string;
  type?: string;
}

export interface SkryvoErrorInit {
  status?: number;
  code?: string;
  fields?: FieldProblem[];
  retryAfter?: number;
  requestId?: string;
  body?: unknown;
  cause?: unknown;
}

export class SkryvoError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly fields: FieldProblem[];
  /** Seconds to wait before trying again, when the server said. */
  readonly retryAfter?: number;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(message: string, init: SkryvoErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields ?? [];
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
    this.body = init.body;
  }
}

/** 401: the key is missing, revoked or mistyped. */
export class AuthenticationError extends SkryvoError {}
/** 403: the key's team role can't do this. */
export class PermissionDeniedError extends SkryvoError {}
export class NotFoundError extends SkryvoError {}
/** 422: Skryvo refused the request and `message` says why, in words to pass on to the person. */
export class RefusedError extends SkryvoError {}
export class RateLimitError extends SkryvoError {}
export class ServerError extends SkryvoError {}
/** The request never got an answer: network down, DNS, or the timeout passed. */
export class ConnectionError extends SkryvoError {}
export class WebhookVerificationError extends SkryvoError {}

const BY_STATUS: Record<number, typeof SkryvoError> = {
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  422: RefusedError,
  429: RateLimitError,
};

function words(body: unknown): { message?: string; code?: string; fields: FieldProblem[] } {
  if (!body || typeof body !== "object") return { fields: [] };
  const b = body as Record<string, unknown>;
  if (typeof b.detail === "string") return { message: b.detail, fields: [] };
  const fields = Array.isArray(b.details) ? (b.details as FieldProblem[]) : [];
  return {
    message: typeof b.message === "string" ? b.message : undefined,
    code: typeof b.error === "string" ? b.error : undefined,
    fields,
  };
}

export function errorFromResponse(status: number, body: unknown, headers: Headers): SkryvoError {
  const said = words(body);
  const retry = Number(headers.get("retry-after"));
  const detail = said.fields.length
    ? `Check the request: ${said.fields.map((f) => `${f.field}: ${f.message}`).join("; ")}.`
    : said.message;
  const Kind = BY_STATUS[status] ?? (status >= 500 ? ServerError : SkryvoError);
  return new Kind(detail || `Skryvo answered ${status}.`, {
    status,
    code: said.code,
    fields: said.fields,
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    requestId: headers.get("x-request-id") ?? undefined,
    body,
  });
}
