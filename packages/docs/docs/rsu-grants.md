# RSU Grants

RSU grants let you plan around stock compensation. You describe each grant once: the stock ticker, how many shares were granted, when they vest, which account the money lands in, and how much tax is withheld. Actual then estimates the cash you will receive at every vest and turns each future vest into a schedule, so the income shows up in the Balance Forecast, in budget templates, and anywhere else schedules are used.

The estimate assumes the shares are sold as soon as they vest: `shares × share price × (1 − withholding)`.

Open the page from the sidebar under **More → RSU Grants**.

## Adding a grant

Click **Add grant** and fill in:

- **Name** and **Ticker** (the stock symbol, such as `ACME`).
- **Grant date** and **Total shares**.
- **Tax withholding**, the share of each vest kept back for tax. Check your last vest statement for the right percentage.
- **Payee** and **Deposit account**: the payee the deposit arrives from and the account it arrives in. The schedule uses both to recognise the real deposit when it lands.
- **Income category**, applied to the deposit when the schedule links to it.

### Vest rows

Each row is one vest: a date and a share count. You can type the rows in by hand, exactly as your brokerage shows them, or generate them from a cadence:

- **Vesting starts** is the first vest date (or the start of the vesting period when there is a cliff).
- **Frequency** and **Periods** describe the regular vests, for example quarterly for 16 periods.
- **Cliff** and **Cliff after (months)** add a first, larger vest. A grant that vests 25% after one year and then quarterly is `25%`, `12` months, quarterly, `12` periods.

Generated rows always add up to the total shares, and you can edit, add or remove rows afterwards. Rows in the past get no schedule; record what you actually received in **Actual net** instead and the year grid will use that figure.

## Share prices

Every ticker has one price, shared by all grants that use it. Prices are shown at the top of the page.

- **Refresh prices** fetches current prices through your sync server. Actual also refreshes them once a day after the first sync of the day. Prices come from public market data and may be delayed.
- **Set price** lets you type a price. A price set by hand is kept until you choose **Use live price** again.
- Without a sync server, prices are always entered by hand.

Whenever a price changes, the estimated net of every unpaid vest schedule is updated.

## How vests appear elsewhere

Each future vest row becomes a one-off, non-posting schedule named `RSU · <grant> · <date>`. These show up in the Schedules page with an **RSU** badge and are managed by the grant: edit the grant to change them, and they are removed when their row or grant is removed. When the real deposit arrives, Actual matches it to the schedule like any other scheduled transaction.

Because they are ordinary schedules, RSU vests are included in the [Balance Forecast](./reports/index.md), can be referenced from [budget templates](./experimental/goal-templates.md) with `#template schedule RSU · <grant> · <date>`, and are visible to any tool that reads schedules.

The grid at the bottom of the page shows the estimated net per grant and per month for one year, with recorded amounts highlighted, so you can see what a year of vests is worth while planning your budget.
