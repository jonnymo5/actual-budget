import { isToolError } from '#errors';
import { ofxEntry as entry, ofxStatement as sgmlStatement } from '#testing/ofx';

import { parseOfxStatement } from './ofx';

const shell = {
  TRNTYPE: 'DEBIT',
  DTPOSTED: '20261003120000[-5:EST]',
  TRNAMT: '-45.67',
  FITID: '2026100301',
  NAME: 'SHELL  OIL 5744',
  MEMO: 'FUEL PURCHASE',
};
const payday = {
  TRNTYPE: 'CREDIT',
  DTPOSTED: '20261015',
  TRNAMT: '2500.00',
  FITID: '2026101501',
  NAME: 'ACME PAYROLL',
  MEMO: 'ACME PAYROLL',
};

const options = { decimalPlaces: 2 };

describe('parseOfxStatement', () => {
  it('reads an SGML statement into rows ready to import', async () => {
    const parsed = await parseOfxStatement(
      sgmlStatement(`${entry(shell)}\n${entry(payday)}`),
      options,
    );

    expect(parsed.skipped).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        date: '2026-10-03',
        amount: -45.67,
        // The payee has its runs of spaces squeezed; the memo is kept.
        payee_name: 'SHELL OIL 5744',
        notes: 'FUEL PURCHASE',
        imported_id: '2026100301',
      },
      {
        date: '2026-10-15',
        amount: 2500,
        payee_name: 'ACME PAYROLL',
        // The memo only repeats the name, so it is not kept as notes.
        notes: null,
        imported_id: '2026101501',
      },
    ]);
  });

  it('reads an XML statement and a credit card statement the same way', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261004</DTPOSTED><TRNAMT>-12.50</TRNAMT><FITID>CC1</FITID><NAME>JOES DINER</NAME></STMTTRN>
</BANKTRANLIST>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

    const parsed = await parseOfxStatement(xml, options);

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-10-04',
      amount: -12.5,
      imported_id: 'CC1',
      notes: null,
    });
  });

  it('decodes the HTML entities banks put in names', async () => {
    const { MEMO: _memo, ...withoutMemo } = shell;
    const parsed = await parseOfxStatement(
      sgmlStatement(entry({ ...withoutMemo, NAME: 'AT&amp;T' })),
      options,
    );

    expect(parsed.rows[0].payee_name).toBe('AT&T');
  });

  it('uses the memo as the payee when there is no name', async () => {
    const { NAME: _name, ...withoutName } = shell;
    const parsed = await parseOfxStatement(
      sgmlStatement(entry(withoutName)),
      options,
    );

    expect(parsed.rows[0]).toMatchObject({
      payee_name: 'FUEL PURCHASE',
      notes: null,
    });
  });

  it('accepts thousands separators and an explicit plus sign', async () => {
    const parsed = await parseOfxStatement(
      sgmlStatement(
        `${entry({ ...shell, TRNAMT: '+1,234.50', FITID: 'a' })}\n${entry({ ...shell, TRNAMT: '-1,000', FITID: 'b' })}`,
      ),
      options,
    );

    expect(parsed.rows.map(row => row.amount)).toEqual([1234.5, -1000]);
  });

  it('lists entries it cannot read exactly instead of guessing', async () => {
    // Banks leave a tag out rather than leave it empty.
    const { TRNAMT: _amount, ...withoutAmount } = shell;
    const parsed = await parseOfxStatement(
      sgmlStatement(
        [
          entry(shell),
          // A decimal comma could mean 12.34 or 1234.
          entry({ ...shell, TRNAMT: '-12,34', FITID: 'comma' }),
          entry({ ...shell, TRNAMT: '-1.234', FITID: 'places' }),
          entry({ ...shell, TRNAMT: 'abc', FITID: 'text' }),
          entry({ ...withoutAmount, FITID: 'blank' }),
        ].join('\n'),
      ),
      options,
    );

    expect(parsed.rows.map(row => row.imported_id)).toEqual(['2026100301']);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ position: 2, imported_id: 'comma' }),
      expect.objectContaining({ position: 3, imported_id: 'places' }),
      expect.objectContaining({ position: 4, imported_id: 'text' }),
      expect.objectContaining({ position: 5, imported_id: 'blank' }),
    ]);
    expect(parsed.skipped[0].reason).toMatch(/"-12,34" is not a plain number/);
    expect(parsed.skipped[1].reason).toMatch(/more than 2 decimal places/);
    expect(parsed.skipped[3].reason).toMatch(/no amount/);
    expect(parsed.warnings).toEqual([
      expect.stringMatching(/4 entries were left out/),
    ]);
  });

  it('holds amounts to the currency decimal places', async () => {
    const parsed = await parseOfxStatement(
      sgmlStatement(
        `${entry({ ...shell, TRNAMT: '-1500', FITID: 'whole' })}\n${entry({ ...shell, TRNAMT: '-15.5', FITID: 'half' })}`,
      ),
      { decimalPlaces: 0 },
    );

    expect(parsed.rows.map(row => row.amount)).toEqual([-1500]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ imported_id: 'half' }),
    ]);
  });

  it('warns about repeated FITIDs and files with several accounts', async () => {
    const twice = `${entry(shell)}\n${entry({ ...shell, TRNAMT: '-9.99' })}`;
    const statement = sgmlStatement(twice);
    const doubled = statement.replace(
      '</BANKMSGSRSV1>',
      `<STMTTRNRS><STMTRS><BANKTRANLIST>${entry({ ...payday })}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>`,
    );

    const parsed = await parseOfxStatement(doubled, options);

    expect(parsed.rows).toHaveLength(3);
    expect(parsed.warnings).toEqual([
      expect.stringMatching(/holds 2 account statements/),
      expect.stringMatching(/FITID value\(s\) appear more than once/),
    ]);
  });

  it('says so when the file has no transactions', async () => {
    const parsed = await parseOfxStatement(sgmlStatement(''), options);

    expect(parsed.rows).toEqual([]);
    expect(parsed.warnings).toEqual(['The file has no transactions.']);
  });

  it('refuses text that is not an OFX file', async () => {
    const error = await parseOfxStatement(
      'Date,Amount\n2026-10-01,-5',
      options,
    ).catch(caught => caught);

    expect(isToolError(error)).toBe(true);
    expect(error.message).toMatch(/no <OFX> element/);
  });
});
