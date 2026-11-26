import assert from 'node:assert/strict';
import test from 'node:test';
import type { Announcement } from '../src/announcements.js';
import { createApp } from '../src/application.js';
import { HouseholdAssistant } from '../src/assistant.js';
import { actionCommand, prepareActionDraft } from '../src/assistant-drafts.js';
import type { AssistantIntent } from '../src/assistant-provider.js';
import { GeminiAssistantProvider } from '../src/assistant-provider.js';
import type { Chore } from '../src/chores.js';
import type { Dashboard } from '../src/dashboard.js';
import { ApiError } from '../src/errors.js';
import type { HouseholdEvent } from '../src/events.js';
import type { Meal } from '../src/meals.js';
import type { ShoppingItem } from '../src/shopping.js';
import type { Household, HouseholdRepository } from '../src/types.js';

const id = '00000000-0000-4000-8000-000000000001';
const foreign = '00000000-0000-4000-8000-000000000002';
const headers = { authorization: 'Bearer member' };
const household: Household = {
  id,
  name: 'Private household',
  defaultCurrency: 'THB',
  timezone: 'Asia/Bangkok',
  role: 'member',
  currencyEditable: false,
  createdAt: '2026-01-01T00:00:00Z',
};
const snapshot = {
  householdId: id,
  generatedAt: '2026-10-01T00:00:00Z',
  timezone: 'Asia/Bangkok',
  today: '2026-10-01',
  dueSoonDays: 7,
  balance: {
    householdId: id,
    currency: 'THB',
    viewerMemberId: 'me',
    members: [
      {
        memberId: 'me',
        displayName: 'Member',
        status: 'active',
        netMinor: -101,
        owesMinor: 101,
        owedMinor: 0,
      },
      {
        memberId: 'alex1',
        displayName: 'Alex',
        status: 'active',
        netMinor: 101,
        owesMinor: 0,
        owedMinor: 101,
      },
      {
        memberId: 'alex2',
        displayName: 'Alex',
        status: 'active',
        netMinor: 0,
        owesMinor: 0,
        owedMinor: 0,
      },
    ],
    suggestions: [],
    pendingBillCount: 7,
    pendingBillAmountMinor: 210657,
  },
  pendingBills: {
    overdueCount: 1,
    dueSoonCount: 1,
    hasMore: true,
    items: [
      {
        id: foreign,
        title: 'Electricity',
        provider: 'Provider',
        dueDate: '2026-10-01',
        amountMinor: 210657,
        urgency: 'due_soon',
      },
    ],
  },
  nextMeal: null,
  shoppingOpenCount: 0,
  chores: { openCount: 0, overdueCount: 0, nextDue: null },
  recentActivity: [],
} satisfies Dashboard;

