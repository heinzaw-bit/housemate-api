import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { HouseholdAssistant } from '../src/assistant.js';
import type { AssistantIntent } from '../src/assistant-provider.js';
import { OpenAiAssistantProvider } from '../src/assistant-provider.js';
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
  } = {},
) {
  const calls: string[] = [];
  let accessCalls = 0;
  const data = {
    households: {
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
      payload: body,
    });
  return { app, assistant, calls, ask, data };
}

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
      ['access', 'budget', 'provider', 'dashboard', 'access'],
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
    assert.equal((await f.ask({ message: 'balance' })).statusCode, 503);
    for (const topic of [
      'summary',
      'balance',
      'bills',
      'chores',
      'shopping',
      'meals',
      'events',
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
    const result = await ambiguous.ask({ message: 'Alex balance' });
    assert.equal(result.json().kind, 'clarification');
    assert.equal(result.json().rows.length, 0);
    assert.match(result.json().text, /More than one/);
    const action = await unsupported.ask({ message: 'Delete all bills' });
    assert.equal(action.json().kind, 'clarification');
    assert.ok(!unsupported.calls.some((call) => call.startsWith('dashboard:')));
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
    assert.equal((await limited.ask({ message: 'balance' })).statusCode, 429);
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

test('OpenAI receives only the question and returns an allowlisted intent with storage disabled', async () => {
  let payload: Record<string, unknown> | undefined;
  const provider = new OpenAiAssistantProvider(
    'test-only-token',
    'gpt-4o-mini',
    (async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      assert.ok(init?.signal);
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  topic: 'balance',
                  memberName: null,
                  scope: null,
                }),
              },
            ],
          },
        ],
      });
    }) as typeof fetch,
  );
  assert.deepEqual(await provider.classify('How much do I owe?'), {
    topic: 'balance',
    memberName: null,
    scope: null,
  });
  assert.equal(payload?.store, false);
  assert.equal(payload?.max_output_tokens, 400);
  assert.deepEqual(payload?.input, [
    { role: 'user', content: 'How much do I owe?' },
  ]);
  assert.ok(!JSON.stringify(payload).includes(household.name));
});

test('provider refusals, malformed JSON, incomplete output and errors fail safely without retry', async () => {
  const responses = [
    new Response('private provider error with test-only-token', {
      status: 401,
    }),
    Response.json({ status: 'incomplete', output: [] }),
    Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', text: 'No' }],
        },
      ],
    }),
    Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{bad' }],
        },
      ],
    }),
  ];
  for (const response of responses) {
    let calls = 0;
    const provider = new OpenAiAssistantProvider(
      'test-only-token',
      'model',
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
});
