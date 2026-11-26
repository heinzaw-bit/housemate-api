import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AnnouncementRepository } from './announcements.js';
import type { AssistantBudget } from './assistant-budget.js';
import {
  type ActionKind,
  actionCommand,
  actionKinds,
  isActionRequest,
  prepareActionDraft,
} from './assistant-drafts.js';
import {
  type AssistantIntent,
  type AssistantProvider,
  type AssistantTopic,
  assistantTopics,
  validateAssistantIntent,
} from './assistant-provider.js';
import type { ChoreRepository } from './chores.js';
import type { DashboardRepository } from './dashboard.js';
import { ApiError } from './errors.js';
import type { EventRepository } from './events.js';
import type { MealRepository } from './meals.js';
import type { ShoppingRepository } from './shopping.js';
import type { AuthenticatedUser, HouseholdRepository } from './types.js';

interface AssistantData {
  households: Pick<HouseholdRepository, 'get' | 'listMembers'>;
  dashboard: DashboardRepository;
  shopping: Pick<ShoppingRepository, 'list'>;
  chores: Pick<ChoreRepository, 'list'>;
  meals: Pick<MealRepository, 'list'>;
  events: Pick<EventRepository, 'list'>;
  announcements?: Pick<AnnouncementRepository, 'list'>;
}
interface Source {
  label: string;
  href: string;
}
export const assistantContextTopics = [
  'summary',
  'board',
  'balance',
  'bills',
  'announcements',
  'events',
] as const;
export type AssistantContextTopic = (typeof assistantContextTopics)[number];
export interface AssistantAnswer {
  kind: 'answer' | 'clarification';
  topic: AssistantIntent['topic'];
  text: string;
  generatedAt: string;
  timezone: string;
  rows: (Source & { detail: string })[];
  sources: Source[];
  partial: boolean;
  choices?: { label: string; topic: AssistantContextTopic }[];
}
export type AssistantQuestion =
  | { topic: AssistantTopic; message?: never }
  | {
      message: string;
      topic?: never;
      privacyAcknowledged?: true;
      context?: { topic: AssistantContextTopic };
    };

