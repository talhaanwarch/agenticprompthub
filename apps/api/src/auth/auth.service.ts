import bcrypt from 'bcrypt';
import { AuthRepository } from './auth.repository';
import { SignupDto, LoginDto, AuthResponseDto, MeResponseDto, UserDto } from './auth.types';
import {
  ConflictError,
  UnauthorizedError,
  NotFoundError,
} from '../shared/errors';

const BCRYPT_ROUNDS = 12;

/**
 * Business logic for the auth domain.
 * Owns signup, login, and me — everything that deals with credentials and identity.
 * Throws typed errors; never returns HTTP status codes.
 */
export class AuthService {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Registers a new user and auto-creates their personal team.
   *
   * @throws {ConflictError} If the email is already registered.
   * @returns DTOs for the 201 response body, plus userId/teamId for the controller to write to session.
   */
  async signup(dto: SignupDto): Promise<AuthResponseDto & { userId: string; teamId: string }> {
    const existing = await this.repo.findUserByEmail(dto.email);
    if (existing) {
      throw new ConflictError('This email address is already registered.');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const { user, team } = await this.repo.createUserWithTeam({
      email: dto.email,
      passwordHash,
      displayName: dto.displayName,
    });

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      team: { id: team.id, name: team.name },
      userId: user.id,
      teamId: team.id,
    };
  }

  /**
   * Validates email + password credentials.
   * Uses the same generic error for "no user" and "wrong password" to prevent user enumeration.
   *
   * @throws {UnauthorizedError} If the email is unknown or the password is incorrect.
   * @throws {NotFoundError} If the user has no team membership (indicates data inconsistency).
   */
  async login(dto: LoginDto): Promise<AuthResponseDto & { userId: string; teamId: string }> {
    const user = await this.repo.findUserByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const team = await this.repo.findTeamForUser(user.id);
    if (!team) {
      throw new NotFoundError('No team found for this account.');
    }

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      team: { id: team.id, name: team.name },
      userId: user.id,
      teamId: team.id,
    };
  }

  /**
   * Builds the GET /auth/me response.
   * `user` comes pre-validated from `req.user` (attached by requireAuth middleware),
   * so no extra user DB lookup is needed here.
   *
   * @param user - The validated user object from req.user.
   * @param teamId - From req.teamId (set by requireAuth from session).
   * @throws {NotFoundError} If the team row is missing (edge case: team was deleted).
   */
  async getMe(user: UserDto, teamId: string): Promise<MeResponseDto> {
    const [team, roles] = await Promise.all([
      this.repo.findTeamById(teamId),
      this.repo.findRolesForUserInTeam(user.id, teamId),
    ]);

    if (!team) {
      throw new NotFoundError('Team not found.');
    }

    return {
      user,
      team: { id: team.id, name: team.name },
      roles,
    };
  }
}
