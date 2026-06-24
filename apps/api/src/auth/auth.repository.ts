import prisma from '../shared/db/client';
import { User, Team } from '../shared/db/schema';

/** Shape returned by createUserWithTeam. */
export interface CreatedUserWithTeam {
  user: User;
  team: Team;
}

/**
 * Data access layer for the auth domain.
 * All queries that touch users, teams, team_members, or team_member_roles
 * from the auth context live here.
 */
export class AuthRepository {
  /**
   * Looks up a user by email. Returns undefined if not found.
   * Used by both signup (conflict check) and login (credential validation).
   *
   * @param email - Normalised (lowercase-trimmed) email address.
   */
  async findUserByEmail(email: string): Promise<User | undefined> {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    return user ?? undefined;
  }

  /**
   * Creates a user, their personal team, the team_members join row, and the
   * 'owner' role — all inside a single transaction.
   * The personal team name is derived as `"<email>'s team"`.
   *
   * @param params - Required fields for the new user.
   * @returns The newly inserted user and team rows.
   * @throws If any insert fails; the transaction rolls back automatically.
   */
  async createUserWithTeam(params: {
    email: string;
    passwordHash: string;
    displayName?: string;
  }): Promise<CreatedUserWithTeam> {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: params.email,
          passwordHash: params.passwordHash,
          displayName: params.displayName ?? null,
        },
      });

      const team = await tx.team.create({
        data: { name: `${params.email}'s team` },
      });

      const member = await tx.teamMember.create({
        data: { userId: user.id, teamId: team.id },
      });

      await tx.teamMemberRole.create({
        data: {
          teamMemberId: member.id,
          role: 'owner',
        },
      });

      return { user, team };
    });
  }

  /**
   * Returns the first team the user belongs to, ordered by join date ascending.
   * For a freshly signed-up user this is always their personal team.
   *
   * @param userId - The user's UUID.
   * @returns The team row, or undefined if the user has no team memberships.
   */
  async findTeamForUser(userId: string): Promise<Team | undefined> {
    const membership = await prisma.teamMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { team: true },
    });
    return membership?.team ?? undefined;
  }

  /**
   * Returns the list of role names the user holds in the given team.
   * Returns an empty array if the user is not a member or has no roles.
   *
   * @param userId - The user's UUID.
   * @param teamId - The team's UUID.
   */
  async findRolesForUserInTeam(
    userId: string,
    teamId: string,
  ): Promise<string[]> {
    const member = await prisma.teamMember.findFirst({
      where: { userId, teamId },
      include: { roles: true },
    });
    return member?.roles.map((r) => r.role) ?? [];
  }

  /**
   * Returns a team by ID. Used by GET /auth/me to fetch the team name.
   *
   * @param teamId - The team's UUID.
   */
  async findTeamById(teamId: string): Promise<Team | undefined> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });
    return team ?? undefined;
  }
}