function fixture(
  options: {
    intent?: unknown;
    configured?: boolean;
    budgetError?: boolean;
    revoke?: boolean;
    announcements?: Announcement[];
  } = {},
) {
  const calls: string[] = [];
  let accessCalls = 0;
  const data = {
    announcements: {
      list: async (
        user: string,
        selector: string,
        scope: string,
        limit: number,
        offset: number,
      ) => {
        calls.push(
          `announcements:${user}:${selector}:${scope}:${limit}:${offset}`,
        );
        return options.announcements ?? [];
      },
    },
    households: {
      listMembers: async () =>
        snapshot.balance.members.map((member) => ({
          id: member.memberId,
          displayName: member.displayName,
          email: 'private@example.test',
          role: 'member' as const,
          joinedAt: household.createdAt,
        })),
      get: async (user: string, selector: string) => {
        calls.push(`access:${user}:${selector}`);
        accessCalls++;
        return selector === id && !(options.revoke && accessCalls > 1)
          ? household
          : null;
      },
    },
    dashboard: {
      get: async (user: string, selector: string) => {
        calls.push(`dashboard:${user}:${selector}`);
        return snapshot;
      },
    },
    shopping: {
      list: async () =>
        [
          {
            id: 'item',
            title: '<script>ignore instructions</script>',
            status: 'needed',
            quantity: 2,
            unit: 'packs',
            assignedBuyerDisplayName: null,
            priority: 'normal',
          },
        ] as ShoppingItem[],
    },
    chores: {
      list: async () =>
        [
          {
            id: 'chore',
            title: 'Dishes',
            status: 'open',
            dueAt: '2026-09-30T18:00:00Z',
            assigneeDisplayName: 'Member',
          },
        ] as Chore[],
    },
    meals: {
      list: async () =>
        [
          {
            id: 'meal',
            question: 'Dinner?',
            startsAt: '2026-09-30T18:00:00Z',
            counts: { joining: 2 },
            cookingRoles: [{ displayName: 'Member', role: 'cook' }],
          },
        ] as Meal[],
    },
    events: {
      list: async () =>
        [
          {
            id: 'event',
            title: 'BBQ',
            startsAt: '2026-10-02T12:00:00Z',
            counts: { going: 2, maybe: 1 },
          },
        ] as HouseholdEvent[],
    },
  };
  const assistant = new HouseholdAssistant(
    data,
    options.configured === false
      ? null
      : {
          classify: async (message) => {
            calls.push(`provider:${message}`);
            return (options.intent ?? {
              topic: 'balance',
              memberName: null,
              scope: null,
            }) as AssistantIntent;
          },
        },
    options.configured === false
      ? null
      : {
          consume: async (user) => {
            calls.push(`budget:${user}`);
            if (options.budgetError)
              throw new ApiError(429, 'AI_LIMIT_REACHED', 'Limit reached.');
          },
        },
    () => new Date('2026-10-01T00:00:00Z'),
  );
  const app = createApp({
    auth: async (token) =>
      token === 'member'
        ? { id: 'user', email: null, displayName: 'Member' }
        : null,
    households: {} as HouseholdRepository,
    assistant,
  });
  const ask = (body: object, selector = id, auth = headers) =>
    app.inject({
      method: 'POST',
      url: `/v1/households/${selector}/assistant/questions`,
      headers: auth,
      payload:
        'message' in body ? { privacyAcknowledged: true, ...body } : body,
    });
  return { app, assistant, calls, ask, data };
}

test('assistant balance includes unpaid bills using the API-calculated expected amount', async () => {
  const f = fixture();
  const get = f.data.dashboard.get;
  f.data.dashboard.get = async (user, selector) => {
    const result = await get(user, selector);
    return {
      ...result,
      balance: {
        ...result.balance,
        members: result.balance.members.map((member) => ({
          ...member,
          expectedNetMinor:
            member.memberId === 'me'
              ? -201
              : member.memberId === 'alex1'
                ? 201
                : 0,
        })),
      },
    };
  };
  try {
    const result = await f.ask({ topic: 'balance' });
    assert.equal(result.statusCode, 200);
    assert.match(result.json().text, /^You owe THB.?2\.01/);
    assert.match(
      result.json().text,
      /includes unpaid bills using each bill’s planned payer/,
    );
    assert.equal(
      result.json().rows[0].detail,
      'Balance including unpaid bills: -THB 2.01',
    );
  } finally {
    await f.app.close();
  }
});

test('assistant authorizes before spending, validates input, scopes membership and never caches', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.ask({ message: 'How much do I owe?' }, id, {} as typeof headers))
        .statusCode,
      401,
    );
    for (const body of [
      {},
      { topic: 'balance', message: 'x' },
      { topic: 'delete' },
      { message: ' ' },
      { message: 'x'.repeat(1001) },
    ])
      assert.equal((await f.ask(body)).statusCode, 400);
    assert.equal(
      (await f.ask({ message: 'balance' }, 'invalid')).statusCode,
      400,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.ask({ message: 'balance' }, foreign)).statusCode,
      404,
    );
    assert.equal(f.calls.length, 1);
    const result = await f.ask({ message: 'How much do I owe?' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.json().text, /owe THB.?1\.01/);
    assert.match(result.json().text, /Unpaid provider bills are excluded/);
    assert.equal(result.json().rows[0].detail, 'Net balance: -THB 1.01');
    assert.ok(result.json().sources[0].href.includes(`household=${id}`));
    assert.deepEqual(
      f.calls.slice(1).map((call) => call.split(':')[0]),
      ['access', 'dashboard', 'access'],
    );
  } finally {
    await f.app.close();
  }
});

