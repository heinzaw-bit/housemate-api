import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import type {
  AuthenticatedUser,
  CreateHouseholdInput,
  Household,
  HouseholdInvite,
  HouseholdMember,
  HouseholdRepository,
  InvitePreview,
  UpdateHouseholdInput,
} from '../src/types.js';

const alice: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'alice@example.test',
  displayName: 'Alice',
};
const bob: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'bob@example.test',
  displayName: 'Bob',
};
const carol: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000003',
  email: 'carol@example.test',
  displayName: 'Carol',
};

interface StoredHousehold {
  data: Omit<Household, 'role'>;
  members: Map<string, HouseholdMember>;
}
interface StoredInvite extends HouseholdInvite {
  householdId: string;
  tokenHash: string;
  redeemedByUserId: string | null;
}

class FakeHouseholds implements HouseholdRepository {
  private profiles = new Map<string, AuthenticatedUser>();
  private rows = new Map<string, StoredHousehold>();
  private invites = new Map<string, StoredInvite>();

  private row(id: string): StoredHousehold {
    const value = this.rows.get(id);
    if (!value) throw new Error('Missing test household');
    return value;
  }

  private invite(tokenHash: string): StoredInvite {
    const value = this.invites.get(tokenHash);
    if (!value) throw new Error('Missing test invitation');
    return value;
  }

  async getProfile(user: AuthenticatedUser): Promise<AuthenticatedUser> {
    const current = this.profiles.get(user.id);
    const profile = {
      ...user,
      displayName: current?.displayName ?? user.displayName,
    };
    this.profiles.set(user.id, profile);
    return profile;
  }

  async updateProfile(
    user: AuthenticatedUser,
    displayName: string,
  ): Promise<AuthenticatedUser> {
    const profile = { ...user, displayName };
    this.profiles.set(user.id, profile);
    for (const household of this.rows.values()) {
      const membership = household.members.get(user.id);
      if (membership)
        household.members.set(user.id, { ...membership, displayName });
    }
    return profile;
  }

