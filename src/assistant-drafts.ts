import type { AnnouncementDraft } from './announcements.js';
import type { BillDraft } from './bill-types.js';
import type { ChoreDraft } from './chores.js';
import type { ExpenseDraft } from './expense-types.js';
import type { MealDraft } from './meals.js';
import type { ShoppingDraft } from './shopping.js';
import type { Household, HouseholdMember } from './types.js';

export const actionKinds = [
  'meal',
  'announcement',
  'shopping',
  'chore',
  'expense',
  'bill',
] as const;
export type ActionKind = (typeof actionKinds)[number];

interface DraftBase {
  householdId: string;
  timezone: string;
  generatedAt: string;
  members: { id: string; displayName: string }[];
  recipientIds: string[];
  unresolvedFields: string[];
  notes: string[];
}
export type AssistantActionDraft = DraftBase &
  (
    | {
        kind: 'meal';
        fields: Pick<
          MealDraft,
          'mealType' | 'question' | 'startsAtLocal' | 'responseDeadlineLocal'
        >;
      }
    | {
        kind: 'announcement';
        fields: Pick<
          AnnouncementDraft,
          | 'title'
          | 'body'
          | 'priority'
          | 'requiresAcknowledgement'
          | 'expiresAtLocal'
        >;
      }
    | { kind: 'shopping'; fields: ShoppingDraft }
    | { kind: 'chore'; fields: ChoreDraft }
    | { kind: 'expense'; fields: ExpenseDraft }
    | { kind: 'bill'; fields: BillDraft }
  );

