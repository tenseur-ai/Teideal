export class TeidealError extends Error {
  readonly statusCode?: number;
  readonly response?: unknown;

  constructor(message: string, options: { statusCode?: number; response?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "TeidealError";
    this.statusCode = options.statusCode;
    this.response = options.response;
  }
}

export class TeidealValidationError extends TeidealError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TeidealValidationError";
  }
}
