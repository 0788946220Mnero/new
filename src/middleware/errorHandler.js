import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

/** Single place that turns errors into clean JSON. No stack traces or DB messages leave the server. */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let status = 500;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    let details;

    if (err instanceof AppError) {
      status = err.statusCode;
      message = err.message;
      code = err.code ?? code;
      details = err.details;
    } else if (err instanceof ZodError) {
      status = 400;
      message = 'Validation failed';
      code = 'VALIDATION_ERROR';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (err instanceof mongoose.Error.ValidationError) {
      status = 400;
      message = 'Validation failed';
      code = 'VALIDATION_ERROR';
      details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.kind }));
    } else if (err instanceof mongoose.Error.CastError) {
      status = 400;
      message = 'Invalid identifier';
      code = 'INVALID_ID';
    } else if (err?.code === 11000) {
      status = 409;
      message = 'Already exists';
      code = 'DUPLICATE';
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      message = 'Invalid JSON body';
      code = 'INVALID_JSON';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      message = 'Request body too large';
      code = 'PAYLOAD_TOO_LARGE';
    }

    const log = req.log ?? logger;
    if (status >= 500) log.error({ err, code }, 'Request failed');
    else log.warn({ code, status }, message);

    if (res.headersSent) return;
    res.status(status).json({
      success: false,
      message,
      code,
      ...(details ? { details } : {}),
      ...(req.id ? { requestId: req.id } : {}),
    });
  };
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ success: false, message: 'Route not found', code: 'ROUTE_NOT_FOUND' });
}
