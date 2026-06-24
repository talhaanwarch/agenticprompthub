import prisma from '../shared/db/client';
import { ApiKey } from '../shared/db/schema';

/**
 * Data access layer for the api_keys table.
 */
export class ApiKeysRepository {
  /**
   * Inserts a new API key row. The caller is responsible for generating the key value.
   *
   * @param params - userId, teamId, the raw key string, and optional name.
   * @returns The newly inserted row.
   */
  async create(params: {
    userId: string;
    teamId: string;
    key: string;
    name?: string;
  }): Promise<ApiKey> {
    return prisma.apiKey.create({
      data: {
        userId: params.userId,
        teamId: params.teamId,
        key: params.key,
        name: params.name ?? null,
      },
    });
  }

  /**
   * Lists all active (non-revoked) API keys for the given user+team pair.
   * Does NOT return the key value — callers must derive `lastFour` from the row.
   *
   * @param userId - The requesting user's UUID.
   * @param teamId - The current team's UUID.
   */
  async listActive(userId: string, teamId: string): Promise<ApiKey[]> {
    return prisma.apiKey.findMany({
      where: {
        userId,
        teamId,
        revokedAt: null,
      },
    });
  }

  /**
   * Finds a single active key by ID for the given user+team pair.
   * Returns undefined if the key doesn't exist, is already revoked, or belongs to a different user/team.
   *
   * @param id - The key's UUID.
   * @param userId - Ownership check.
   * @param teamId - Ownership check.
   */
  async findActiveById(
    id: string,
    userId: string,
    teamId: string,
  ): Promise<ApiKey | undefined> {
    const row = await prisma.apiKey.findFirst({
      where: {
        id,
        userId,
        teamId,
        revokedAt: null,
      },
    });
    return row ?? undefined;
  }

  /**
   * Soft-deletes a key by setting `revoked_at` to the current timestamp.
   * Assumes ownership has already been verified by the caller.
   *
   * @param id - The key's UUID.
   */
  async revoke(id: string): Promise<void> {
    await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }
}