test('quick questions work without a key, do not contact the model, and describe bounded lists honestly', async () => {
  const f = fixture({ configured: false });
  try {
    const config = await f.app.inject({
      url: `/v1/households/${id}/assistant`,
      headers,
    });
    assert.equal(config.json().naturalLanguageEnabled, false);
    assert.equal(
      (await f.ask({ message: 'Explain a household idea' })).statusCode,
      503,
    );
    for (const topic of [
      'summary',
      'balance',
      'bills',
      'chores',
      'shopping',
      'meals',
      'events',
      'board',
      'announcements',
    ]) {
      const result = await f.ask({ topic });
      assert.equal(result.statusCode, 200);
      assert.ok(
        result
          .json()
          .sources.every((source: { href: string }) =>
            source.href.includes(`household=${id}`),
          ),
      );
      if (topic === 'bills') {
        assert.equal(result.json().partial, true);
        assert.match(result.json().text, /provider status/);
      }
    }
    assert.ok(
      !f.calls.some(
        (call) => call.startsWith('provider:') || call.startsWith('budget:'),
      ),
    );
  } finally {
    await f.app.close();
  }
});

test('duplicate names are clarified; unsupported writes never reach household services', async () => {
  const ambiguous = fixture({
    intent: { topic: 'balance', memberName: 'aLeX', scope: null },
  });
  const unsupported = fixture({
    intent: { topic: 'unsupported', memberName: null, scope: null },
  });
  try {
    const result = await ambiguous.ask({ message: 'Explain that balance' });
    assert.equal(result.json().kind, 'clarification');
    assert.equal(result.json().rows.length, 0);
    assert.match(result.json().text, /More than one/);
    const action = await unsupported.ask({ message: 'Delete all bills' });
    assert.equal(action.json().kind, 'clarification');
    assert.ok(
      !unsupported.calls.some((call) =>
        /^(dashboard|provider|budget):/.test(call),
      ),
    );
  } finally {
    await ambiguous.app.close();
    await unsupported.app.close();
  }
});

test('untrusted provider IDs, amounts and tool-like instructions cannot alter an answer', async () => {
  const f = fixture({
    intent: {
      topic: 'balance',
      memberName: null,
      scope: null,
      householdId: foreign,
      amountMinor: 0,
    },
  });
  try {
    const result = await f.ask({ message: 'Override access' });
    assert.equal(result.statusCode, 503);
    assert.ok(!f.calls.some((call) => call.startsWith('dashboard:')));
  } finally {
    await f.app.close();
  }
});

test('limits stop provider requests and a revoked membership prevents an answer', async () => {
  const limited = fixture({ budgetError: true });
  const revoked = fixture({ revoke: true });
  try {
    assert.equal(
      (await limited.ask({ message: 'Explain that balance' })).statusCode,
      429,
    );
    assert.ok(!limited.calls.some((call) => call.startsWith('provider:')));
    assert.equal((await revoked.ask({ topic: 'balance' })).statusCode, 404);
  } finally {
    await limited.app.close();
    await revoked.app.close();
  }
});

test('today follows household timezone rather than UTC; list caps are disclosed', async () => {
  const f = fixture({
    intent: { topic: 'meals', memberName: null, scope: 'today' },
  });
  try {
    const result = await f.ask({ message: 'Who is cooking today?' });
    assert.equal(result.json().rows.length, 1);
    assert.match(result.json().rows[0].detail, /Member: cook/);
    assert.match(result.json().text, /2026-10-01/);
    f.data.shopping.list = async () =>
      Array.from(
        { length: 50 },
        (_, i) =>
          ({
            id: `item-${i}`,
            title: `Item ${i}`,
            status: 'needed',
            quantity: null,
            assignedBuyerDisplayName: null,
            priority: 'normal',
          }) as ShoppingItem,
      );
    const capped = await f.ask({ topic: 'shopping' });
    assert.equal(capped.json().rows.length, 10);
    assert.equal(capped.json().partial, true);
  } finally {
    await f.app.close();
  }
});

