import type { ApiErrorBody, ChainKey } from "@kirchhoff/sdk";

export type ErrorCode = ApiErrorBody["error"]["code"];

/** Thrown anywhere in a handler; the error handler turns it into an ApiErrorBody with `status`. */
export class ApiFailure extends Error {
  override readonly name = "ApiFailure";
  readonly status: number;
  readonly code: ErrorCode;
  readonly chain: ChainKey | undefined;

  constructor(status: number, code: ErrorCode, message: string, chain?: ChainKey) {
    super(message);
    this.status = status;
    this.code = code;
    this.chain = chain;
  }
}

export const notFound = (what: string): ApiFailure => new ApiFailure(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (message: string): ApiFailure => new ApiFailure(400, "BAD_REQUEST", message);

export function errorBody(code: ErrorCode, message: string, chain?: ChainKey): ApiErrorBody {
  return { error: { code, message, ...(chain ? { chain } : {}) } };
}