  async create(
    user: AuthenticatedUser,
    input: CreateHouseholdInput,
  ): Promise<Household> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const household: Household = {
      id,
      name: input.name,
      defaultCurrency: input.currency,
      timezone: input.timezone,
      role: 'owner',
      currencyEditable: true,
      createdAt,
    };
    const profile = await this.getProfile(user);
    this.rows.set(id, {
      data: household,
      members: new Map([
        [
          user.id,
          {
            id: randomUUID(),
            displayName: profile.displayName,
            email: profile.email,
            role: 'owner',
            joinedAt: createdAt,
          },
        ],
      ]),
    });
    return household;
  }

  async list(authUserId: string): Promise<Household[]> {
    return [...this.rows.keys()]
      .map((id) => this.asMember(id, authUserId))
      .filter((item): item is Household => item !== null);
  }

  async get(
    authUserId: string,
    householdId: string,
  ): Promise<Household | null> {
    return this.asMember(householdId, authUserId);
  }

  private asMember(householdId: string, authUserId: string): Household | null {
    const row = this.rows.get(householdId);
    const member = row?.members.get(authUserId);
    return row && member ? { ...row.data, role: member.role } : null;
  }

  private requireMember(authUserId: string, householdId: string): Household {
    const household = this.asMember(householdId, authUserId);
    if (!household)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return household;
  }

  async update(
    authUserId: string,
    householdId: string,
    input: UpdateHouseholdInput,
  ): Promise<Household> {
    const household = this.requireMember(authUserId, householdId);
    if (household.role === 'member')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only owners and admins can edit household settings.',
      );
    if (input.currency && input.currency !== household.defaultCurrency) {
      if (household.role !== 'owner')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the owner can change currency.',
        );
      if (!household.currencyEditable)
        throw new ApiError(
          409,
          'CURRENCY_LOCKED',
          'Currency cannot change after financial activity.',
        );
    }
    const row = this.row(householdId);
    row.data = {
      ...row.data,
      name: input.name ?? row.data.name,
      timezone: input.timezone ?? row.data.timezone,
      defaultCurrency: input.currency ?? row.data.defaultCurrency,
    };
    return this.requireMember(authUserId, householdId);
  }

  lockCurrency(householdId: string) {
    this.row(householdId).data.currencyEditable = false;
  }

  async listMembers(
    authUserId: string,
    householdId: string,
  ): Promise<HouseholdMember[]> {
    this.requireMember(authUserId, householdId);
    return [...this.row(householdId).members.values()];
  }

  async updateMemberRole(
    authUserId: string,
    householdId: string,
    memberId: string,
    role: 'admin' | 'member',
  ): Promise<HouseholdMember> {
    const household = this.requireMember(authUserId, householdId);
    if (household.role !== 'owner')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the owner can change member roles.',
      );
    const row = this.row(householdId);
    const entry = [...row.members.entries()].find(
      ([, member]) => member.id === memberId,
    );
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
    if (entry[1].role === 'owner')
      throw new ApiError(
        409,
        'OWNER_ROLE_FIXED',
        'The owner role cannot be changed here.',
      );
    const updated = { ...entry[1], role };
    row.members.set(entry[0], updated);
    return updated;
  }

  async createInvite(
    authUserId: string,
    householdId: string,
    tokenHash: string,
  ): Promise<HouseholdInvite> {
    const household = this.requireMember(authUserId, householdId);
    if (household.role === 'member')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only owners and admins can create invitations.',
      );
    const createdAt = new Date();
    const invite: StoredInvite = {
      id: randomUUID(),
      householdId,
      tokenHash,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 7 * 86400_000).toISOString(),
      redeemedAt: null,
      redeemedByUserId: null,
      revokedAt: null,
    };
    this.invites.set(tokenHash, invite);
    return invite;
  }

  async listInvites(
    authUserId: string,
    householdId: string,
  ): Promise<HouseholdInvite[]> {
    const household = this.requireMember(authUserId, householdId);
    if (household.role === 'member')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only owners and admins can view invitations.',
      );
    return [...this.invites.values()].filter(
      (invite) => invite.householdId === householdId,
    );
  }

  async revokeInvite(
    authUserId: string,
    householdId: string,
    inviteId: string,
  ): Promise<void> {
    const household = this.requireMember(authUserId, householdId);
    if (household.role === 'member')
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only owners and admins can revoke invitations.',
      );
    const invite = [...this.invites.values()].find(
      (item) =>
        item.id === inviteId &&
        item.householdId === householdId &&
        !item.redeemedAt &&
        !item.revokedAt,
    );
    if (!invite)
      throw new ApiError(404, 'NOT_FOUND', 'Active invitation not found.');
    invite.revokedAt = new Date().toISOString();
  }

  expireInvite(tokenHash: string) {
    this.invite(tokenHash).expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
  }

  async previewInvite(
    authUserId: string,
    tokenHash: string,
  ): Promise<InvitePreview> {
    const invite = this.invites.get(tokenHash);
    if (!invite)
      throw new ApiError(
        404,
        'INVALID_INVITE',
        'This invitation link is invalid.',
      );
    if (invite.revokedAt)
      throw new ApiError(
        410,
        'INVITE_REVOKED',
        'This invitation has been revoked.',
      );
    if (invite.redeemedAt && invite.redeemedByUserId !== authUserId)
      throw new ApiError(
        410,
        'INVITE_USED',
        'This invitation has already been used.',
      );
    if (
      !invite.redeemedAt &&
      new Date(invite.expiresAt).getTime() <= Date.now()
    )
      throw new ApiError(410, 'INVITE_EXPIRED', 'This invitation has expired.');
    return {
      householdId: invite.householdId,
      householdName: this.row(invite.householdId).data.name,
      expiresAt: invite.expiresAt,
    };
  }

  async acceptInvite(
    user: AuthenticatedUser,
    tokenHash: string,
  ): Promise<Household> {
    const invite = this.invites.get(tokenHash);
    if (invite?.redeemedAt && invite.redeemedByUserId === user.id)
      return this.requireMember(user.id, invite.householdId);
    const preview = await this.previewInvite(user.id, tokenHash);
    const row = this.row(preview.householdId);
    if (row.members.has(user.id))
      throw new ApiError(
        409,
        'ALREADY_MEMBER',
        'You already belong to this household.',
      );
    const profile = await this.getProfile(user);
    row.members.set(user.id, {
      id: randomUUID(),
      displayName: profile.displayName,
      email: profile.email,
      role: 'member',
      joinedAt: new Date().toISOString(),
    });
    this.invite(tokenHash).redeemedAt = new Date().toISOString();
    this.invite(tokenHash).redeemedByUserId = user.id;
    return this.requireMember(user.id, preview.householdId);
  }
}

