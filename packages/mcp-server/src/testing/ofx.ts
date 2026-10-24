const HEADER = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

`;

/**
 * A bank statement in the old SGML flavour of OFX, where plain values have no
 * closing tag, around the given transactions (see `ofxEntry`).
 */
export function ofxStatement(transactions: string): string {
  return `${HEADER}<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261031120000<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>111000614<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
${transactions}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1234.56<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

/** One transaction of a statement. A tag a bank would leave out is left out of `fields`. */
export function ofxEntry(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(
    ([tag, value]) => `<${tag}>${value}`,
  );
  return `<STMTTRN>\n${lines.join('\n')}\n</STMTTRN>`;
}