export class HouseholdAssistant {
  constructor(
    private readonly data: AssistantData,
    private readonly provider: AssistantProvider | null = null,
    private readonly budget: AssistantBudget | null = null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async access(userId: string, householdId: string) {
    const household = await this.data.households.get(userId, householdId);
    if (!household)
      throw new ApiError(404, 'NOT_FOUND', 'Household not found.');
    return household;
  }

  async config(userId: string, householdId: string) {
    await this.access(userId, householdId);
    const enabled = !!this.provider && !!this.budget;
    return {
      naturalLanguageEnabled: enabled,
      chatEnabled: true,
      actionDraftsEnabled: true,
      supportedDraftKinds: [...actionKinds],
      provider: enabled ? 'gemini' : null,
      requiresPrivacyAcknowledgement: true,
    };
  }

  async draft(
    userId: string,
    householdId: string,
    message: string,
    allowedKinds: ActionKind[] = ['meal', 'announcement'],
  ) {
    const household = await this.access(userId, householdId);
    const command = actionCommand(message);
    if (!command || !allowedKinds.includes(command.kind)) {
      if (isActionRequest(message))
        throw new ApiError(
          400,
          'ASSISTANT_ACTION_UNSUPPORTED',
          'Use one command at a time: “Plan dinner tomorrow at 7pm” or “Announce that dinner is ready.” Try “Add shopping eggs”, “Create chore clean the kitchen”, “Add expense dinner 500 THB” or “Create bill electricity”. Fill unresolved fields, review and confirm; deletes and edits still use the normal pages.',
        );
      return { draft: null };
    }
    const members = await this.data.households.listMembers(userId, householdId);
    await this.access(userId, householdId);
    return {
      draft: prepareActionDraft(command, household, members, this.clock()),
    };
  }

  async ask(
    userId: string,
    householdId: string,
    question: AssistantQuestion,
  ): Promise<AssistantAnswer> {
    const household = await this.access(userId, householdId);
    let intent: AssistantIntent;
    if (question.topic)
      intent = { topic: question.topic, memberName: null, scope: null };
    else {
      if (
        isActionRequest(question.message) &&
        !localIntent(question.message, question.context?.topic)
      )
        return {
          kind: 'clarification',
          topic: 'unsupported',
          text: 'I can help you understand records, but I cannot create or change them here. Use Board for announcements/events and Money for expenses, bills and transfers.',
          generatedAt: this.clock().toISOString(),
          timezone: household.timezone,
          rows: [],
          sources: [
            {
              label: 'Board',
              href: `/house?household=${encodeURIComponent(householdId)}`,
            },
            {
              label: 'Money',
              href: `/money?household=${encodeURIComponent(householdId)}`,
            },
          ],
          partial: false,
        };
      const message = question.message.trim();
      if (
        /\bweather\b|\bforecast\b|\btemperature (in|for|today|tomorrow|now)\b|\b(is it|will it be) (raining|snowing)\b/iu.test(
          message,
        )
      ) {
        return {
          kind: 'clarification',
          topic: 'unsupported',
          text: 'I don’t check weather. I can help with Board updates, your balance, bills and everyday questions.',
          generatedAt: this.clock().toISOString(),
          timezone: household.timezone,
          rows: [],
          sources: [],
          partial: false,
          choices: clarificationChoices(),
        };
      }
      const local = localIntent(message, question.context?.topic);
      if (local) intent = local;
      else {
        if (!this.provider || !this.budget)
          throw new ApiError(
            503,
            'ASSISTANT_SETUP_REQUIRED',
            'General questions are awaiting AI setup. You can still say hello, ask about HouseMate, check Board updates or your balance.',
          );
        if (question.privacyAcknowledged !== true)
          throw new ApiError(
            400,
            'ASSISTANT_PRIVACY_REQUIRED',
            'Acknowledge the Gemini sharing notice before asking a general question.',
          );
        const members = await this.data.households.listMembers(
          userId,
          householdId,
        );
        const names = members
          .flatMap((member) => [member.displayName, member.email])
          .filter((name): name is string => !!name?.trim());
        const mentionsMember = names.some((name) => {
          const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(
            `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
            'iu',
          ).test(message);
        });
        // A limited guard, not a complete personal-information detector. Consent
        // still requires members to keep unknown personal/confidential details out.
        if (
          mentionsMember ||
          /[\p{N}@]|https?:|www\.|\b(password|secret|api[ _-]?key|token)\b/iu.test(
            message,
          )
        )
          throw new ApiError(
            400,
            'ASSISTANT_PRIVATE_INPUT',
            'Keep names, amounts, contact details and secrets out of typed questions. Use a quick question or Money and Board for specific records.',
          );
        await this.access(userId, householdId);
        await this.budget.consume(userId);
        intent = validateAssistantIntent(await this.provider.classify(message));
      }
    }
    const source = (label: string, path: string): Source => ({
      label,
      href: `${path}${path.includes('?') ? '&' : '?'}household=${encodeURIComponent(householdId)}`,
    });
    const pages = {
      summary: source('Home', '/'),
      balance: source('Balances', '/money?view=balances'),
      bills: source('Bills', '/money?view=bills'),
      meals: source('Meals', '/house?view=meals'),
      chores: source('Chores', '/house?view=chores'),
      shopping: source('Shopping', '/house?view=shopping'),
      events: source('Events', '/house?view=events'),
      announcements: source('Announcements', '/house?view=announcements'),
      board: source('Board', '/house?view=announcements'),
    };
    const answer: AssistantAnswer = {
      kind: 'answer',
      topic: intent.topic,
      text: '',
      generatedAt: this.clock().toISOString(),
      timezone: household.timezone,
      rows: [],
      sources:
        intent.topic === 'unsupported'
          ? [pages.board, pages.balance, pages.bills]
          : intent.topic in pages
            ? [pages[intent.topic as AssistantTopic]]
            : [],
      partial: false,
    };
    const money = (minor: number) =>
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: household.defaultCurrency,
      }).format(minor / 100);
    const date = (iso: string) =>
      new Intl.DateTimeFormat('en', {
        timeZone: household.timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(iso));
    const localDay = (iso: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: household.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(iso));
    const today = localDay(answer.generatedAt);
    const balanceText = (netMinor: number) =>
      netMinor < 0
        ? `owe ${money(-netMinor)}`
        : netMinor > 0
          ? `are owed ${money(netMinor)}`
          : 'are settled up';
    const clarify = (text: string) => {
      answer.kind = 'clarification';
      answer.text = text;
      answer.choices = clarificationChoices();
    };
    switch (intent.topic) {
      case 'greeting':
        answer.text =
          'Hi! I’m HouseMate’s assistant. I can help you check Board updates, understand your balance, and answer everyday questions.';
        break;
      case 'about':
        answer.text =
          'I’m HouseMate’s assistant, your helper for shared living. Ask about Board announcements and events, Money bills and balances, or everyday questions. Create or change records in Board and Money.';
        break;
      case 'general':
        if (!intent.reply)
          throw new ApiError(
            503,
            'ASSISTANT_UNAVAILABLE',
            'The general answer could not be loaded. Try again later.',
          );
        answer.text = intent.reply.trim();
        break;
      case 'announcements': {
        if (!this.data.announcements)
          throw new ApiError(
            503,
            'ASSISTANT_UNAVAILABLE',
            'Announcements are temporarily unavailable. Open Board.',
          );
        const records = await this.data.announcements.list(
          userId,
          householdId,
          'all',
          50,
          0,
        );
        const active = records.filter((record) => !record.expired);
        answer.partial = records.length === 50 || active.length > 10;
        answer.text = active.length
          ? 'Here are the recent active announcements you can see. Open any announcement for its full message and acknowledgement.'
          : 'No active announcements were found in the checked records.';
        answer.rows = active.slice(0, 10).map((record) => ({
          ...source(
            record.title,
            `/house?view=announcements&announcement=${encodeURIComponent(record.id)}`,
          ),
          detail: `${record.body.slice(0, 400)}${record.body.length > 400 ? '…' : ''} · ${record.priority} · ${date(record.publishedAt)}${record.canAcknowledge ? ' · Acknowledgement needed' : ''}`,
        }));
        break;
      }
      case 'unsupported':
        clarify(
          'Would you like Board updates, your balance, or unpaid bills? Choose one below, or ask an everyday question. Use Board or Money to create or change records.',
        );
        break;
      case 'summary':
      case 'board': {
        if (!this.data.announcements)
          throw new ApiError(
            503,
            'ASSISTANT_UNAVAILABLE',
            'Board updates could not be checked. Open Board to view your records.',
          );
        const [notices, events, snapshot] = await Promise.all([
          this.data.announcements.list(userId, householdId, 'all', 50, 0),
          this.data.events.list(userId, householdId, 'upcoming', 50, 0),
          intent.topic === 'summary'
            ? this.data.dashboard.get(userId, householdId)
            : Promise.resolve(null),
        ]);
        const active = notices.filter(
          (record) =>
            !record.expired &&
            (intent.topic === 'board' || record.priority !== 'normal'),
        );
        const priority = { urgent: 0, important: 1, normal: 2 };
        active.sort(
          (a, b) =>
            priority[a.priority] - priority[b.priority] ||
            Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
        );
        events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        const due =
          snapshot?.pendingBills.items.filter(
            (bill) => bill.urgency !== 'upcoming',
          ) ?? [];
        const limit = intent.topic === 'board' ? 5 : 3;
        answer.sources =
          intent.topic === 'board'
            ? [pages.announcements, pages.events]
            : [pages.board, pages.bills];
        answer.rows = [
          ...active.slice(0, limit).map((record) => ({
            ...source(
              record.title,
              '/house?view=announcements&announcement=' +
                encodeURIComponent(record.id),
            ),
            detail:
              'Announcement · ' +
              record.priority +
              ' · ' +
              record.body.slice(0, 240) +
              (record.body.length > 240 ? '…' : '') +
              (record.canAcknowledge ? ' · Acknowledgement needed' : ''),
          })),
          ...events.slice(0, limit).map((event) => ({
            ...source(
              event.title,
              `/house?view=events&event=${encodeURIComponent(event.id)}`,
            ),
            detail:
              'Event · ' +
              date(event.startsAt) +
              ' · ' +
              event.counts.going +
              ' going · ' +
              event.counts.maybe +
              ' maybe',
          })),
          ...due.slice(0, 3).map((bill) => ({
            ...source(
              bill.title,
              `/money?view=bills&record=${encodeURIComponent(bill.id)}`,
            ),
            detail:
              'Bill · ' +
              money(bill.amountMinor) +
              ' · Due ' +
              bill.dueDate +
              ' · ' +
              bill.urgency.replaceAll('_', ' '),
          })),
        ];
        answer.partial =
          notices.length === 50 ||
          events.length === 50 ||
          active.length > limit ||
          events.length > limit ||
          due.length > 3 ||
          !!snapshot?.pendingBills.hasMore;
        answer.text = answer.rows.length
          ? intent.topic === 'board'
            ? 'Here are your latest Board announcements and upcoming events.'
            : 'Here are important announcements, upcoming events and bills due within seven days.'
          : intent.topic === 'board'
            ? 'No active announcements or upcoming events were found in the checked records.'
            : 'No important announcements, upcoming events or due bills were found in the checked records.';
        break;
      }
      case 'balance':
      case 'bills': {
        const snapshot = await this.data.dashboard.get(userId, householdId);
        answer.generatedAt = snapshot.generatedAt;
        const candidates =
          intent.memberName === null
            ? snapshot.balance.members.filter(
                (member) => member.memberId === snapshot.balance.viewerMemberId,
              )
            : snapshot.balance.members.filter(
                (member) =>
                  member.displayName.trim().toLocaleLowerCase('en') ===
                  intent.memberName?.trim().toLocaleLowerCase('en'),
              );
        const member = candidates.length === 1 ? candidates[0] : undefined;
        if (intent.topic === 'balance') {
          if (!member)
            clarify(
              candidates.length > 1
                ? 'More than one member has that name. Open Balances to select the correct member.'
                : 'I could not match that member exactly. Use their full display name or open Balances.',
            );
          else {
            const subject =
              intent.memberName === null ? 'You' : member.displayName;
            const amount = member.expectedNetMinor ?? member.netMinor;
            const includesUnpaid =
              member.expectedNetMinor !== undefined &&
              snapshot.balance.pendingBillCount > 0;
            const state =
              intent.memberName === null
                ? balanceText(amount)
                : amount < 0
                  ? `owes ${money(-amount)}`
                  : amount > 0
                    ? `is owed ${money(amount)}`
                    : 'is settled up';
            answer.text = includesUnpaid
              ? `${subject} ${state}. This balance includes unpaid bills using each bill’s planned payer.`
              : `${subject} ${state}. This balance uses confirmed household records. Unpaid provider bills are excluded. Recorded settlements describe transfers made outside HouseMate.`;
            answer.rows = [
              {
                ...pages.balance,
                label: member.displayName,
                detail: `${includesUnpaid ? 'Balance including unpaid bills' : 'Net balance'}: ${money(amount)}`,
              },
            ];
          }
        } else if (intent.topic === 'bills') {
          answer.text = `${snapshot.balance.pendingBillCount} unpaid provider bill${snapshot.balance.pendingBillCount === 1 ? '' : 's'}, totaling ${money(snapshot.balance.pendingBillAmountMinor)}. This is provider status, not each member’s payment status.`;
          answer.partial = snapshot.pendingBills.hasMore;
          answer.rows = snapshot.pendingBills.items.slice(0, 5).map((bill) => ({
            ...source(
              bill.title,
              `/money?view=bills&record=${encodeURIComponent(bill.id)}`,
            ),
            detail: `${money(bill.amountMinor)} · Due ${bill.dueDate} · ${bill.urgency.replaceAll('_', ' ')}`,
          }));
        }
        break;
      }
      case 'shopping': {
        const records = await this.data.shopping.list(
          userId,
          householdId,
          50,
          0,
        );
        const active = records.filter(
          (item) => item.status === 'needed' || item.status === 'assigned',
        );
        answer.partial = records.length === 50 || active.length > 10;
        answer.text = active.length
          ? 'Here are the open shopping items.'
          : 'No open shopping items were found.';
        answer.rows = active.slice(0, 10).map((item) => ({
          ...source(
            item.title,
            `/house?view=shopping&item=${encodeURIComponent(item.id)}`,
          ),
          detail: [
            item.quantity === null
              ? null
              : `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`,
            item.assignedBuyerDisplayName
              ? `Buyer: ${item.assignedBuyerDisplayName}`
              : 'Unassigned',
            `${item.priority} priority`,
          ]
            .filter(Boolean)
            .join(' · '),
        }));
        break;
      }
      case 'chores': {
        const records = await this.data.chores.list(userId, householdId, 50, 0);
        const active = records.filter(
          (chore) =>
            chore.status === 'open' &&
            (intent.scope !== 'upcoming' ||
              Date.parse(chore.dueAt) >= Date.parse(answer.generatedAt)) &&
            (intent.scope !== 'today' || localDay(chore.dueAt) === today),
        );
        answer.partial = records.length === 50 || active.length > 10;
        answer.text =
          intent.scope === 'today'
            ? `Open chores due today (${today}).`
            : intent.scope === 'upcoming'
              ? 'Here are the upcoming open chores.'
              : 'Here are the next open chores, including overdue work.';
        if (!active.length)
          answer.text += ' None were found in the checked records.';
        answer.rows = active.slice(0, 10).map((chore) => ({
          ...source(
            chore.title,
            `/house?view=chores&chore=${encodeURIComponent(chore.id)}`,
          ),
          detail: `${chore.assigneeDisplayName} · ${date(chore.dueAt)}${chore.dueAt < answer.generatedAt ? ' · Overdue' : ''}`,
        }));
        break;
      }
      case 'meals': {
        const records = await this.data.meals.list(
          userId,
          householdId,
          intent.scope === 'today' ? 'all' : 'upcoming',
          50,
          0,
        );
        const relevant = records.filter(
          (meal) =>
            intent.scope !== 'today' || localDay(meal.startsAt) === today,
        );
        answer.partial = records.length === 50 || relevant.length > 10;
        answer.text =
          intent.scope === 'today'
            ? `Meal checks for today (${today}).`
            : 'Here are the upcoming meal checks.';
        if (!relevant.length)
          answer.text += ' None were found in the checked records.';
        answer.rows = relevant.slice(0, 10).map((meal) => ({
          ...source(
            meal.question,
            `/house?view=meals&meal=${encodeURIComponent(meal.id)}`,
          ),
          detail: `${date(meal.startsAt)} · ${meal.counts.joining} joining · ${meal.cookingRoles.length ? meal.cookingRoles.map((role) => `${role.displayName}: ${role.role}`).join(', ') : 'No cooking roles assigned'}`,
        }));
        break;
      }
      case 'events': {
        const records = await this.data.events.list(
          userId,
          householdId,
          'upcoming',
          50,
          0,
        );
        const relevant = records.filter(
          (event) =>
            intent.scope !== 'today' || localDay(event.startsAt) === today,
        );
        answer.partial = records.length === 50 || relevant.length > 10;
        answer.text =
          intent.scope === 'today'
            ? `Upcoming events today (${today}).`
            : 'Here are the upcoming household events.';
        if (!relevant.length)
          answer.text += ' None were found in the checked records.';
        answer.rows = relevant.slice(0, 10).map((event) => ({
          ...source(
            event.title,
            `/house?view=events&event=${encodeURIComponent(event.id)}`,
          ),
          detail: `${date(event.startsAt)} · ${event.counts.going} going · ${event.counts.maybe} maybe`,
        }));
        break;
      }
    }
    // Membership could have been revoked while the provider or repositories ran.
    await this.access(userId, householdId);
    return answer;
  }
}

export function registerAssistantRoutes(
  app: FastifyInstance,
  requireUser: (request: FastifyRequest) => Promise<AuthenticatedUser>,
  assistant?: HouseholdAssistant,
) {
  const params = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  } as const;
  const service = () => {
    if (!assistant)
      throw new ApiError(
        503,
        'ASSISTANT_UNAVAILABLE',
        'The assistant is temporarily unavailable. Open the relevant household page.',
      );
    return assistant;
  };
  app.get<{ Params: { id: string } }>(
    '/v1/households/:id/assistant',
    { schema: { params } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const user = await requireUser(request);
      return service().config(user.id, request.params.id);
    },
  );
  app.post<{
    Params: { id: string };
    Body: { message: string; allowedKinds?: ActionKind[] };
  }>(
    '/v1/households/:id/assistant/drafts',
    {
      bodyLimit: 8192,
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['message'],
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 1000 },
            allowedKinds: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              uniqueItems: true,
              items: { type: 'string', enum: [...actionKinds] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const user = await requireUser(request);
      if (!request.body.message.trim())
        throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a request.');
      return service().draft(
        user.id,
        request.params.id,
        request.body.message,
        request.body.allowedKinds,
      );
    },
  );
  app.post<{ Params: { id: string }; Body: AssistantQuestion }>(
    '/v1/households/:id/assistant/questions',
    {
      bodyLimit: 8_192,
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topic: { type: 'string', enum: assistantTopics },
            message: { type: 'string', minLength: 1, maxLength: 1000 },
            context: {
              propertyNames: { enum: ['topic'] },
              type: 'object',
              additionalProperties: false,
              required: ['topic'],
              properties: {
                topic: { type: 'string', enum: assistantContextTopics },
              },
            },
            privacyAcknowledged: { type: 'boolean', const: true },
          },
          oneOf: [
            { required: ['topic'], not: { required: ['message'] } },
            { required: ['message'], not: { required: ['topic'] } },
          ],
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const user = await requireUser(request);
      if (
        typeof request.body.message === 'string' &&
        !request.body.message.trim()
      )
        throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a question.');
      return service().ask(user.id, request.params.id, request.body);
    },
  );
}

function clarificationChoices(): {
  label: string;
  topic: AssistantContextTopic;
}[] {
  return [
    { label: 'Board updates', topic: 'board' },
    { label: 'My balance', topic: 'balance' },
    { label: 'Unpaid bills', topic: 'bills' },
  ];
}
function localIntent(
  message: string,
  previousTopic?: AssistantContextTopic,
): AssistantIntent | null {
  const text = message
    .trim()
    .replace(/[!?.,]+$/u, '')
    .toLowerCase();
  const base = { memberName: null, scope: null } as const;
  if (
    /^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you)( housemate)?$/u.test(
      text,
    )
  )
    return { ...base, topic: 'greeting' };
  if (
    /^(who|what) (are you|is housemate)$|^what can you do$|^how does housemate work$/u.test(
      text,
    )
  )
    return { ...base, topic: 'about' };
  if (
    /^(board|board updates|what[’']?s (new|on the board)|show (me )?(the )?board( updates)?)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'board' };
  if (
    /^(catch me up|what needs attention|what needs my attention|household overview)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'summary' };
  if (
    /^(my balance|how much do i owe|what is my balance|what[’']?s my balance|what about my balance)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'balance' };
  if (
    /^(bills|unpaid bills|which bills are due|what about (the )?bills|show (me )?(the )?(unpaid )?bills)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'bills' };
  if (
    /^(events|upcoming events|what events are there|what about (the )?events|show (me )?(the )?(upcoming )?events)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'events' };
  if (
    /^(announcements?|what (announcements?|annuncements?) (are there|do we have)|show (me )?(the )?(latest |recent )?announcements?|what about (the )?announcements?|any announcements?)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'announcements' };
  if (
    /^(today|what about today|and today)$/u.test(text) &&
    ['board', 'events'].includes(previousTopic ?? '')
  )
    return { ...base, topic: 'events', scope: 'today' };
  if (
    /^(what updates|what do we have|what is due|what[’']?s due|today|what about today|and today)$/u.test(
      text,
    )
  )
    return { ...base, topic: 'unsupported' };
  return null;
}
