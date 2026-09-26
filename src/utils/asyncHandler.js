/** Forwards rejected promises to Express's error handler (Express 4). */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
