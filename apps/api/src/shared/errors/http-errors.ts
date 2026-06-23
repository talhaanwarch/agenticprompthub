import { AppError } from './app-error';

/**
 * 400 — Request body or query params failed Zod validation.
 * Pass the Zod issue message as `message`.
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

/**
 * 401 — Caller is not authenticated, or credentials are invalid.
 * Use the same generic message whether it's "no session" or "wrong password"
 * to avoid leaking which factor failed.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * 403 — Caller is authenticated but lacks the required role for this action.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions.') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * 404 — Resource not found, or found but not accessible to the caller.
 * Use the same message for both cases to avoid leaking existence of private resources.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.') {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * 409 — Duplicate resource (e.g. email already registered).
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}
