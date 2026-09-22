export class ServiceError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function asServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError(
    "INTERNAL_ERROR",
    "The service failed without returning repository content.",
    500,
  );
}