function setup() {
  const households = new FakeHouseholds();
  const app = createApp({
    auth: async (token) =>
      token === 'alice'
        ? alice
        : token === 'bob'
          ? bob
          : token === 'carol'
            ? carol
            : null,
    households,
  });
  const call = async (
    who: 'alice' | 'bob' | 'carol',
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, string>,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${who}` },
      payload,
    });
  return { app, households, call };
}

async function makeHousehold(
  call: ReturnType<typeof setup>['call'],
  who: 'alice' | 'bob' | 'carol' = 'alice',
) {
  const response = await call(who, 'POST', '/v1/households', {
    name: 'Our home',
    currency: 'THB',
    timezone: 'Asia/Bangkok',
  });
  assert.equal(response.statusCode, 201);
  return response.json() as Household;
}

async function makeInvite(
  call: ReturnType<typeof setup>['call'],
  householdId: string,
  who: 'alice' | 'bob' | 'carol' = 'alice',
) {
  const response = await call(
    who,
    'POST',
    `/v1/households/${householdId}/invites`,
  );
  assert.equal(response.statusCode, 201);
  return response.json() as HouseholdInvite & { token: string };
}

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

test('health is public and protected routes reject missing or invalid tokens', async () => {
  const { app } = setup();
  try {
    assert.deepEqual(
      (await app.inject({ method: 'GET', url: '/health' })).json(),
      { status: 'ok' },
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/households' })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('household creation validates currency and timezone and profile edits persist', async () => {
  const { app, call } = setup();
  try {
    for (const currency of ['USD', 'THB']) {
      const response = await call('alice', 'POST', '/v1/households', {
        name: ' Our home ',
        currency,
        timezone: 'Asia/Bangkok',
      });
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().name, 'Our home');
      assert.equal(response.json().defaultCurrency, currency);
      assert.equal(response.json().currencyEditable, true);
    }
    assert.equal(
      (
        await call('alice', 'POST', '/v1/households', {
          name: 'Home',
          currency: 'EUR',
          timezone: 'Asia/Bangkok',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call('alice', 'POST', '/v1/households', {
          name: 'Home',
          currency: 'THB',
          timezone: 'Invalid/Zone',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await call('alice', 'GET', '/v1/households')).json().households.length,
      2,
    );
    assert.equal(
      (
        await call('alice', 'PATCH', '/v1/me', {
          displayName: ' Alice Housemate ',
        })
      ).json().displayName,
      'Alice Housemate',
    );
    assert.equal(
      (await call('alice', 'GET', '/v1/me')).json().displayName,
      'Alice Housemate',
    );
    assert.equal(
      (await call('alice', 'PATCH', '/v1/me', { displayName: '   ' }))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test('two users join one household while another household remains private', async () => {
  const { app, call } = setup();
  try {
    const first = await makeHousehold(call);
    const bobHome = await makeHousehold(call, 'bob');
    const invite = await makeInvite(call, first.id);
    assert.equal(
      (await call('bob', 'GET', `/v1/invites/${invite.token}`)).json()
        .householdName,
      'Our home',
    );
    const joined = await call(
      'bob',
      'POST',
      `/v1/invites/${invite.token}/accept`,
    );
    assert.equal(joined.statusCode, 200);
    assert.equal(joined.json().role, 'member');
    assert.deepEqual(
      (await call('alice', 'GET', '/v1/households'))
        .json()
        .households.map((item: Household) => item.id),
      [first.id],
    );
    assert.deepEqual(
      (await call('bob', 'GET', '/v1/households'))
        .json()
        .households.map((item: Household) => item.id)
        .sort(),
      [bobHome.id, first.id].sort(),
    );
    assert.equal(
      (await call('bob', 'GET', `/v1/households/${first.id}/members`)).json()
        .members.length,
      2,
    );
    for (const url of [
      `/v1/households/${first.id}`,
      `/v1/households/${first.id}/members`,
    ]) {
      assert.equal((await call('carol', 'GET', url)).statusCode, 404);
    }
    assert.equal(
      (
        await call('carol', 'PATCH', `/v1/households/${first.id}`, {
          name: 'Stolen',
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await call('carol', 'POST', `/v1/households/${first.id}/invites`))
        .statusCode,
      404,
    );
    assert.equal(
      (await call('alice', 'GET', `/v1/households/${bobHome.id}`)).statusCode,
      404,
    );
    assert.equal(
      (await call('alice', 'GET', `/v1/households/${bobHome.id}/members`))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test('invites reject invalid, expired, revoked, and already-used links', async () => {
  const { app, households, call } = setup();
  try {
    const household = await makeHousehold(call);
    assert.equal(
      (await call('bob', 'GET', '/v1/invites/bad')).json().error.code,
      'INVALID_INVITE',
    );
    const expired = await makeInvite(call, household.id);
    households.expireInvite(hash(expired.token));
    assert.equal(
      (await call('bob', 'POST', `/v1/invites/${expired.token}/accept`)).json()
        .error.code,
      'INVITE_EXPIRED',
    );
    const revoked = await makeInvite(call, household.id);
    assert.equal(
      (
        await call(
          'alice',
          'DELETE',
          `/v1/households/${household.id}/invites/${revoked.id}`,
        )
      ).statusCode,
      204,
    );
    assert.equal(
      (await call('bob', 'GET', `/v1/invites/${revoked.token}`)).json().error
        .code,
      'INVITE_REVOKED',
    );
    const used = await makeInvite(call, household.id);
    assert.equal(
      (await call('bob', 'POST', `/v1/invites/${used.token}/accept`))
        .statusCode,
      200,
    );
    assert.equal(
      (await call('bob', 'GET', `/v1/invites/${used.token}`)).statusCode,
      200,
    );
    assert.equal(
      (await call('bob', 'POST', `/v1/invites/${used.token}/accept`))
        .statusCode,
      200,
    );
    assert.equal(
      (await call('carol', 'POST', `/v1/invites/${used.token}/accept`)).json()
        .error.code,
      'INVITE_USED',
    );
    const alreadyMember = await makeInvite(call, household.id);
    assert.equal(
      (
        await call('bob', 'POST', `/v1/invites/${alreadyMember.token}/accept`)
      ).json().error.code,
      'ALREADY_MEMBER',
    );
  } finally {
    await app.close();
  }
});

test('roles and settings are enforced by API, including currency lock', async () => {
  const { app, households, call } = setup();
  try {
    const household = await makeHousehold(call);
    const invite = await makeInvite(call, household.id);
    await call('bob', 'POST', `/v1/invites/${invite.token}/accept`);
    const members = (
      await call('alice', 'GET', `/v1/households/${household.id}/members`)
    ).json().members as HouseholdMember[];
    const owner = members.find((member) => member.role === 'owner');
    const member = members.find((item) => item.role === 'member');
    assert.ok(owner);
    assert.ok(member);
    assert.equal(
      (await call('bob', 'POST', `/v1/households/${household.id}/invites`))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await call('bob', 'PATCH', `/v1/households/${household.id}`, {
          name: 'Nope',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          'bob',
          'PATCH',
          `/v1/households/${household.id}/members/${owner.id}`,
          { role: 'member' },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          'alice',
          'PATCH',
          `/v1/households/${household.id}/members/${owner.id}`,
          { role: 'member' },
        )
      ).json().error.code,
      'OWNER_ROLE_FIXED',
    );
    assert.equal(
      (
        await call(
          'alice',
          'PATCH',
          `/v1/households/${household.id}/members/${member.id}`,
          { role: 'admin' },
        )
      ).json().role,
      'admin',
    );
    assert.equal(
      (await call('bob', 'POST', `/v1/households/${household.id}/invites`))
        .statusCode,
      201,
    );
    assert.equal(
      (
        await call(
          'bob',
          'PATCH',
          `/v1/households/${household.id}/members/${owner.id}`,
          { role: 'member' },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call('bob', 'PATCH', `/v1/households/${household.id}`, {
          name: 'New name',
          timezone: 'America/New_York',
        })
      ).json().name,
      'New name',
    );
    assert.equal(
      (
        await call('bob', 'PATCH', `/v1/households/${household.id}`, {
          currency: 'USD',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call('alice', 'PATCH', `/v1/households/${household.id}`, {
          currency: 'USD',
        })
      ).json().defaultCurrency,
      'USD',
    );
    households.lockCurrency(household.id);
    assert.equal(
      (
        await call('alice', 'PATCH', `/v1/households/${household.id}`, {
          currency: 'THB',
        })
      ).json().error.code,
      'CURRENCY_LOCKED',
    );
  } finally {
    await app.close();
  }
});

test('browser preflight allows only configured origin for PATCH and DELETE', async () => {
  const { app } = setup();
  try {
    for (const method of ['PATCH', 'DELETE']) {
      const allowed = await app.inject({
        method: 'OPTIONS',
        url: '/v1/households',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      assert.equal(allowed.statusCode, 204);
      assert.equal(
        allowed.headers['access-control-allow-origin'],
        'http://localhost:3000',
      );
    }
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/v1/households',
      headers: {
        origin: 'https://other.example',
        'access-control-request-method': 'PATCH',
      },
    });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
  }
});
