import type { Pool } from 'pg';
import { PgMoneyRepository } from './money.js';
import type { BalanceSummary } from './money-types.js';

export interface Dashboard {
  householdId: string;
  generatedAt: string;
  timezone: string;
  today: string;
  dueSoonDays: 7;
  balance: BalanceSummary;
  pendingBills: {
    overdueCount: number;
    dueSoonCount: number;
    items: {
      id: string;
      title: string;
      provider: string;
      dueDate: string;
      amountMinor: number;
      urgency: 'overdue' | 'due_soon' | 'upcoming';
    }[];
    hasMore: boolean;
  };
  nextMeal: {
    id: string;
    mealType: 'breakfast' | 'lunch' | 'dinner' | 'other';
    question: string;
    startsAt: string;
    responseDeadline: string;
    joiningCount: number;
    awaitingCount: number;
  } | null;
  shoppingOpenCount: number;
  chores: {
    openCount: number;
    overdueCount: number;
    nextDue: {
      id: string;
      title: string;
      dueAt: string;
      assigneeDisplayName: string;
    } | null;
  };
  recentActivity: {
    id: string;
    resourceType: 'expense' | 'bill' | 'settlement';
    resourceId: string;
    kind: 'created' | 'edited' | 'voided' | 'paid' | 'unpaid' | 'recorded';
    title: string;
    occurredAt: string;
    actorDisplayName: string;
  }[];
}

export interface DashboardRepository {
  get(authUserId: string, householdId: string): Promise<Dashboard>;
}

export class PgDashboardRepository implements DashboardRepository {
  constructor(private readonly pool: Pool) {}