export function isActionRequest(message: string): boolean {
  return /^(?:(?:please|can you|could you|do not|don't|never)\s+)*(?:plan|create|schedule|organize|arrange|announce|announcement|post|publish|notify|send|delete|edit|split|add|buy|assign|tell everyone)\b/i.test(
    message.trim(),
  );
}

// Strict local command routing: private action requests never reach a provider.
export function actionCommand(
  message: string,
): { kind: ActionKind; text: string } | null {
  const text = message
    .trim()
    .replace(/^(?:(?:please|can you|could you)\s+)+/i, '');
  if (
    /\b(?:and|then|also)\s+(?:plan|create|announce|publish|delete|edit|send|schedule|add|buy|assign|split)\b/i.test(
      text,
    )
  )
    return null;
  if (/^(?:do not|don't|never)\b/i.test(text)) return null;
  const chore =
    /^(?:add|create|schedule|assign)\s+(?:a\s+)?(?:chore|task)\b\s*[:,-]?\s*(.*)$/is.exec(
      text,
    );
  if (chore) return { kind: 'chore', text: chore[1]?.trim() ?? '' };
  const shopping =
    /^(?:(?:add|create)\s+(?:(?:a\s+)?shopping(?:\s+item)?\b\s*[:,-]?\s*)|buy\s+)(.*)$/is.exec(
      text,
    ) ?? /^add\s+(.+?)\s+to (?:the )?shopping list[.!]?$/is.exec(text);
  if (shopping) return { kind: 'shopping', text: shopping[1]?.trim() ?? '' };
  const money =
    /^(?:add|create|record|split)\s+(?:(?:an?|the)\s+)?(expense|bill)\b\s*[:,-]?\s*(.*)$/is.exec(
      text,
    );
  if (money)
    return {
      kind: (money[1] ?? '').toLowerCase() as 'expense' | 'bill',
      text: money[2]?.trim() ?? '',
    };
  const announcement =
    /^(?:announce(?:ment)?|post (?:an? |the )?announcement|tell everyone|notify (?:everyone|the household))\b\s*[:,-]?\s*(?:that\s+)?(.*)$/is.exec(
      text,
    );
  if (announcement)
    return { kind: 'announcement', text: announcement[1]?.trim() ?? '' };
  const meal = /^(?:plan|create|schedule|organize|arrange)\s+(.*)$/is.exec(
    text,
  );
  if (meal && /\b(?:breakfast|lunch|dinner|meal)\b/i.test(meal[1] ?? ''))
    return { kind: 'meal', text: meal[1]?.trim() ?? '' };
  return null;
}

function localDay(now: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function addDays(day: string, count: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function mealTime(text: string, today: string): string {
  // More than one date/time, relative weeks, or a bare "7" requires clarification.
  const dates = [
    ...text.matchAll(
      /\b(?:\d{4}-\d{2}-\d{2}|today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    ),
  ];
  const times = [
    ...text.matchAll(
      /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi,
    ),
  ];
  if (
    dates.length !== 1 ||
    times.length !== 1 ||
    /\b(next|this)\s+(?:week|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(
      text,
    )
  )
    return '';
  // Do not silently ignore an extra numeric date, alternate time or recurrence.
  let remainder = text;
  for (const match of [...dates, ...times])
    remainder = remainder.replace(match[0], '');
  if (
    /\d|\b(?:not|instead|or|next|week|month|year|every|recurring)\b/i.test(
      remainder,
    )
  )
    return '';
  const dateToken = dates[0]?.[0].toLowerCase() ?? '';
  let day = today;
  if (dateToken === 'tomorrow') day = addDays(today, 1);
  else if (/^\d/.test(dateToken)) {
    const parsed = new Date(`${dateToken}T12:00:00Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== dateToken
    )
      return '';
    day = dateToken;
  } else if (!['today', 'tonight'].includes(dateToken)) {
    const weekday = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ].indexOf(dateToken);
    const delta =
      (weekday - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7;
    if (delta === 0) return ''; // Same weekday could mean today or next week.
    day = addDays(today, delta);
  }
  const time = times[0];
  if (!time) return '';
  let hour = Number(time[1] ?? time[4]);
  const minute = Number(time[2] ?? time[5] ?? '0');
  if (minute > 59) return '';
  if (dateToken === 'tonight' && hour === 12 && time[3]?.toLowerCase() === 'am')
    return '';
  if (time[3]) {
    if (hour < 1 || hour > 12) return '';
    hour = (hour % 12) + (time[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  return `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function prepareActionDraft(
  command: NonNullable<ReturnType<typeof actionCommand>>,
  household: Household,
  members: HouseholdMember[],
  now: Date,
): AssistantActionDraft {
  // Targeted requests require explicit audience selection; never silently broaden one.
  const targeted = /\b(?:only|except|exclude|with|for|to)\b/i.test(
    command.text,
  );
  const base: DraftBase = {
    householdId: household.id,
    timezone: household.timezone,
    generatedAt: now.toISOString(),
    members: members.map(({ id, displayName }) => ({ id, displayName })),
    recipientIds: targeted ? [] : members.map(({ id }) => id),
    unresolvedFields: targeted
      ? ['Choose the intended participants or recipients.']
      : [],
    notes: [
      'This draft stays in HouseMate. Nothing is published until you review and confirm.',
    ],
  };
  if (!targeted)
    base.notes.push(
      'The proposed audience is all current household members. Review it before publishing.',
    );
  if (
    command.kind === 'shopping' ||
    command.kind === 'chore' ||
    command.kind === 'expense' ||
    command.kind === 'bill'
  ) {
    base.recipientIds = [];
    base.unresolvedFields = [];
    base.notes = [
      'Unsaved draft. Review the original request and all proposed details before confirming.',
      `Original request: ${command.text}`,
    ];
    const title = command.text.slice(0, 160);
    if (!title.trim()) base.unresolvedFields.push('Enter a title.');
    if (command.kind === 'shopping') {
      base.unresolvedFields.push(
        'Check the item name, quantity, buyer and optional estimated price. One item is created per confirmation.',
      );
      return {
        ...base,
        kind: 'shopping',
        fields: {
          title,
          quantity: null,
          unit: null,
          note: null,
          priority: 'normal',
          assignedBuyerMemberId: null,
          estimatedPriceMinor: null,
        },
      };
    }
    if (command.kind === 'chore') {
      base.unresolvedFields.push(
        'Choose the intended assignee.',
        'Enter an exact future due date and time.',
      );
      return {
        ...base,
        kind: 'chore',
        fields: { title, note: null, dueAtLocal: '', assigneeMemberId: '' },
      };
    }
    // Only an unambiguous explicitly currency-marked total is extracted. No shares
    // or bill adjustments are inferred from a number/name in conversational text.
    const totals = [
      ...command.text.matchAll(
        /(?:\b(USD|THB)\s+(\d+(?:\.\d{1,2})?)\b|(?<![\d.+-])(\d+(?:\.\d{1,2})?)\s+(USD|THB)\b)/gi,
      ),
    ];
    const total = totals.length === 1 ? totals[0] : null;
    const amount = total ? Number(total[2] ?? total[3]) : 0;
    const currency = (total?.[1] ?? total?.[4])?.toUpperCase();
    const amountMinor =
      currency === household.defaultCurrency &&
      Number.isSafeInteger(Math.round(amount * 100)) &&
      amount > 0 &&
      !/[\d]|[-+]/.test(command.text.replace(total?.[0] ?? '', '')) &&
      amount <= 9999999999.99
        ? Math.round(amount * 100)
        : 0;
    base.unresolvedFields.push(
      'Choose the payer and the exact participants.',
      'Check the title and confirm the total and split details.',
    );
    if (!amountMinor)
      base.unresolvedFields.push(
        `Enter the total in ${household.defaultCurrency}; ambiguous amounts or another currency are not converted.`,
      );
    base.notes.push(
      'All final shares and rounding come from the API preview. This confirmation records money; it does not process a payment.',
    );
    if (command.kind === 'expense') {
      base.unresolvedFields.push(
        'Enter the expense date and choose the split method.',
      );
      return {
        ...base,
        kind: 'expense',
        fields: {
          title,
          amountMinor,
          currency: household.defaultCurrency,
          spentOn: '',
          payerMemberId: '',
          split: { method: 'equal', shares: [] },
        },
      };
    }
    base.unresolvedFields.push(
      'Enter the provider, billing period and due date.',
      'Review provider payment status and enter every individual/shared charge or credit explicitly.',
    );
    return {
      ...base,
      kind: 'bill',
      fields: {
        title,
        amountMinor,
        currency: household.defaultCurrency,
        billType: 'other',
        provider: '',
        periodStart: '',
        periodEnd: '',
        dueDate: '',
        payerMemberId: '',
        paymentStatus: 'unpaid',
        sharedParticipantIds: [],
        adjustments: [],
      },
    };
  }
  if (command.kind === 'announcement') {
    if (!command.text)
      base.unresolvedFields.push('What should the announcement say?');
    return {
      ...base,
      kind: 'announcement',
      fields: {
        title: command.text.split(/[\n.!?]/)[0]?.slice(0, 160) ?? '',
        body: command.text,
        priority: 'normal',
        requiresAcknowledgement: false,
        expiresAtLocal: null,
      },
    };
  }
  const mealType = /\b(breakfast|lunch|dinner)\b/i
    .exec(command.text)?.[1]
    ?.toLowerCase() as MealDraft['mealType'] | undefined;
  const startsAtLocal = mealTime(
    command.text,
    localDay(now, household.timezone),
  );
  if (!startsAtLocal)
    base.unresolvedFields.push(
      'What exact date and time should the meal start?',
    );
  else
    base.notes.push(
      `Proposed meal time: ${startsAtLocal.replace('T', ' ')} (${household.timezone}).`,
    );
  base.unresolvedFields.push(
    'When should responses close? Choose a future deadline before the meal.',
  );
  if (!mealType)
    base.notes.push(
      'Meal type is Other; choose breakfast, lunch or dinner if appropriate.',
    );
  return {
    ...base,
    kind: 'meal',
    fields: {
      mealType: mealType ?? 'other',
      question: `Who is joining ${command.text.replace(/\?$/, '')}?`.slice(
        0,
        240,
      ),
      startsAtLocal,
      responseDeadlineLocal: '',
    },
  };
}
