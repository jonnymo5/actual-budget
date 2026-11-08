import { connectTestClient } from '#testing/client';
import { seedFixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

let budget: TestBudget;
let connection: Awaited<ReturnType<typeof connectTestClient>>;
let checkingId: string;

// loot-core decides "past" and "future" with the real clock.
const THIS_YEAR = new Date().getFullYear();
const PAST = [`${THIS_YEAR - 1}-03-15`, `${THIS_YEAR - 1}-06-15`];
const FUTURE = [`${THIS_YEAR + 1}-03-15`, `${THIS_YEAR + 1}-06-15`];

type Json = Record<string, unknown>;
const call = (name: string, args: Json = {}) => connection.call(name, args);

beforeAll(async () => {
  budget = await createTestBudget();
  checkingId = await budget.use(async ctx => {
    const fixture = await seedFixture(ctx);
    const broker = await ctx.api.createPayee({ name: 'Example Broker' });
    const other = await ctx.api.createPayee({ name: 'Someone Else' });
    const money = ctx.amounts.toMinor;
    await ctx.api.addTransactions(fixture.accounts.checking, [
      { date: `${THIS_YEAR - 1}-03-18`, amount: money(610), payee: broker },
      { date: `${THIS_YEAR - 1}-03-16`, amount: money(5), payee: other },
      { date: `${THIS_YEAR - 1}-06-20`, amount: money(590), payee: broker },
      { date: `${THIS_YEAR - 1}-06-01`, amount: money(1000), payee: broker },
    ]);
    return fixture.accounts.checking;
  });
  connection = await connectTestClient({ session: budget.session });
});

afterAll(async () => {
  await connection.close();
  await budget.dispose();
});

type GrantView = {
  id: string;
  name: string;
  ticker: string;
  total_shares: number;
  paid_out_net: number;
  remaining_est_net: number;
  unvalued_rows: number;
  vest_events: Array<{
    id: string;
    vest_date: string;
    shares: number;
    vest_price: number | null;
    est_net: number | null;
    basis: string | null;
    actual_net: number | null;
    schedule_id: string | null;
  }>;
};

async function loadGrant(): Promise<GrantView> {
  const { data } = await call('get_rsu_grants');
  const grants = (data as { grants: GrantView[] }).grants;
  expect(grants).toHaveLength(1);
  return grants[0];
}

describe('create_rsu_grant', () => {
  it('previews rows from a cadence without creating anything', async () => {
    const { result, data, text } = await call('create_rsu_grant', {
      name: 'Grant one',
      ticker: 'acme',
      total_shares: 400,
      account: 'Checking',
      payee: 'Example Broker',
      category: 'General',
      withholding_percent: 40,
      cadence: {
        vest_start: `${THIS_YEAR - 1}-03-15`,
        frequency: 'quarterly',
        periods: 12,
        cliff_percent: 25,
        cliff_months: 12,
      },
    });

    expect(result.isError).toBeFalsy();
    const preview = data as {
      grant_id: string | null;
      planned_rows: Array<{ shares: number; will_schedule: boolean }>;
      total_shares: number;
      dry_run: boolean;
    };
    expect(preview.dry_run).toBe(true);
    expect(preview.grant_id).toBeNull();
    expect(preview.planned_rows).toHaveLength(13);
    expect(preview.planned_rows[0].shares).toBe(100);
    expect(preview.total_shares).toBe(400);
    expect(text).toContain('Would create RSU grant "Grant one" (ACME)');
    const { data: after } = await call('get_rsu_grants');
    expect((after as { grants: unknown[] }).grants).toHaveLength(0);
  });

  it('rejects an unknown payee unless asked to create it', async () => {
    const { result, text } = await call('create_rsu_grant', {
      name: 'Grant one',
      ticker: 'ACME',
      account: 'Checking',
      payee: 'No Such Broker',
      withholding_percent: 40,
      vest_rows: [{ date: FUTURE[0], shares: 10 }],
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('unknown payee');
  });

  it('creates the grant from explicit rows and schedules the future ones', async () => {
    const { result, data } = await call('create_rsu_grant', {
      name: 'Grant one',
      ticker: 'acme',
      grant_date: `${THIS_YEAR - 2}-03-15`,
      account: 'Checking',
      payee: 'Example Broker',
      category: 'General',
      withholding_percent: 40,
      vest_rows: [
        { date: PAST[0], shares: 10 },
        { date: PAST[1], shares: 10 },
        { date: FUTURE[0], shares: 10 },
        { date: FUTURE[1], shares: 10 },
      ],
      dry_run: false,
    });

    expect(result.isError).toBeFalsy();
    const created = data as {
      grant_id: string;
      grant: GrantView;
      dry_run: boolean;
    };
    expect(created.dry_run).toBe(false);
    expect(created.grant).toMatchObject({
      name: 'Grant one',
      ticker: 'ACME',
      total_shares: 40,
      unvalued_rows: 4,
    });
    const grant = await loadGrant();
    expect(grant.id).toBe(created.grant_id);
    // No price yet: nothing can be scheduled.
    expect(grant.vest_events.every(row => row.schedule_id == null)).toBe(true);
  });
});

describe('set_stock_price', () => {
  it('sets a manual price and schedules the future rows', async () => {
    const preview = await call('set_stock_price', {
      ticker: 'acme',
      price: 100,
    });
    expect(preview.result.isError).toBeFalsy();
    expect(preview.data).toMatchObject({
      before: null,
      grants_affected: 1,
      dry_run: true,
    });

    const { result, data } = await call('set_stock_price', {
      ticker: 'acme',
      price: 100,
      dry_run: false,
    });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({
      after: {
        ticker: 'ACME',
        price: 100,
        manual_override: true,
        source: 'manual',
      },
    });

    const grant = await loadGrant();
    const future = grant.vest_events.filter(row => row.vest_date >= FUTURE[0]);
    expect(future.every(row => row.schedule_id != null)).toBe(true);
    // 2 × 10 shares × $100 × 60%
    expect(grant.remaining_est_net).toBe(1200);
    expect(grant.paid_out_net).toBe(1200);
    expect(grant.vest_events[0].basis).toBe('current');
  });

  it('needs a price or use_live', async () => {
    const { result } = await call('set_stock_price', { ticker: 'ACME' });
    expect(result.isError).toBe(true);
  });
});

describe('match_rsu_deposits', () => {
  it('previews the pairings, then records them', async () => {
    const preview = await call('match_rsu_deposits', { grant: 'Grant one' });
    expect(preview.result.isError).toBeFalsy();
    const planned = preview.data as {
      matches: Array<{
        vest_date: string;
        deposit_date: string;
        amount: number;
      }>;
      unmatched: unknown[];
      dry_run: boolean;
    };
    expect(planned.dry_run).toBe(true);
    expect(planned.matches).toEqual([
      expect.objectContaining({
        vest_date: PAST[0],
        deposit_date: `${THIS_YEAR - 1}-03-18`,
        amount: 610,
      }),
      expect.objectContaining({
        vest_date: PAST[1],
        deposit_date: `${THIS_YEAR - 1}-06-20`,
        amount: 590,
      }),
    ]);
    expect(planned.unmatched).toEqual([]);
    expect((await loadGrant()).vest_events[0].actual_net).toBeNull();

    const { result, data } = await call('match_rsu_deposits', {
      grant: 'Grant one',
      dry_run: false,
    });
    expect(result.isError).toBeFalsy();
    expect((data as { matches: unknown[] }).matches).toHaveLength(2);

    const grant = await loadGrant();
    expect(grant.vest_events.slice(0, 2).map(row => row.actual_net)).toEqual([
      610, 590,
    ]);
    expect(grant.vest_events[0].basis).toBe('actual');
    expect(grant.paid_out_net).toBe(1200);

    const again = await call('match_rsu_deposits', {
      grant: 'Grant one',
      dry_run: false,
    });
    expect(again.text).toContain('already has a recorded net');
  });
});

describe('update_rsu_grant', () => {
  it('refuses a no-op', async () => {
    const { result } = await call('update_rsu_grant', {
      grant: 'Grant one',
      withholding_percent: 40,
    });
    expect(result.isError).toBe(true);
  });

  it('changes fields and rows, previewing the diff first', async () => {
    const args = {
      grant: 'Grant one',
      name: 'Grant renamed',
      withholding_percent: 30,
      update_rows: [{ row: FUTURE[0], shares: 15, vest_price: null }],
      remove_rows: [FUTURE[1]],
      add_rows: [{ date: `${THIS_YEAR + 1}-09-15`, shares: 5 }],
    };
    const preview = await call('update_rsu_grant', args);
    expect(preview.result.isError).toBeFalsy();
    expect(preview.data).toMatchObject({
      changed_fields: ['name', 'withholding_rate'],
      rows_added: [expect.objectContaining({ shares: 5 })],
      rows_changed: [
        {
          before: expect.objectContaining({ shares: 10 }),
          after: expect.objectContaining({ shares: 15 }),
        },
      ],
      rows_removed: [expect.objectContaining({ vest_date: FUTURE[1] })],
      dry_run: true,
    });
    expect((await loadGrant()).name).toBe('Grant one');

    const { result } = await call('update_rsu_grant', {
      ...args,
      dry_run: false,
    });
    expect(result.isError).toBeFalsy();

    const grant = await loadGrant();
    expect(grant.name).toBe('Grant renamed');
    expect(grant.vest_events.map(row => [row.vest_date, row.shares])).toEqual([
      [PAST[0], 10],
      [PAST[1], 10],
      [FUTURE[0], 15],
      [`${THIS_YEAR + 1}-09-15`, 5],
    ]);
    // 15 × $100 × 70% + 5 × $100 × 70%
    expect(grant.remaining_est_net).toBe(1400);

    const { data } = await call('get_schedules');
    const names = (
      data as { schedules: Array<{ name: string | null }> }
    ).schedules
      .map(s => s.name)
      .filter((name): name is string => !!name && name.startsWith('RSU · '));
    expect(names.sort()).toEqual([
      `RSU · Grant renamed · ${FUTURE[0]}`,
      `RSU · Grant renamed · ${THIS_YEAR + 1}-09-15`,
    ]);
  });

  it('can record a vest price and actual net by hand', async () => {
    const { result } = await call('update_rsu_grant', {
      grant: 'Grant renamed',
      update_rows: [{ row: PAST[0], vest_price: 95.5, actual_net: 600 }],
      dry_run: false,
    });
    expect(result.isError).toBeFalsy();
    const grant = await loadGrant();
    expect(grant.vest_events[0]).toMatchObject({
      vest_price: 95.5,
      actual_net: 600,
      basis: 'actual',
    });
  });
});

describe('lock_rsu_vest_prices', () => {
  it('lists the vested rows without a price and reports the missing server', async () => {
    const preview = await call('lock_rsu_vest_prices', {
      grant: 'Grant renamed',
    });
    expect(preview.result.isError).toBeFalsy();
    expect(preview.data).toMatchObject({
      pending: [
        expect.objectContaining({ vest_date: PAST[1], ticker: 'ACME' }),
      ],
      dry_run: true,
    });

    const { result, data } = await call('lock_rsu_vest_prices', {
      dry_run: false,
    });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ locked: [], dry_run: false });
    expect((data as { error: string | null }).error).not.toBeNull();
  });
});

describe('get_rsu_grants with a year', () => {
  it('returns the monthly grid', async () => {
    const { result, data } = await call('get_rsu_grants', {
      ticker: 'acme',
      year: THIS_YEAR + 1,
    });
    expect(result.isError).toBeFalsy();
    const monthly = (
      data as { monthly: { totals: number[]; grand_total: number } }
    ).monthly;
    expect(monthly.totals[2]).toBe(1050); // March: 15 × $100 × 70%
    expect(monthly.totals[8]).toBe(350); // September: 5 × $100 × 70%
    expect(monthly.grand_total).toBe(1400);
  });
});

describe('delete_rsu_grant', () => {
  it('previews, requires confirm, then deletes the grant and its schedules', async () => {
    const preview = await call('delete_rsu_grant', { grant: 'Grant renamed' });
    expect(preview.result.isError).toBeFalsy();
    expect(preview.data).toMatchObject({ schedules_deleted: 2, dry_run: true });

    const unconfirmed = await call('delete_rsu_grant', {
      grant: 'Grant renamed',
      dry_run: false,
    });
    expect(unconfirmed.result.isError).toBe(true);

    const { result } = await call('delete_rsu_grant', {
      grant: 'Grant renamed',
      dry_run: false,
      confirm: true,
    });
    expect(result.isError).toBeFalsy();

    const { data } = await call('get_rsu_grants');
    expect((data as { grants: unknown[] }).grants).toHaveLength(0);
    const schedules = await call('get_schedules');
    const rsuSchedules = (
      schedules.data as { schedules: Array<{ name: string | null }> }
    ).schedules.filter(s => s.name?.startsWith('RSU · '));
    expect(rsuSchedules).toHaveLength(0);
    expect(checkingId).toBeTruthy();
  });
});