  async get(authUserId: string, householdId: string): Promise<Dashboard> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Reuse the authoritative money calculation and its active membership check.
      const balance = await new PgMoneyRepository(this.pool).balances(
        authUserId,
        householdId,
        client,
      );
      const clock = await client.query<{
        timezone: string;
        today: string;
        soon: string;
        generated_at: Date;
      }>(
        `SELECT timezone, (now() AT TIME ZONE timezone)::date::text AS today,
          ((now() AT TIME ZONE timezone)::date + 7)::text AS soon,
          now() AS generated_at FROM housemate.households WHERE id = $1`,
        [householdId],
      );
      const time = clock.rows[0];
      if (!time) throw new Error('Missing authorized household');
      const counts = await client.query<{ overdue: string; soon: string }>(
        `SELECT count(*) FILTER (WHERE due_date < $2::date)::text AS overdue,
          count(*) FILTER (WHERE due_date BETWEEN $2::date AND $3::date)::text AS soon
         FROM housemate.bills WHERE household_id = $1
           AND payment_status = 'unpaid' AND voided_at IS NULL`,
        [householdId, time.today, time.soon],
      );
      const bills = await client.query<{
        id: string;
        title: string;
        provider: string;
        due_date: string;
        amount_minor: string;
      }>(
        `SELECT id, title, provider, due_date::text, amount_minor::text
         FROM housemate.bills WHERE household_id = $1
           AND payment_status = 'unpaid' AND voided_at IS NULL
         ORDER BY due_date ASC, id ASC LIMIT 5`,
        [householdId],
      );
      const nextMeal = await client.query<{
        id: string;
        meal_type: Dashboard['nextMeal'] extends { mealType: infer T }
          ? T
          : never;
        question: string;
        starts_at: Date;
        response_deadline: Date;
        joining_count: string;
        awaiting_count: string;
      }>(
        `SELECT mc.id, mc.meal_type, mc.question, mc.starts_at, mc.response_deadline,
          count(mp.member_id) FILTER (WHERE mp.response = 'joining')::text AS joining_count,
          count(mp.member_id) FILTER (WHERE mp.response IS NULL)::text AS awaiting_count
         FROM housemate.meal_checks mc
         LEFT JOIN housemate.meal_participants mp ON mp.meal_id = mc.id
         WHERE mc.household_id = $1 AND mc.starts_at >= now()
         GROUP BY mc.id ORDER BY mc.starts_at ASC, mc.id ASC LIMIT 1`,
        [householdId],
      );
      const shopping = await client.query<{ open_count: string }>(
        `SELECT count(*)::text AS open_count FROM housemate.shopping_items
         WHERE household_id = $1 AND status IN ('needed', 'assigned')`,
        [householdId],
      );
      const choreCounts = await client.query<{
        open_count: string;
        overdue_count: string;
      }>(
        `SELECT count(*)::text AS open_count,
          count(*) FILTER (WHERE due_at < now())::text AS overdue_count
         FROM housemate.chores WHERE household_id = $1 AND status = 'open'`,
        [householdId],
      );
      const nextChore = await client.query<{
        id: string;
        title: string;
        due_at: Date;
        assignee_display_name: string;
      }>(
        `SELECT c.id, c.title, c.due_at, u.display_name AS assignee_display_name
         FROM housemate.chores c
         JOIN housemate.household_members m ON m.id = c.assignee_member_id
         JOIN housemate.users u ON u.id = m.user_id
         WHERE c.household_id = $1 AND c.status = 'open'
         ORDER BY c.due_at ASC, c.id ASC LIMIT 1`,
        [householdId],
      );
      const activity = await client.query<{
        id: string;
        resource_type: Dashboard['recentActivity'][number]['resourceType'];
        resource_id: string;
        kind: Dashboard['recentActivity'][number]['kind'];
        title: string;
        occurred_at: Date;
        actor_display_name: string;
      }>(
        `WITH events AS (
          SELECT 'expense:' || e.id AS id, 'expense'::text AS resource_type,
            e.id AS resource_id, 'created'::text AS kind, e.title,
            e.created_at AS occurred_at, e.created_by_user_id AS actor_id
          FROM housemate.expenses e WHERE e.household_id = $1
          UNION ALL
          SELECT 'bill:' || b.id, 'bill', b.id, 'created', b.title,
            b.created_at, b.created_by_user_id
          FROM housemate.bills b WHERE b.household_id = $1
          UNION ALL
          SELECT 'edit:' || f.id, f.resource_type, f.resource_id,
            CASE WHEN f.action = 'void' THEN 'voided' ELSE 'edited' END,
            COALESCE(e.title, b.title), f.changed_at, f.changed_by_user_id
          FROM housemate.financial_edit_events f
          LEFT JOIN housemate.expenses e ON f.resource_type = 'expense'
            AND e.id = f.resource_id AND e.household_id = f.household_id
          LEFT JOIN housemate.bills b ON f.resource_type = 'bill'
            AND b.id = f.resource_id AND b.household_id = f.household_id
          WHERE f.household_id = $1 AND (e.id IS NOT NULL OR b.id IS NOT NULL)
          UNION ALL
          SELECT 'status:' || s.id, 'bill', b.id, s.new_status, b.title,
            s.changed_at, s.changed_by_user_id
          FROM housemate.bill_status_events s
          JOIN housemate.bills b ON b.id = s.bill_id
          WHERE b.household_id = $1 AND s.old_status IS NOT NULL
          UNION ALL
          SELECT 'settlement:' || s.id, 'settlement', s.id, 'recorded',
            'Manual transfer', s.created_at, s.recorded_by_user_id
          FROM housemate.settlements s WHERE s.household_id = $1
        ) SELECT events.*, u.display_name AS actor_display_name
          FROM events JOIN housemate.users u ON u.id = events.actor_id
          ORDER BY occurred_at DESC, id DESC LIMIT 10`,
        [householdId],
      );
      await client.query('COMMIT');
      return {
        householdId,
        generatedAt: time.generated_at.toISOString(),
        timezone: time.timezone,
        today: time.today,
        dueSoonDays: 7,
        balance,
        pendingBills: {
          overdueCount: Number(counts.rows[0]?.overdue ?? 0),
          dueSoonCount: Number(counts.rows[0]?.soon ?? 0),
          hasMore: balance.pendingBillCount > bills.rows.length,
          items: bills.rows.map((bill) => ({
            id: bill.id,
            title: bill.title,
            provider: bill.provider,
            dueDate: bill.due_date,
            amountMinor: Number(bill.amount_minor),
            urgency:
              bill.due_date < time.today
                ? 'overdue'
                : bill.due_date <= time.soon
                  ? 'due_soon'
                  : 'upcoming',
          })),
        },
        nextMeal: nextMeal.rows[0]
          ? {
              id: nextMeal.rows[0].id,
              mealType: nextMeal.rows[0].meal_type,
              question: nextMeal.rows[0].question,
              startsAt: nextMeal.rows[0].starts_at.toISOString(),
              responseDeadline:
                nextMeal.rows[0].response_deadline.toISOString(),
              joiningCount: Number(nextMeal.rows[0].joining_count),
              awaitingCount: Number(nextMeal.rows[0].awaiting_count),
            }
          : null,
        shoppingOpenCount: Number(shopping.rows[0]?.open_count ?? 0),
        chores: {
          openCount: Number(choreCounts.rows[0]?.open_count ?? 0),
          overdueCount: Number(choreCounts.rows[0]?.overdue_count ?? 0),
          nextDue: nextChore.rows[0]
            ? {
                id: nextChore.rows[0].id,
                title: nextChore.rows[0].title,
                dueAt: nextChore.rows[0].due_at.toISOString(),
                assigneeDisplayName: nextChore.rows[0].assignee_display_name,
              }
            : null,
        },
        recentActivity: activity.rows.map((event) => ({
          id: event.id,
          resourceType: event.resource_type,
          resourceId: event.resource_id,
          kind: event.kind,
          title: event.title,
          occurredAt: event.occurred_at.toISOString(),
          actorDisplayName: event.actor_display_name,
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
