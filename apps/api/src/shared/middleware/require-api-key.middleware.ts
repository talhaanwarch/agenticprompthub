import { Request, Response, NextFunction } from 'express';
import prisma from '../db/client';
import { UnauthorizedError } from '../errors';

/**
 * Validates an `Authorization: Bearer <key>` header against the api_keys table.
 * Attaches `req.user` and `req.teamId` exactly as `requireAuth` does, so
 * downstream handlers are auth-method-agnostic.
 *
 * Revoked keys (`revoked_at IS NOT NULL`) are treated identically to unknown keys
 * to avoid leaking whether a key ever existed.
 *
 * @throws {UnauthorizedError} If the header is missing, malformed, or the key is unknown/revoked.
 */
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('API key required.');
    }

    const key = authHeader.slice(7).trim();

    const row = await prisma.apiKey.findFirst({
      where: {
        key,
        revokedAt: null,
      },
      select: {
        id: true,
        userId: true,
        teamId: true,
        user: {
          select: { email: true, displayName: true },
        },
      },
    });

    if (!row) {
      throw new UnauthorizedError('Invalid or revoked API key.');
    }

    req.user = {
      id: row.userId,
      email: row.user.email,
      displayName: row.user.displayName,
    };
    req.teamId = row.teamId;
    next();
  } catch (err) {
    next(err);
  }
}
