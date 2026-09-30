import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';
import type {
  AuthenticatedUser,
  CreateHouseholdInput,
  Household,
  HouseholdInvite,
  HouseholdMember,
  HouseholdRepository,
  InvitePreview,
  UpdateHouseholdInput,
} from './types.js';

interface HouseholdRow {
  id: string;
  name: string;
  default_currency: 'USD' | 'THB';
  timezone: string;
  role: 'owner' | 'admin' | 'member';
  currency_editable: boolean;
  created_at: Date;
}

interface MemberRow {
  id: string;
  display_name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'member';
  joined_at: Date;
}

interface InviteRow {
  id: string;
  created_at: Date;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
}

const householdColumns =
  'h.id, h.name, h.default_currency, h.timezone, m.role, (h.currency_locked_at IS NULL) AS currency_editable, h.created_at';

function toHousehold(row: HouseholdRow): Household {
  return {
    id: row.id,
    name: row.name,
    defaultCurrency: row.default_currency,
    timezone: row.timezone,
    role: row.role,
    currencyEditable: row.currency_editable,
    createdAt: row.created_at.toISOString(),
  };
}

function toMember(row: MemberRow): HouseholdMember {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
  };
}

function toInvite(row: InviteRow): HouseholdInvite {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    redeemedAt: row.redeemed_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

async function ensureProfile(
  client: Pool | PoolClient,
  user: AuthenticatedUser,
) {
  const result = await client.query<{
    id: string;
    auth_user_id: string;
    display_name: string;
    email: string | null;
  }>(
    `INSERT INTO housemate.users (auth_user_id, display_name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (auth_user_id) DO UPDATE SET
       email = EXCLUDED.email, updated_at = now()
     RETURNING id, auth_user_id, display_name, email`,
    [user.id, user.displayName, user.email],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Could not save user profile');
  return row;
}

export class PgHouseholdRepository implements HouseholdRepository {
  constructor(private readonly pool: Pool) {}

  async getProfile(user: AuthenticatedUser): Promise<AuthenticatedUser> {
    const row = await ensureProfile(this.pool, user);
    return {
      id: row.auth_user_id,
      email: row.email,
      displayName: row.display_name,
    };
  }

  async updateProfile(
    user: AuthenticatedUser,
    displayName: string,
  ): Promise<AuthenticatedUser> {
    const result = await this.pool.query<{
      auth_user_id: string;
      display_name: string;
      email: string | null;
    }>(
      `INSERT INTO housemate.users (auth_user_id, display_name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (auth_user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, email = EXCLUDED.email, updated_at = now()
       RETURNING auth_user_id, display_name, email`,
      [user.id, displayName, user.email],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Could not update user profile');
    return {
      id: row.auth_user_id,
      email: row.email,
      displayName: row.display_name,
    };
  }

  async create(
    user: AuthenticatedUser,
    input: CreateHouseholdInput,
  ): Promise<Household> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const profile = await ensureProfile(client, user);
      const created = await client.query<{ id: string }>(
        `INSERT INTO housemate.households (name, default_currency, timezone, owner_user_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.currency, input.timezone, profile.id],
      );
      const householdId = created.rows[0]?.id;
      if (!householdId) throw new Error('Could not create household');
      await client.query(
        `INSERT INTO housemate.household_members (household_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [householdId, profile.id],
      );
      const result = await client.query<HouseholdRow>(
        `SELECT ${householdColumns}
         FROM housemate.households h
         JOIN housemate.household_members m ON m.household_id = h.id
         WHERE h.id = $1 AND m.user_id = $2`,
        [householdId, profile.id],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Created household could not be read');
      await client.query('COMMIT');
      return toHousehold(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(authUserId: string): Promise<Household[]> {
    const result = await this.pool.query<HouseholdRow>(
      `SELECT ${householdColumns}
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id
       JOIN housemate.users u ON u.id = m.user_id
       WHERE u.auth_user_id = $1 AND m.status = 'active' AND h.archived_at IS NULL
       ORDER BY h.created_at DESC, h.id DESC`,
      [authUserId],
    );
    return result.rows.map(toHousehold);
  }

  async get(
    authUserId: string,
    householdId: string,
  ): Promise<Household | null> {
    const result = await this.pool.query<HouseholdRow>(
      `SELECT ${householdColumns}
       FROM housemate.households h
       JOIN housemate.household_members m ON m.household_id = h.id
       JOIN housemate.users u ON u.id = m.user_id
       WHERE h.id = $1 AND u.auth_user_id = $2
         AND m.status = 'active' AND h.archived_at IS NULL`,
      [householdId, authUserId],
    );
    const row = result.rows[0];
    return row ? toHousehold(row) : null;
  }

  async update(
    authUserId: string,
    householdId: string,
    input: UpdateHouseholdInput,
  ): Promise<Household> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const access = await client.query<HouseholdRow>(
        `SELECT ${householdColumns}
         FROM housemate.households h
         JOIN housemate.household_members m ON m.household_id = h.id
         JOIN housemate.users u ON u.id = m.user_id
         WHERE h.id = $1 AND u.auth_user_id = $2
           AND m.status = 'active' AND h.archived_at IS NULL
         FOR UPDATE OF h, m`,
        [householdId, authUserId],
      );
      const current = access.rows[0];
      if (!current)
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
      if (current.role === 'member')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only owners and admins can edit household settings.',
        );
      if (input.currency && input.currency !== current.default_currency) {
        if (current.role !== 'owner')
          throw new ApiError(
            403,
            'FORBIDDEN',
            'Only the owner can change currency.',
          );
        if (!current.currency_editable)
          throw new ApiError(
            409,
            'CURRENCY_LOCKED',
            'Currency cannot change after financial activity.',
          );
      }
      await client.query(
        `UPDATE housemate.households SET
           name = COALESCE($2, name),
           timezone = COALESCE($3, timezone),
           default_currency = COALESCE($4, default_currency),
           updated_at = now()
         WHERE id = $1`,
        [
          householdId,
          input.name ?? null,
          input.timezone ?? null,
          input.currency ?? null,
        ],
      );
      const result = await client.query<HouseholdRow>(
        `SELECT ${householdColumns}
         FROM housemate.households h
         JOIN housemate.household_members m ON m.household_id = h.id
         JOIN housemate.users u ON u.id = m.user_id
         WHERE h.id = $1 AND u.auth_user_id = $2`,
        [householdId, authUserId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Updated household could not be read');
      await client.query('COMMIT');
      return toHousehold(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listMembers(
    authUserId: string,
    householdId: string,
  ): Promise<HouseholdMember[]> {
    const result = await this.pool.query<MemberRow>(
      `SELECT m.id, u.display_name, u.email, m.role, m.joined_at
       FROM housemate.household_members m
       JOIN housemate.users u ON u.id = m.user_id
       JOIN housemate.households h ON h.id = m.household_id
       WHERE m.household_id = $1 AND m.status = 'active' AND h.archived_at IS NULL
         AND EXISTS (
           SELECT 1 FROM housemate.household_members caller
           JOIN housemate.users cu ON cu.id = caller.user_id
           WHERE caller.household_id = m.household_id
             AND caller.status = 'active' AND cu.auth_user_id = $2
         )
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                m.joined_at, m.id`,
      [householdId, authUserId],
    );
    return result.rows.map(toMember);
  }

  async updateMemberRole(
    authUserId: string,
    householdId: string,
    memberId: string,
    role: 'admin' | 'member',
  ): Promise<HouseholdMember> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const actor = await client.query<{ role: string }>(
        `SELECT m.role FROM housemate.household_members m
         JOIN housemate.users u ON u.id = m.user_id
         JOIN housemate.households h ON h.id = m.household_id
         WHERE m.household_id = $1 AND u.auth_user_id = $2
           AND m.status = 'active' AND h.archived_at IS NULL
         FOR UPDATE OF m`,
        [householdId, authUserId],
      );
      if (!actor.rows[0])
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
      if (actor.rows[0].role !== 'owner')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the owner can change member roles.',
        );
      const target = await client.query<{ role: string }>(
        `SELECT role FROM housemate.household_members
         WHERE id = $1 AND household_id = $2 AND status = 'active'
         FOR UPDATE`,
        [memberId, householdId],
      );
      if (!target.rows[0])
        throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      if (target.rows[0].role === 'owner')
        throw new ApiError(
          409,
          'OWNER_ROLE_FIXED',
          'The owner role cannot be changed here.',
        );
      const result = await client.query<MemberRow>(
        `UPDATE housemate.household_members m SET role = $2, updated_at = now()
         FROM housemate.users u
         WHERE m.id = $1 AND u.id = m.user_id
         RETURNING m.id, u.display_name, u.email, m.role, m.joined_at`,
        [memberId, role],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Updated member could not be read');
      await client.query('COMMIT');
      return toMember(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createInvite(
    authUserId: string,
    householdId: string,
    tokenHash: string,
  ): Promise<HouseholdInvite> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const actor = await client.query<{ id: string; role: string }>(
        `SELECT u.id, m.role FROM housemate.households h
         JOIN housemate.household_members m ON m.household_id = h.id
         JOIN housemate.users u ON u.id = m.user_id
         WHERE h.id = $1 AND u.auth_user_id = $2
           AND m.status = 'active' AND h.archived_at IS NULL
         FOR UPDATE OF h`,
        [householdId, authUserId],
      );
      const membership = actor.rows[0];
      if (!membership)
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
      if (membership.role === 'member')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only owners and admins can create invitations.',
        );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM housemate.household_invites
         WHERE household_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
           AND expires_at > now()`,
        [householdId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= 20) {
        throw new ApiError(
          409,
          'INVITE_LIMIT',
          'Revoke an unused invitation before creating another.',
        );
      }
      const result = await client.query<InviteRow>(
        `INSERT INTO housemate.household_invites
           (household_id, token_hash, created_by_user_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '7 days')
         RETURNING id, created_at, expires_at, redeemed_at, revoked_at`,
        [householdId, tokenHash, membership.id],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Could not create invitation');
      await client.query('COMMIT');
      return toInvite(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listInvites(
    authUserId: string,
    householdId: string,
  ): Promise<HouseholdInvite[]> {
    const household = await this.get(authUserId, householdId);
    if (!household)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    if (household.role === 'member')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only owners and admins can view invitations.',
      );
    const result = await this.pool.query<InviteRow>(
      `SELECT i.id, i.created_at, i.expires_at, i.redeemed_at, i.revoked_at
       FROM housemate.household_invites i
       WHERE i.household_id = $1
         AND EXISTS (
           SELECT 1 FROM housemate.household_members m
           JOIN housemate.users u ON u.id = m.user_id
           WHERE m.household_id = i.household_id AND u.auth_user_id = $2
             AND m.status = 'active' AND m.role IN ('owner', 'admin')
         )
       ORDER BY i.created_at DESC LIMIT 50`,
      [householdId, authUserId],
    );
    return result.rows.map(toInvite);
  }

  async revokeInvite(
    authUserId: string,
    householdId: string,
    inviteId: string,
  ): Promise<void> {
    const household = await this.get(authUserId, householdId);
    if (!household)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    if (household.role === 'member')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only owners and admins can revoke invitations.',
      );
    const result = await this.pool.query(
      `UPDATE housemate.household_invites i SET revoked_at = now()
       WHERE i.id = $1 AND i.household_id = $2 AND i.revoked_at IS NULL
         AND i.redeemed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM housemate.household_members m
           JOIN housemate.users u ON u.id = m.user_id
           WHERE m.household_id = i.household_id AND u.auth_user_id = $3
             AND m.status = 'active' AND m.role IN ('owner', 'admin')
         )
       RETURNING i.id`,
      [inviteId, householdId, authUserId],
    );
    if (!result.rowCount)
      throw new ApiError(404, 'NOT_FOUND', 'Active invitation not found.');
  }

  async previewInvite(
    authUserId: string,
    tokenHash: string,
  ): Promise<InvitePreview> {
    const result = await this.pool.query<{
      household_id: string;
      household_name: string;
      expires_at: Date;
      redeemed_at: Date | null;
      redeemed_by_auth_user_id: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT h.id AS household_id, h.name AS household_name,
              i.expires_at, i.redeemed_at, i.revoked_at,
              redeemed.auth_user_id AS redeemed_by_auth_user_id
       FROM housemate.household_invites i
       JOIN housemate.households h ON h.id = i.household_id
       LEFT JOIN housemate.users redeemed ON redeemed.id = i.redeemed_by_user_id
       WHERE i.token_hash = $1 AND h.archived_at IS NULL`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row)
      throw new ApiError(
        404,
        'INVALID_INVITE',
        'This invitation link is invalid.',
      );
    if (row.revoked_at)
      throw new ApiError(
        410,
        'INVITE_REVOKED',
        'This invitation has been revoked.',
      );
    if (row.redeemed_at && row.redeemed_by_auth_user_id !== authUserId)
      throw new ApiError(
        410,
        'INVITE_USED',
        'This invitation has already been used.',
      );
    if (!row.redeemed_at && row.expires_at.getTime() <= Date.now())
      throw new ApiError(
        410,
        'INVITE_EXPIRED',
        'This invitation has expired. Ask for a new link.',
      );
    return {
      householdId: row.household_id,
      householdName: row.household_name,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async acceptInvite(
    user: AuthenticatedUser,
    tokenHash: string,
  ): Promise<Household> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        id: string;
        household_id: string;
        expires_at: Date;
        redeemed_at: Date | null;
        redeemed_by_user_id: string | null;
        revoked_at: Date | null;
      }>(
        `SELECT i.id, i.household_id, i.expires_at, i.redeemed_at,
                i.redeemed_by_user_id, i.revoked_at
         FROM housemate.household_invites i
         JOIN housemate.households h ON h.id = i.household_id
         WHERE i.token_hash = $1 AND h.archived_at IS NULL
         FOR UPDATE OF i`,
        [tokenHash],
      );
      const invite = result.rows[0];
      if (!invite)
        throw new ApiError(
          404,
          'INVALID_INVITE',
          'This invitation link is invalid.',
        );
      if (invite.revoked_at)
        throw new ApiError(
          410,
          'INVITE_REVOKED',
          'This invitation has been revoked.',
        );
      if (invite.redeemed_at) {
        const previous = await client.query<HouseholdRow>(
          `SELECT ${householdColumns}
           FROM housemate.households h
           JOIN housemate.household_members m ON m.household_id = h.id
           JOIN housemate.users u ON u.id = m.user_id
           WHERE h.id = $1 AND m.user_id = $2 AND u.auth_user_id = $3
             AND m.status = 'active'`,
          [invite.household_id, invite.redeemed_by_user_id, user.id],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return toHousehold(previous.rows[0]);
        }
        throw new ApiError(
          410,
          'INVITE_USED',
          'This invitation has already been used.',
        );
      }
      if (invite.expires_at.getTime() <= Date.now())
        throw new ApiError(
          410,
          'INVITE_EXPIRED',
          'This invitation has expired. Ask for a new link.',
        );
      const profile = await ensureProfile(client, user);
      const existing = await client.query<{ status: string }>(
        `SELECT status FROM housemate.household_members
         WHERE household_id = $1 AND user_id = $2 FOR UPDATE`,
        [invite.household_id, profile.id],
      );
      if (existing.rows[0]?.status === 'active')
        throw new ApiError(
          409,
          'ALREADY_MEMBER',
          'You already belong to this household.',
        );
      await client.query(
        `INSERT INTO housemate.household_members
           (household_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'member', 'active', now())
         ON CONFLICT (household_id, user_id) DO UPDATE SET
           role = 'member', status = 'active', joined_at = now(),
           left_at = NULL, updated_at = now()`,
        [invite.household_id, profile.id],
      );
      await client.query(
        `UPDATE housemate.household_invites
         SET redeemed_at = now(), redeemed_by_user_id = $2 WHERE id = $1`,
        [invite.id, profile.id],
      );
      const joined = await client.query<HouseholdRow>(
        `SELECT ${householdColumns}
         FROM housemate.households h
         JOIN housemate.household_members m ON m.household_id = h.id
         WHERE h.id = $1 AND m.user_id = $2`,
        [invite.household_id, profile.id],
      );
      const row = joined.rows[0];
      if (!row) throw new Error('Joined household could not be read');
      await client.query('COMMIT');
      return toHousehold(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
