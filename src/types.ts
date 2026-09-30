export type Currency = 'USD' | 'THB';

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  displayName: string;
}

export interface Household {
  id: string;
  name: string;
  defaultCurrency: Currency;
  timezone: string;
  role: 'owner' | 'admin' | 'member';
  currencyEditable: boolean;
  createdAt: string;
}

export type HouseholdRole = Household['role'];

export interface HouseholdMember {
  id: string;
  displayName: string;
  email: string | null;
  role: HouseholdRole;
  joinedAt: string;
}

export interface HouseholdInvite {
  id: string;
  expiresAt: string;
  createdAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
}

export interface InvitePreview {
  householdId: string;
  householdName: string;
  expiresAt: string;
}

export interface UpdateHouseholdInput {
  name?: string;
  timezone?: string;
  currency?: Currency;
}

export interface CreateHouseholdInput {
  name: string;
  currency: Currency;
  timezone: string;
}

export interface HouseholdRepository {
  getProfile(user: AuthenticatedUser): Promise<AuthenticatedUser>;
  updateProfile(
    user: AuthenticatedUser,
    displayName: string,
  ): Promise<AuthenticatedUser>;
  create(
    user: AuthenticatedUser,
    input: CreateHouseholdInput,
  ): Promise<Household>;
  list(authUserId: string): Promise<Household[]>;
  get(authUserId: string, householdId: string): Promise<Household | null>;
  update(
    authUserId: string,
    householdId: string,
    input: UpdateHouseholdInput,
  ): Promise<Household>;
  listMembers(
    authUserId: string,
    householdId: string,
  ): Promise<HouseholdMember[]>;
  updateMemberRole(
    authUserId: string,
    householdId: string,
    memberId: string,
    role: 'admin' | 'member',
  ): Promise<HouseholdMember>;
  createInvite(
    authUserId: string,
    householdId: string,
    tokenHash: string,
  ): Promise<HouseholdInvite>;
  listInvites(
    authUserId: string,
    householdId: string,
  ): Promise<HouseholdInvite[]>;
  revokeInvite(
    authUserId: string,
    householdId: string,
    inviteId: string,
  ): Promise<void>;
  previewInvite(authUserId: string, tokenHash: string): Promise<InvitePreview>;
  acceptInvite(user: AuthenticatedUser, tokenHash: string): Promise<Household>;
}

export type AuthVerifier = (token: string) => Promise<AuthenticatedUser | null>;