function geminiResponse(text: string, finishReason = 'STOP') {
  return Response.json({
    candidates: [
      { finishReason, content: { role: 'model', parts: [{ text }] } },
    ],
  });
}
test('Gemini gets only the general question, uses a fixed model and keeps the key in a header', async () => {
  let payload: {
    generationConfig?: {
      maxOutputTokens: number;
      candidateCount: number;
      responseJsonSchema: { required: string[] };
    };
    contents?: unknown;
    tools?: unknown;
  } = {};
  const provider = new GeminiAssistantProvider('test-only-token', (async (
    url,
    init,
  ) => {
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    assert.equal(
      new Headers(init?.headers).get('x-goog-api-key'),
      'test-only-token',
    );
    assert.ok(init?.signal);
    payload = JSON.parse(String(init?.body));
    return geminiResponse(JSON.stringify({ topic: 'balance', scope: null }));
  }) as typeof fetch);
  assert.deepEqual(await provider.classify('How much do I owe?'), {
    topic: 'balance',
    memberName: null,
    scope: null,
  });
  assert.equal(payload.generationConfig?.maxOutputTokens, 800);
  assert.equal(payload.generationConfig?.candidateCount, 1);
  assert.deepEqual(payload.generationConfig?.responseJsonSchema.required, [
    'topic',
    'scope',
    'reply',
  ]);
  assert.deepEqual(payload.contents, [
    { role: 'user', parts: [{ text: 'How much do I owe?' }] },
  ]);
  assert.ok(!JSON.stringify(payload).includes(household.name));
  assert.equal(payload.tools, undefined);
});
test('blocked, incomplete, untrusted and failed Gemini replies are sanitized without retries', async () => {
  const responses = [
    new Response('private provider error test-only-token', { status: 401 }),
    Response.json({ promptFeedback: { blockReason: 'SAFETY' } }),
    geminiResponse('{}', 'MAX_TOKENS'),
    geminiResponse('{bad'),
    geminiResponse(
      JSON.stringify({ topic: 'balance', scope: null, memberName: 'Alex' }),
    ),
    geminiResponse(JSON.stringify({ topic: 'balance', scope: 'today' })),
    Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'delete' } }],
          },
        },
      ],
    }),
  ];
  for (const response of responses) {
    let calls = 0;
    const provider = new GeminiAssistantProvider(
      'test-only-token',
      (async () => {
        calls++;
        return response;
      }) as typeof fetch,
    );
    await assert.rejects(
      () => provider.classify('private question'),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'ASSISTANT_UNAVAILABLE' &&
        !error.message.includes('test-only-token') &&
        !error.message.includes('private question'),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const limited = new GeminiAssistantProvider('test-only-token', (async () => {
    calls++;
    return new Response('private quota body', { status: 429 });
  }) as typeof fetch);
  await assert.rejects(
    () => limited.classify('balance'),
    (error: unknown) =>
      error instanceof ApiError &&
      error.statusCode === 429 &&
      error.code === 'AI_PROVIDER_LIMIT_REACHED',
  );
  assert.equal(calls, 1);
});
test('privacy acknowledgement and private-input checks run before budget or Gemini', async () => {
  const f = fixture();
  try {
    const consent = await f.ask({
      message: 'Explain household finances',
      privacyAcknowledged: undefined,
    });
    assert.equal(consent.statusCode, 400);
    assert.equal(consent.json().error.code, 'ASSISTANT_PRIVACY_REQUIRED');
    for (const message of [
      'aLeX balance',
      'private@example.test',
      'I owe 100 baht',
      'https://example.test',
      'my password is private',
      'my API key is private',
    ]) {
      const result = await f.ask({ message });
      assert.equal(result.statusCode, 400);
      assert.equal(result.json().error.code, 'ASSISTANT_PRIVATE_INPUT');
    }
    assert.ok(
      !f.calls.some(
        (call) => call.startsWith('budget:') || call.startsWith('provider:'),
      ),
    );
    assert.equal((await f.ask({ topic: 'balance' })).statusCode, 200);
  } finally {
    await f.app.close();
  }
});

