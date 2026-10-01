import type { AnnouncementDraft } from './announcements.js';
import type { MealDraft } from './meals.js';
import type { Household, HouseholdMember } from './types.js';

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
  );

export function isActionRequest(message: string): boolean {
  return /^(?:(?:please|can you|could you|do not|don't)\s+)*(?:plan|create|schedule|organize|arrange|announce|announcement|post|publish|notify|send|delete|edit|split|add|tell everyone)\b/i.test(
    message.trim(),
  );
}

// Strict local command routing: private action requests never reach a provider.
export function actionCommand(
  message: string,
): { kind: 'meal' | 'announcement'; text: string } | null {
  const text = message
    .trim()
    .replace(/^(?:(?:please|can you|could you)\s+)+/i, '');
  if (
    /\b(?:and|then|also)\s+(?:plan|create|announce|publish|delete|edit|send|schedule)\b/i.test(
      text,
    )
  )
    return null;
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
