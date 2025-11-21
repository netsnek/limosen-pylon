// utils/sheetsFormatting.ts

// Monatsblatt-Header (mit "Zimmer/Name"), plus versteckte Spalte J=transferId
export const MONTH_HEADERS_VISIBLE = [
  "Nr.", "Datum", "Uhrzeit", "Abholort", "Zielort", "Zimmer/Name", "Wagen", "Betrag", "Bezahlung"
]; // A..I

export const MONTH_TOTAL_COLUMNS = 9; // A..I

// ---------- Styling helpers (colors) ----------
export const COLOR = {
  black: { red: 0, green: 0, blue: 0 },
  white: { red: 1, green: 1, blue: 1 },
  headerGray: { red: 0.953, green: 0.957, blue: 0.965 },    // #F3F4F6
  lightGreen: { red: 0.8196, green: 0.9804, blue: 0.8980 }, // #D1FAE5
  lightBlue:  { red: 0.859, green: 0.918, blue: 0.996 },    // #DBEAFE
  midOrange:  { red: 0.992, green: 0.729, blue: 0.455 }     // #FDBA74
};

type SheetCell = string | number | boolean | null;

// --- XLOOKUP builder for AllRequests with primary key in J ---
function xlookupExpr(
  returnColLetter: string,
  sep: "," | ";",
  masterTitle: string
): string {
  const key = sep === ";" ? "INDEX($J:$J;ROW())" : "INDEX($J:$J,ROW())";
  const aSep = sep;
  return `XLOOKUP(${key}${aSep}${masterTitle}!A:A${aSep}${masterTitle}!${returnColLetter}:${returnColLetter})`;
}

// --- locale-aware selectors without QUERY; hard-coerce types ---
function qSelText(masterCol: string, sep: "," | ";", masterTitle: string): string {
  const key = sep === ";" ? "INDEX($J:$J;ROW())" : "INDEX($J:$J,ROW())";
  const x = xlookupExpr(masterCol, sep, masterTitle);
  if (sep === ";") {
    return `=IF(${key}="";"";IFERROR(${x};""))`;
  } else {
    return `=IF(${key}="","",IFERROR(${x},""))`;
  }
}

function qSelNumber(masterCol: string, sep: "," | ";", masterTitle: string): string {
  const key = sep === ";" ? "INDEX($J:$J;ROW())" : "INDEX($J:$J,ROW())";
  const x = xlookupExpr(masterCol, sep, masterTitle);
  if (sep === ";") {
    // ROUND(...;2) for de/AT etc.
    return `=IF(${key}="";"";IFERROR(ROUND(N(${x});2);""))`;
  } else {
    // ROUND(...,2) for en/US etc.
    return `=IF(${key}="","",IFERROR(ROUND(N(${x}),2),""))`;
  }
}

function qSelDate(masterCol: string, sep: "," | ";", masterTitle: string): string {
  const key = sep === ";" ? "INDEX($J:$J;ROW())" : "INDEX($J:$J,ROW())";
  const x = xlookupExpr(masterCol, sep, masterTitle);
  if (sep === ";") {
    return `=IF(${key}="";"";IFERROR(IF(ISNUMBER(${x});${x};DATE(VALUE(LEFT(${x};4));VALUE(MID(${x};6;2));VALUE(RIGHT(${x};2))));""))`;
  } else {
    return `=IF(${key}="","",IFERROR(IF(ISNUMBER(${x}),${x},DATE(VALUE(LEFT(${x},4)),VALUE(MID(${x},6,2)),VALUE(RIGHT(${x},2)))),""))`;
  }
}

function qSelTime(masterCol: string, sep: "," | ";", masterTitle: string): string {
  const key = sep === ";" ? "INDEX($J:$J;ROW())" : "INDEX($J:$J,ROW())";
  const x = xlookupExpr(masterCol, sep, masterTitle);
  if (sep === ";") {
    return `=IF(${key}="";"";IFERROR(IF(ISNUMBER(${x});${x};TIME(VALUE(LEFT(${x};2));VALUE(MID(${x};4;2));0));""))`;
  } else {
    return `=IF(${key}="","",IFERROR(IF(ISNUMBER(${x}),${x},TIME(VALUE(LEFT(${x},2)),VALUE(MID(${x},4,2)),0)),""))`;
  }
}

// --- Build monthly row formulas (locale-aware) using XLOOKUP (no QUERY) ---
export function monthlyRowFormulas_SQL(
  transferId: string,
  argSep: "," | ";",
  masterTitle: string
): SheetCell[] {
  return [
    "",                                           // A Nr.
    qSelDate("D", argSep, masterTitle),           // B
    qSelTime("E", argSep, masterTitle),           // C
    qSelText("F", argSep, masterTitle),           // D
    qSelText("G", argSep, masterTitle),           // E
    qSelText("H", argSep, masterTitle),           // F
    qSelText("I", argSep, masterTitle),           // G
    qSelNumber("J", argSep, masterTitle),         // H  <<< rounded to 2 decimals
    qSelText("K", argSep, masterTitle),           // I
    transferId                                    // J (hidden)
  ];
}
