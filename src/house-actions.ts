import type { Pool } from 'pg';
import { ApiError } from './errors.js';

export interface HouseActions {
  householdId: string;
  generatedAt: string;
  mealResponses: {
    id: string;
    title: string;
    startsAt: string;
    responseDeadline: string;
  }[];
  swapRequests: { id: string; title: string; dueAt: string }[];
  chores: { id: string; title: string; dueAt: string }[];
  shopping: {
    id: string;
    title: string;
    quantity: number | null;
    unit: string | null;
    priority: 'low' | 'normal' | 'high';
  }[];
  announcements: {
    id: string;
    title: string;
    priority: 'normal' | 'important' | 'urgent';
    expiresAt: string | null;
  }[];
  polls: { id: string; question: string; deadline: string }[];
}

export interface HouseActionRepository {
  get(authUserId: string, householdId: string): Promise<HouseActions>;
}

export class PgHouseActionRepository implements HouseActionRepository {
  constructor(private readonly pool: Pool) {}

  async get(authUserId: string, householdId: string): Promise<HouseActions> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const access = await client.query<{ member_id: string }>(
        `SELECT m.id AS member_id FROM housemate.household_members m
         JOIN housemate.households h ON h.id = m.household_id
         JOIN housemate.users u ON u.id = m.user_id
         WHERE h.id = $1 AND u.auth_user_id = $2
           AND m.status = 'active' AND h.archived_at IS NULL`,
        [householdId, authUserId],
      );
      const memberId = access.rows[0]?.member_id;
      if (!memberId)
        throw new ApiError(404, 'NOT_FOUND', 'Household not found.');

      const meals = await client.query<{
        id: string;
        title: string;
        starts_at: Date;
        response_deadline: Date;
      }>(
        `SELECT mc.id, mc.question AS title, mc.starts_at, mc.response_deadline
         FROM housemate.meal_participants mp
         JOIN housemate.meal_checks mc ON mc.id = mp.meal_id
         WHERE mp.member_id = $1 AND mc.household_id = $2
           AND mp.response IS NULL AND mc.response_deadline > now()
           AND mc.starts_at > now()
         ORDER BY mc.response_deadline, mc.id LIMIT 3`,
        [memberId, householdId],
      );
      const swaps = await client.query<{
        id: string;
        title: string;
        due_at: Date;
      }>(
        `SELECT c.id, c.title, c.due_at
         FROM housemate.chore_swap_requests s
         JOIN housemate.chores c ON c.id = s.chore_id
         WHERE s.target_member_id = $1 AND c.household_id = $2
           AND s.status = 'pending' AND c.status = 'open'
         ORDER BY s.created_at, s.id LIMIT 3`,
        [memberId, householdId],
      );
      const chores = await client.query<{
        id: string;
        title: string;
        due_at: Date;
      }>(
        `SELECT id, title, due_at FROM housemate.chores
         WHERE assignee_member_id = $1 AND household_id = $2 AND status = 'open'
         ORDER BY due_at, id LIMIT 3`,
        [memberId, householdId],
      );
      const shopping = await client.query<{
        id: string;
        title: string;
        quantity: string | null;
        unit: string | null;
        priority: 'low' | 'normal' | 'high';
      }>(
        `SELECT id, title, quantity::text, unit, priority
         FROM housemate.shopping_items
         WHERE assigned_buyer_member_id = $1 AND household_id = $2
           AND status = 'assigned'
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
           updated_at DESC, id DESC LIMIT 3`,
        [memberId, householdId],
      );
      const announcements = await client.query<{
        id: string;
        title: string;
        priority: 'normal' | 'important' | 'urgent';
        expires_at: Date | null;
      }>(
        `SELECT a.id, a.title, a.priority, a.expires_at
         FROM housemate.announcement_recipients r
         JOIN housemate.announcements a ON a.id = r.announcement_id
         WHERE r.member_id = $1 AND a.household_id = $2
           AND r.acknowledged_at IS NULL AND a.requires_acknowledgement
           AND (a.expires_at IS NULL OR a.expires_at > now())
         ORDER BY CASE a.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
           a.published_at DESC, a.id DESC LIMIT 3`,
        [memberId, householdId],
      );
      const polls = await client.query<{
        id: string;
        question: string;
        deadline: Date;
      }>(
        `SELECT p.id, p.question, p.deadline FROM housemate.poll_voters pv
         JOIN housemate.polls p ON p.id = pv.poll_id
         WHERE pv.member_id = $1 AND p.household_id = $2 AND p.deadline > now()
           AND NOT EXISTS (SELECT 1 FROM housemate.poll_votes v WHERE v.poll_id = p.id AND v.member_id = $1)
         ORDER BY p.deadline, p.id LIMIT 3`,
        [memberId, householdId],
      );
      const clock = await client.query<{ generated_at: Date }>(
        'SELECT now() AS generated_at',
      );
      await client.query('COMMIT');
      return {
        householdId,
        generatedAt:
          clock.rows[0]?.generated_at.toISOString() ?? new Date().toISOString(),
        mealResponses: meals.rows.map((meal) => ({
          id: meal.id,
          title: meal.title,
          startsAt: meal.starts_at.toISOString(),
          responseDeadline: meal.response_deadline.toISOString(),
        })),
        swapRequests: swaps.rows.map((swap) => ({
          id: swap.id,
          title: swap.title,
          dueAt: swap.due_at.toISOString(),
        })),
        chores: chores.rows.map((chore) => ({
          id: chore.id,
          title: chore.title,
          dueAt: chore.due_at.toISOString(),
        })),
        shopping: shopping.rows.map((item) => ({
          id: item.id,
          title: item.title,
          quantity: item.quantity === null ? null : Number(item.quantity),
          unit: item.unit,
          priority: item.priority,
        })),
        announcements: announcements.rows.map((announcement) => ({
          id: announcement.id,
          title: announcement.title,
          priority: announcement.priority,
          expiresAt: announcement.expires_at?.toISOString() ?? null,
        })),
        polls: polls.rows.map((poll) => ({
          id: poll.id,
          question: poll.question,
          deadline: poll.deadline.toISOString(),
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
