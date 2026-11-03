"use strict";
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class BudgetError extends HttpError {
  constructor(message) { super(429, message); }
}
module.exports = { HttpError, BudgetError };
