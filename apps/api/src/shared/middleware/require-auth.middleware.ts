import { Request, Response, NextFunction } from 'express';
import prisma from '../db/client';
import { UnauthorizedError } from '../errors';

/**
 * Validates that the request has an active session with a known userId.
 * Attaches `req.user` (id, email, displayName) and `req.teamId` from the session.
 *
 * @throws {UnauthorizedError} If no session exists, or the session's userId has no matching user row.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.session?.userId) {
      throw new UnauthorizedError('Authentication required.');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, email: true, displayName: true },
    });

    if (!user) {
      // Session references a deleted user — destroy it and reject
      req.session.destroy(() => {});
      throw new UnauthorizedError('Session is no longer valid.');
    }

    req.user = user;
    req.teamId = req.session.teamId;
    next();
  } catch (err) {
    next(err);
  }
}