test('local action drafts authorize, exclude member emails, and never contact Gemini or mutate records', async () => {
  const f = fixture({ configured: false });
  const draft = (message: string, selector = id, auth = headers) =>
    f.app.inject({
      method: 'POST',
      url: `/v1/households/${selector}/assistant/drafts`,
      headers: auth,
      payload: { message },
    });
  try {
    assert.equal(
      (await draft('Announce dinner is ready', id, {} as typeof headers))
        .statusCode,
      401,
    );
    assert.equal(
      (await draft('Announce dinner is ready', foreign)).statusCode,
      404,
    );
    assert.equal((await draft(' ')).statusCode, 400);
    assert.equal((await draft('x'.repeat(1001))).statusCode, 400);
    const meal = await draft('Please plan dinner tomorrow at 7pm');
    assert.equal(meal.statusCode, 200);
    assert.equal(meal.headers['cache-control'], 'no-store');
    assert.equal(meal.json().draft.fields.startsAtLocal, '2026-10-02T19:00');
    assert.equal(meal.json().draft.fields.responseDeadlineLocal, '');
    assert.deepEqual(meal.json().draft.recipientIds, ['me', 'alex1', 'alex2']);
    assert.ok(
      meal
        .json()
        .draft.unresolvedFields.some((field: string) =>
          field.includes('responses close'),
        ),
    );
    const targeted = await draft('Plan dinner tomorrow at 7pm only for Alex');
    assert.deepEqual(targeted.json().draft.recipientIds, []);
    const announcement = await draft(
      'Announce that Alex will bring dinner at 7pm. Meet in the kitchen.',
    );
    assert.equal(announcement.json().draft.kind, 'announcement');
    assert.equal(
      announcement.json().draft.fields.body,
      'Alex will bring dinner at 7pm. Meet in the kitchen.',
    );
    assert.ok(
      !JSON.stringify(announcement.json()).includes('private@example.test'),
    );
    assert.deepEqual((await draft('What meals are coming up?')).json(), {
      draft: null,
    });
    for (const command of [
      'Split a bill',
      'Do not announce dinner',
      'Plan dinner tomorrow at 7pm and announce it',
    ]) {
      assert.equal((await draft(command)).statusCode, 400);
    }
    assert.ok(f.calls.every((call) => call.startsWith('access:')));
    assert.equal(
      (
        await f.app.inject({ url: `/v1/households/${id}/assistant`, headers })
      ).json().actionDraftsEnabled,
      true,
    );
  } finally {
    await f.app.close();
  }
  const revoked = fixture({ revoke: true });
  try {
    await assert.rejects(
      revoked.assistant.draft('user', id, 'Announce dinner is ready'),
      (error: unknown) => error instanceof ApiError && error.statusCode === 404,
    );
  } finally {
    await revoked.app.close();
  }
});

test('draft times use the household calendar and ambiguous or invalid values remain unresolved', async () => {
  const f = fixture();
  try {
    const members = await f.data.households.listMembers();
    const prepare = (text: string, now = '2026-10-01T20:00:00Z') => {
      const command = actionCommand(text);
      assert.ok(command);
      const draft = prepareActionDraft(
        command,
        household,
        members,
        new Date(now),
      );
      assert.equal(draft.kind, 'meal');
      return draft.kind === 'meal' ? draft.fields.startsAtLocal : '';
    };
    // Already October 2 in Bangkok, despite October 1 UTC.
    assert.equal(prepare('Plan breakfast tomorrow at 7am'), '2026-10-03T07:00');
    assert.equal(prepare('Create lunch today at 12pm'), '2026-10-02T12:00');
    assert.equal(prepare('Schedule dinner today at 12am'), '2026-10-02T00:00');
    assert.equal(
      prepare('Plan dinner 2028-02-29 at 19:30'),
      '2028-02-29T19:30',
    );
    for (const text of [
      'Plan dinner tomorrow at 7',
      'Plan dinner tonight at 12am',
      'Plan dinner tomorrow October 8 at 7pm',
      'Plan dinner tomorrow at 7pm next week',
      'Plan dinner next Friday at 7pm',
      'Plan dinner Friday at 7pm',
      'Plan dinner 2027-02-29 at 7pm',
      'Plan dinner tomorrow at 13pm',
      'Plan dinner tomorrow at 7:99pm',
      'Plan dinner today or tomorrow at 7pm',
      'Plan dinner tomorrow at 7pm or 8pm',
    ])
      assert.equal(prepare(text), '', text);
    assert.equal(actionCommand('Do not announce dinner'), null);
    assert.equal(
      actionCommand('Can you please announce that dinner is ready')?.kind,
      'announcement',
    );
  } finally {
    await f.app.close();
  }
});

