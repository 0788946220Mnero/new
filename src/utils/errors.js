export class AppError extends Error {
  constructor(statusCode, message, { code, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message = 'Bad request', opts) => new AppError(400, message, { code: 'BAD_REQUEST', ...opts }),
  unauthorized: (message = 'Unauthorized', opts) => new AppError(401, message, { code: 'UNAUTHORIZED', ...opts }),
  forbidden: (message = 'Forbidden', opts) => new AppError(403, message, { code: 'FORBIDDEN', ...opts }),
  notFound: (message = 'Not found', opts) => new AppError(404, message, { code: 'NOT_FOUND', ...opts }),
  conflict: (message = 'Already exists', opts) => new AppError(409, message, { code: 'CONFLICT', ...opts }),
  internal: (message = 'Internal server error', opts) => new AppError(500, message, { code: 'INTERNAL_ERROR', ...opts }),
};
