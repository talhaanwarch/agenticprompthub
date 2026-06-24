import { Router, IRouter } from 'express';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { requireAuth } from '../shared/middleware';

/**
 * Express router for all /auth endpoints.
 * Instantiates the auth stack (repo → service → controller) here.
 * Mounting prefix (/api/v1) is applied in app.ts.
 */
const repo = new AuthRepository();
const service = new AuthService(repo);
const controller = new AuthController(service);

export const authRouter: IRouter = Router();

authRouter.post('/auth/signup', controller.signup);
authRouter.post('/auth/login', controller.login);
authRouter.post('/auth/logout', requireAuth, controller.logout);
authRouter.get('/auth/me', requireAuth, controller.me);
