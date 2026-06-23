import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { SignupSchema, LoginSchema } from './auth.types';
import { ValidationError } from '../shared/errors';

/**
 * HTTP handlers for the auth domain.
 * Each handler does exactly three things: validate → call service → respond.
 * No business logic lives here.
 */
export class AuthController {
  constructor(private readonly service: AuthService) {}

  /**
   * POST /api/v1/auth/signup
   * Creates a new user account and their personal team. Starts a session.
   */
  signup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = SignupSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0].message);
      }

      const result = await this.service.signup(parsed.data);

      req.session.userId = result.userId;
      req.session.teamId = result.teamId;

      res.status(201).json({ user: result.user, team: result.team });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/auth/login
   * Validates credentials and starts a session.
   */
  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0].message);
      }

      const result = await this.service.login(parsed.data);

      req.session.userId = result.userId;
      req.session.teamId = result.teamId;

      res.status(200).json({ user: result.user, team: result.team });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/auth/logout
   * Destroys the current session. Protected by requireAuth middleware.
   */
  logout = (req: Request, res: Response, next: NextFunction): void => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.status(204).send();
    });
  };

  /**
   * GET /api/v1/auth/me
   * Returns the authenticated user, their active team, and their roles.
   * Protected by requireAuth middleware — req.user and req.teamId are guaranteed non-null.
   */
  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // requireAuth guarantees req.user and req.teamId are set
      const result = await this.service.getMe(req.user!, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