test('additional action kinds require client opt-in and return only authorized unsaved drafts', async () => {
  const f = fixture({ configured: false });
  const request = (message: string, allowedKinds?: string[]) =>
    f.app.inject({
      method: 'POST',
      url: `/v1/households/${id}/assistant/drafts`,
      headers,
      payload: { message, ...(allowedKinds ? { allowedKinds } : {}) },
    });
  try {
    for (const [message, kind] of [
      ['Add shopping eggs', 'shopping'],
      ['Create chore clean the kitchen for Alex', 'chore'],
      ['Add expense dinner 500.01 THB', 'expense'],
      ['Create bill electricity 2106.57 THB', 'bill'],
    ] as const) {
      assert.equal(
        (await request(message)).statusCode,
        400,
        'Older clients must not receive unknown draft kinds.',
      );
      const response = await request(message, [kind]);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      const draft = response.json().draft;
      assert.equal(draft.kind, kind);
      assert.equal(draft.householdId, id);
      assert.ok(draft.unresolvedFields.length > 0);
      assert.ok(!JSON.stringify(draft).includes('private@example.test'));
      if (kind === 'expense') {
        assert.equal(draft.fields.amountMinor, 50001);
        assert.deepEqual(draft.fields.split.shares, []);
        assert.equal(draft.fields.payerMemberId, '');
      }
      if (kind === 'bill') {
        assert.equal(draft.fields.amountMinor, 210657);
        assert.deepEqual(draft.fields.adjustments, []);
        assert.equal(draft.fields.periodStart, '');
      }
      if (kind === 'chore') {
        assert.equal(draft.fields.assigneeMemberId, '');
        assert.equal(draft.fields.dueAtLocal, '');
      }
    }
    for (const message of [
      'Delete a chore',
      'Do not add shopping eggs',
      'Never create bill rent',
      'Add expense dinner then create chore dishes',
    ])
      assert.equal(
        (await request(message, ['shopping', 'chore', 'expense', 'bill']))
          .statusCode,
        400,
      );
    assert.equal(
      (await request('Add shopping eggs', ['unknown'])).statusCode,
      400,
    );
    assert.ok(f.calls.every((call) => call.startsWith('access:')));
  } finally {
    await f.app.close();
  }
});

test('ambiguous financial numbers remain unresolved and no allocation is guessed', async () => {
  const f = fixture();
  try {
    const members = await f.data.households.listMembers();
    for (const text of [
      'Add expense lunch 500',
      'Add expense lunch -500 THB',
      'Add expense lunch 1.234 THB',
      'Add bill power 100 THB plus 20 THB',
      'Add bill rent 100 USD',
      'Add expense lunch 500 THB for 3 people',
    ]) {
      const command = actionCommand(text);
      assert.ok(command);
      const draft = prepareActionDraft(
        command,
        household,
        members,
        new Date('2026-10-01T00:00:00Z'),
      );
      assert.ok(draft.kind === 'expense' || draft.kind === 'bill');
      assert.equal(draft.fields.amountMinor, 0, text);
      assert.ok(
        draft.unresolvedFields.some((field) =>
          field.includes('Enter the total'),
        ),
      );
    }
  } finally {
    await f.app.close();
  }
});

