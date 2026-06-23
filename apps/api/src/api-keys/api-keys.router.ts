import { Router, IRouter, Request, Response, NextFunction } from 'express';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { requireAuth, requireApiKey } from '../shared/middleware';

/**
 * Tries session auth first, then Bearer API key auth.
 * This lets both browser sessions and SDK clients use the same endpoints.
 */
async function requireAnyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.session?.userId) {
    return requireAuth(req, res, next);
  }
  return requireApiKey(req, res, next);
}

const repo = new ApiKeysRepository();
const service = new ApiKeysService(repo);
const controller = new ApiKeysController(service);

export const apiKeysRouter: IRouter = Router();

apiKeysRouter.post('/api-keys', requireAnyAuth, controller.create);
apiKeysRouter.get('/api-keys', requireAnyAuth, controller.list);
apiKeysRouter.delete('/api-keys/:id', requireAnyAuth, controller.revoke);
