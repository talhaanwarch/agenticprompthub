import crypto from 'crypto';
import { ApiKeysRepository } from './api-keys.repository';
import { CreateApiKeyDto, ApiKeyCreatedDto, ApiKeyListItemDto } from './api-keys.types';
import { NotFoundError } from '../shared/errors';

/**
 * Business logic for API key management.
 * Key generation, listing (with key masking), and revocation.
 */
export class ApiKeysService {
  constructor(private readonly repo: ApiKeysRepository) {}

  /**
   * Generates a cryptographically random 64-character hex key, persists it,
   * and returns it in full — the only time the full value is ever returned.
   *
   * @param userId - The authenticated user's ID.
   * @param teamId - The active team's ID.
   * @param dto - Optional `name` for the key.
   */
  async create(
    userId: string,
    teamId: string,
    dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedDto> {
    const key = crypto.randomBytes(32).toString('hex'); // 64 hex chars
    const row = await this.repo.create({ userId, teamId, key, name: dto.name });
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      createdAt: row.createdAt,
    };
  }

  /**
   * Lists all active keys for the user+team, returning only the last 4 chars of each key.
   *
   * @param userId - The authenticated user's ID.
   * @param teamId - The active team's ID.
   */
  async list(userId: string, teamId: string): Promise<ApiKeyListItemDto[]> {
    const rows = await this.repo.listActive(userId, teamId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastFour: row.key.slice(-4),
      createdAt: row.createdAt,
    }));
  }

  /**
   * Revokes an API key, verifying it belongs to the caller.
   *
   * @param id - The key UUID to revoke.
   * @param userId - Ownership check — must match the key's user_id.
   * @param teamId - Ownership check — must match the key's team_id.
   * @throws {NotFoundError} If the key doesn't exist, is already revoked, or belongs to another user/team.
   */
  async revoke(id: string, userId: string, teamId: string): Promise<void> {
    const row = await this.repo.findActiveById(id, userId, teamId);
    if (!row) {
      throw new NotFoundError('API key not found.');
    }
    await this.repo.revoke(id);
  }
}
