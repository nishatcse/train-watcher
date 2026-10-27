class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
const conflict = (message) => new HttpError(409, "conflict", message);
const unauthorized = (message = "Unauthorized") => new HttpError(401, "unauthorized", message);
const badRequest = (message, details) => new HttpError(422, "validation_error", message, details);

module.exports = { HttpError, notFound, conflict, unauthorized, badRequest };