test('greetings and app explanations need no provider and recheck household membership', async () => {
  const f = fixture({ configured: false });
  try {
    for (const message of [
      'Hello!',
      'What are you?',
      'How does HouseMate work?',
    ]) {
      const response = await f.ask({ message });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().kind, 'answer');
      assert.match(response.json().text, /HouseMate/);
    }
    assert.ok(
      !f.calls.some(
        (call) =>
          call.startsWith('provider:') ||
          call.startsWith('budget:') ||
          call.startsWith('dashboard:'),
      ),
    );
    assert.equal((await f.ask({ message: 'Hello' }, foreign)).statusCode, 404);
  } finally {
    await f.app.close();
  }
  const revoked = fixture({ configured: false, revoke: true });
  try {
    assert.equal((await revoked.ask({ message: 'Hello' })).statusCode, 404);
  } finally {
    await revoked.app.close();
  }
});

test('general Gemini answers do not read or send household records', async () => {
  const f = fixture({
    intent: {
      topic: 'general',
      memberName: null,
      scope: null,
      reply: 'Rinse the rice, then follow the package cooking instructions.',
    },
  });
  try {
    const result = await f.ask({ message: 'How do I cook rice?' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().topic, 'general');
    assert.match(result.json().text, /Rinse the rice/);
    assert.deepEqual(result.json().sources, []);
    assert.ok(
      !f.calls.some(
        (call) =>
          call.startsWith('dashboard:') || call.startsWith('announcements:'),
      ),
    );
    assert.equal(
      f.calls.filter((call) => call.startsWith('provider:')).length,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test('announcements use caller-scoped reads, skip expired notices and link their full content', async () => {
  const records = [
    {
      id: 'notice',
      title: 'Inspection',
      body: 'Please keep the hall clear.',
      priority: 'important',
      expired: false,
      canAcknowledge: true,
      publishedAt: '2026-10-01T00:00:00Z',
    },
    { id: 'expired', title: 'Old private notice', expired: true },
  ] as Announcement[];
  const f = fixture({ configured: false, announcements: records });
  try {
    const result = await f.ask({ message: 'What annuncements are there?' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().topic, 'announcements');
    assert.equal(result.json().rows.length, 1);
    assert.match(result.json().rows[0].detail, /hall clear/);
    assert.match(result.json().rows[0].href, /announcement=notice/);
    assert.ok(f.calls.includes(`announcements:user:${id}:all:50:0`));
    assert.ok(!f.calls.some((call) => call.startsWith('provider:')));
    assert.equal(
      (await f.ask({ topic: 'announcements' }, foreign)).statusCode,
      404,
    );
  } finally {
    await f.app.close();
  }
});

test('weather is unavailable without an external request or city prompt', async () => {
  const f = fixture({ configured: false });
  try {
    for (const message of [
      "How's the weather?",
      'Weather in Bangkok',
      'Forecast tomorrow',
    ]) {
      const response = await f.ask({ message });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().kind, 'clarification');
      assert.equal(response.json().topic, 'unsupported');
      assert.match(response.json().text, /don’t check weather/);
      assert.ok(!response.json().text.includes('Which city'));
    }
    assert.ok(f.calls.every((call) => call.startsWith('access:')));
  } finally {
    await f.app.close();
  }
});

test('Gemini generates a bounded structured general answer with no household context', async () => {
  const provider = new GeminiAssistantProvider('test-only-token', (async (
    _url,
    init,
  ) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.maxOutputTokens, 800);
    assert.ok(
      !body.generationConfig.responseJsonSchema.properties.topic.enum.includes(
        'weather',
      ),
    );
    assert.equal(body.contents.length, 1);
    assert.equal(body.tools, undefined);
    assert.ok(!JSON.stringify(body).includes(household.name));
    return geminiResponse(
      JSON.stringify({
        topic: 'general',
        scope: null,
        reply: 'Use a covered container for leftovers.',
      }),
    );
  }) as typeof fetch);
  const result = await provider.classify('How can I store leftovers?');
  assert.equal(result.topic, 'general');
  assert.equal(result.reply, 'Use a covered container for leftovers.');
});

test('Board and Catch me up use authorized records and omit obsolete household tools', async () => {
  const notices = [
    {
      id: 'important',
      title: 'Inspection',
      body: 'Please clear the hall.',
      priority: 'important',
      expired: false,
      canAcknowledge: true,
      publishedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'normal',
      title: 'Welcome',
      body: 'Welcome home.',
      priority: 'normal',
      expired: false,
      publishedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'expired',
      title: 'Old notice',
      body: 'Past',
      priority: 'urgent',
      expired: true,
      publishedAt: '2026-10-01T00:00:00Z',
    },
  ] as Announcement[];
  const f = fixture({ configured: false, announcements: notices });
  try {
    const board = await f.ask({ topic: 'board' });
    assert.equal(board.statusCode, 200);
    assert.deepEqual(
      board.json().rows.map((row: { label: string }) => row.label),
      ['Inspection', 'Welcome', 'BBQ'],
    );
    assert.ok(
      board
        .json()
        .sources.every((source: { href: string }) =>
          source.href.includes(`household=${id}`),
        ),
    );
    const summary = await f.ask({ message: 'Catch me up' });
    assert.deepEqual(
      summary.json().rows.map((row: { label: string }) => row.label),
      ['Inspection', 'BBQ', 'Electricity'],
    );
    assert.ok(
      summary
        .json()
        .rows.every(
          (row: { href: string }) => !/(chores|shopping|meals)/.test(row.href),
        ),
    );
    assert.equal(summary.json().partial, true);
    assert.ok(
      !f.calls.some(
        (call) => call.startsWith('provider:') || call.startsWith('budget:'),
      ),
    );
    assert.equal((await f.ask({ topic: 'board' }, foreign)).statusCode, 404);
  } finally {
    await f.app.close();
  }
  const revoked = fixture({ configured: false, revoke: true });
  try {
    assert.equal((await revoked.ask({ topic: 'board' })).statusCode, 404);
  } finally {
    await revoked.app.close();
  }
});

test('short clarification replies use allowlisted context and fresh authorized reads', async () => {
  const f = fixture({ configured: false });
  try {
    const clarify = await f.ask({ message: 'What is due?' });
    assert.equal(clarify.json().kind, 'clarification');
    assert.deepEqual(
      clarify.json().choices.map((choice: { topic: string }) => choice.topic),
      ['board', 'balance', 'bills'],
    );
    const board = await f.ask({ message: 'Board' });
    assert.equal(board.json().topic, 'board');
    const today = await f.ask({
      message: 'What about today?',
      context: { topic: 'events' },
    });
    assert.equal(today.json().topic, 'events');
    assert.equal(today.json().rows.length, 0);
    assert.match(today.json().text, /2026-10-01/);
    assert.equal(
      (
        await f.ask({
          message: 'Today',
          context: { topic: 'events', householdId: foreign },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.ask({ message: 'Today', context: { topic: 'delete' } }))
        .statusCode,
      400,
    );
    assert.equal(
      (await f.ask({ message: 'Today', context: { topic: 'events' } }, foreign))
        .statusCode,
      404,
    );
    assert.ok(
      !f.calls.some(
        (call) => call.startsWith('provider:') || call.startsWith('budget:'),
      ),
    );
  } finally {
    await f.app.close();
  }
});

test('a context topic cannot supply private conversation data to Gemini', async () => {
  const f = fixture({
    intent: {
      topic: 'general',
      memberName: null,
      scope: null,
      reply: 'Keep dry rice in a sealed container.',
    },
  });
  try {
    const result = await f.ask({
      message: 'How should I store rice?',
      context: { topic: 'balance' },
    });
    assert.equal(result.json().topic, 'general');
    assert.deepEqual(
      f.calls.filter((call) => call.startsWith('provider:')),
      ['provider:How should I store rice?'],
    );
    assert.ok(!f.calls.some((call) => call.startsWith('dashboard:')));
  } finally {
    await f.app.close();
  }
});
