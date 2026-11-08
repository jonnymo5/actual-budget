import type { AccountEntity } from './account';
import type { CategoryEntity } from './category';
import type { PayeeEntity } from './payee';
import type { ScheduleEntity } from './schedule';

export type RsuVestFrequency =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

export type RsuGrantEntity = {
  id: string;
  name: string;
  /** Upper-cased stock symbol; also the id of the matching stock price. */
  ticker: string;
  /** YYYY-MM-DD */
  grant_date: string | null;
  total_shares: number;
  /** Account the net proceeds are deposited into. */
  account: AccountEntity['id'];
  /** Income category applied to the deposit, if any. */
  category: CategoryEntity['id'] | null;
  payee: PayeeEntity['id'];
  /** Fraction of the gross withheld for tax, 0..1 (0.37 = 37%). */
  withholding_rate: number;
  notes: string | null;
  sort_order: number | null;
  tombstone?: boolean;
};

export type RsuVestEventEntity = {
  id: string;
  grant_id: RsuGrantEntity['id'];
  /** YYYY-MM-DD */
  vest_date: string;
  shares: number;
  /** The one-off schedule that represents this vest, once created. */
  schedule: ScheduleEntity['id'] | null;
  /** Integer cents, entered by the user after the vest. */
  actual_price: number | null;
  /** Integer cents, entered by the user after the vest. */
  actual_net: number | null;
  notes: string | null;
  tombstone?: boolean;
};

export type StockPriceSource = 'yahoo' | 'stooq' | 'manual';

export type StockPriceEntity = {
  /** Upper-cased ticker */
  id: string;
  /** Integer cents */
  price: number;
  currency: string | null;
  /** ISO timestamp of the quote */
  as_of: string | null;
  /** ISO timestamp when stored */
  updated_at: string | null;
  source: StockPriceSource | null;
  /** When set, automatic refreshes leave this price alone. */
  manual_override: boolean;
  tombstone?: boolean;
};

export type RsuCadenceInput = {
  totalShares: number;
  /** YYYY-MM-DD: vesting commencement date, the anchor for every row. */
  vestStart: string;
  frequency: RsuVestFrequency;
  /** Regular vest events after the cliff (or in total when there is none). */
  periods: number;
  /** 0..100; omit or 0 for no cliff. */
  cliffPercent?: number;
  /** Months after vestStart at which the cliff vests. */
  cliffMonths?: number;
};

export type RsuVestRow = {
  /** YYYY-MM-DD */
  vest_date: string;
  shares: number;
};
