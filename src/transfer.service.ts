import { getContext, getEnv, requireAuth } from "@getcronit/pylon";
import validator from "validator";
import { UserService } from "./user.service";
import {
  COLOR,
  MONTH_HEADERS_VISIBLE,
  MONTH_TOTAL_COLUMNS,
  monthlyRowFormulas_SQL
} from "./utils/sheetsFormatting";

// ---------- Domain ----------
export type TransferState =
  | "pending"
  | "confirmed"
  | "complete"
  | "canceled"
  | "terminated";

export interface TransferInput {
  rideDateISO: string; // YYYY-MM-DD
  rideTime: string; // HH:mm
  pickup: string; // Abholort
  dropoff: string; // Zielort
  roomOrName?: string; // Zimmer/Name
  vehicle?: string; // Wagen
  amountEUR?: number; // Betrag
  payment?: string; // Bezahlung
}

export interface TransferRow extends TransferInput {
  transferId: string;
  customerId: string; // renamed from userId
  customerName?: string; // im Master protokolliert
  driverId?: string; // driver is also a user → stores userId
  driverName?: string; // resolved at assignment
  state: TransferState; // nur im Master
  requestedAtISO: string;
}

type SheetValue = string | number | boolean | null;

// ---------- Config ----------
const MASTER_TITLE = "AllRequests";
// New header layout (A..O)
const MASTER_HEADERS = [
  "transferId", // A
  "customerId", // B (renamed from userId)
  "customerName", // C
  "rideDateISO", // D
  "rideTime", // E
  "pickup", // F
  "dropoff", // G
  "roomOrName", // H
  "vehicle", // I
  "amountEUR", // J
  "payment", // K
  "driverId", // L (userId of driver)
  "driverName", // M (human readable)
  "state", // N
  "requestedAtISO" // O
];

// ---------- Base64URL & PEM helpers ----------
const te = new TextEncoder();

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let b64: string;
  // @ts-ignore
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    // @ts-ignore
    b64 = Buffer.from(bytes).toString("base64");
  } else {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    // @ts-ignore
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJSON(obj: unknown): string {
  const bytes = te.encode(JSON.stringify(obj));
  return base64UrlEncodeBytes(bytes);
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  // @ts-ignore
  const raw =
    typeof atob !== "undefined"
      ? atob(clean)
      : Buffer.from(clean, "base64").toString("binary");
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

// ---------- Google Auth (Service Account via WebCrypto RS256) ----------
async function googleAccessToken(): Promise<string> {
  const env: any = getEnv();
  const clientEmail = env?.GOOGLE_SHEETS_CLIENT_EMAIL;
  let privateKey = env?.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_SHEETS_CLIENT_EMAIL or GOOGLE_SHEETS_PRIVATE_KEY");
  }
  privateKey = privateKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);

  // 👉 widen getContext() type so we can use custom keys
  const ctx = getContext() as any;
  const cached = ctx.get("gsheets_token") as
    | { token: string; exp: number }
    | undefined;

  // Re-use token if still valid for at least 60s
  if (cached && cached.exp > now + 60) {
    return cached.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const encodedHeader = base64UrlEncodeJSON(header);
  const encodedClaim = base64UrlEncodeJSON(claim);
  const unsigned = `${encodedHeader}.${encodedClaim}`;

  const subtle = (globalThis.crypto && globalThis.crypto.subtle) as SubtleCrypto;
  if (!subtle) throw new Error("WebCrypto SubtleCrypto is not available in this runtime");

  const keyData = pemToPkcs8(privateKey);
  const cryptoKey = await subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    te.encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    }).toString()
  });

  const j: any = await r.json();
  if (!r.ok) throw new Error(`Token error: ${r.status} ${JSON.stringify(j)}`);

  const exp = now + (typeof j.expires_in === "number" ? j.expires_in : 3600);
  ctx.set("gsheets_token", { token: j.access_token as string, exp });

  return j.access_token as string;
}

// ---------- Sheets helpers ----------
function spreadsheetId(): string {
  const env: any = getEnv();
  const id = env?.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!id) throw new Error("Missing GOOGLE_SHEETS_SPREADSHEET_ID");
  return id;
}

async function sheetsGet<T = any>(
  path: string,
  accessToken: string
): Promise<T> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId()}${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Sheets GET ${path}: ${await r.text()}`);
  return r.json();
}

async function sheetsPost<T = any>(
  path: string,
  body: any,
  accessToken: string
): Promise<T> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId()}${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Sheets POST ${path}: ${await r.text()}`);
  return r.json();
}

async function sheetsPut<T = any>(
  path: string,
  body: any,
  accessToken: string
): Promise<T> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId()}${path}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Sheets PUT ${path}: ${await r.text()}`);
  return r.json();
}

async function sheetsBatchUpdate(requests: any[], accessToken: string) {
  if (!requests.length) return;
  await sheetsPost<unknown>(`:batchUpdate`, { requests }, accessToken);
}

async function valuesGet(rangeA1: string, accessToken: string) {
  return sheetsGet<{ values?: SheetValue[][] }>(
    `/values/${encodeURIComponent(rangeA1)}`,
    accessToken
  );
}

async function valuesUpdate(
  rangeA1: string,
  values: SheetValue[][],
  accessToken: string,
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED"
) {
  return sheetsPut(
    `/values/${encodeURIComponent(rangeA1)}?valueInputOption=${valueInputOption}`,
    { values, range: rangeA1, majorDimension: "ROWS" },
    accessToken
  );
}

async function valuesAppend(
  rangeA1: string,
  values: SheetValue[][],
  accessToken: string,
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED"
) {
  return sheetsPost(
    `/values/${encodeURIComponent(rangeA1)}:append?insertDataOption=INSERT_ROWS&valueInputOption=${valueInputOption}`,
    { values, majorDimension: "ROWS" },
    accessToken
  );
}

// Batch values update (multiple ranges in one HTTP call)
async function valuesBatchUpdate(
  data: { range: string; values: SheetValue[][]; majorDimension?: "ROWS" | "COLUMNS" }[],
  accessToken: string,
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED"
) {
  if (!data.length) return;
  return sheetsPost(
    `/values:batchUpdate`,
    {
      valueInputOption,
      data: data.map(d => ({
        range: d.range,
        values: d.values,
        majorDimension: d.majorDimension ?? "ROWS"
      }))
    },
    accessToken
  );
}

// Cache sheets metadata per request to avoid repeated `spreadsheets.get`
async function spreadsheetSheets(
  accessToken: string,
  force = false
): Promise<{
  sheets?: { properties: { sheetId: number; title: string; index: number } }[];
}> {
  const ctx = getContext() as any;
  let cached = ctx.get("sheets_meta") as
    | {
        sheets?: {
          properties: { sheetId: number; title: string; index: number };
        }[];
      }
    | undefined;

  if (!cached || force) {
    cached = await sheetsGet<{
      sheets?: { properties: { sheetId: number; title: string; index: number } }[];
    }>(`?fields=sheets.properties`, accessToken);
    ctx.set("sheets_meta", cached);
  }

  return cached;
}

async function ensureSheet(title: string, accessToken: string) {
  const { sheets } = await spreadsheetSheets(accessToken);
  const exists = sheets?.some((s) => s.properties.title === title);
  if (!exists) {
    await sheetsBatchUpdate(
      [{ addSheet: { properties: { title } } }],
      accessToken
    );
    // refresh sheets metadata so sheetIdByTitle sees the new sheet
    await spreadsheetSheets(accessToken, true);
  }
}

async function sheetIdByTitle(title: string, accessToken: string): Promise<number> {
  const { sheets } = await spreadsheetSheets(accessToken);
  const s = sheets?.find((s) => s.properties.title === title);
  if (!s) throw new Error(`Sheet not found: ${title}`);
  return s.properties.sheetId;
}

function colLetter(idx1: number): string {
  let s = "";
  let n = idx1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Spreadsheet locale → formula arg separator
async function getFormulaArgSep(accessToken: string): Promise<"," | ";"> {
  const ctx = getContext() as any;
  const cached = ctx.get("sheets_arg_sep") as ("," | ";") | undefined;
  if (cached) return cached;

  const meta = await sheetsGet<{ properties?: { locale?: string } }>(
    `?fields=properties.locale`,
    accessToken
  );
  const loc = (meta?.properties?.locale || "en_US").toLowerCase();
  const useSemi = /de|at|fr|it|es|nl|pl|pt|tr|ru|cz|cs|sk|hu|ro|bg|hr|sr|sl|el|gr|da|no|sv|fi|uk|ua|ar/.test(
    loc
  );
  const sep: "," | ";" = useSemi ? ";" : ",";
  ctx.set("sheets_arg_sep", sep);
  return sep;
}

// ---------- Master bootstrapping & migration ----------
async function ensureMaster(accessToken: string) {
  await ensureSheet(MASTER_TITLE, accessToken);

  // Write headers if missing
  const headerRange = `${MASTER_TITLE}!A1:${colLetter(MASTER_HEADERS.length)}1`;
  const existing = await valuesGet(headerRange, accessToken);
  const hasHeaders =
    !!existing.values && existing.values[0]?.length >= MASTER_HEADERS.length;

  if (!hasHeaders) {
    await valuesUpdate(headerRange, [MASTER_HEADERS], accessToken);
  } else {
    await migrateMasterIfNeeded(accessToken);
  }
}

/**
 * Migrates an old schema:
 * - B: userId -> customerId (rename)
 * - L: driver -> driverId (rename)
 * - inserts new column M: driverName
 * - shifts state to N, requestedAtISO to O
 */
async function migrateMasterIfNeeded(accessToken: string) {
  const sheetId = await sheetIdByTitle(MASTER_TITLE, accessToken);

  // Read a wide header slice
  const { values } = await valuesGet(`${MASTER_TITLE}!A1:Z1`, accessToken);
  const header = values?.[0] ?? [];

  const get = (idx: number) => String(header[idx] ?? "");
  const setCell = async (a1: string, text: string) =>
    valuesUpdate(`${MASTER_TITLE}!${a1}`, [[text]], accessToken);

  if (get(1) === "userId") {
    await setCell("B1", "customerId");
  }

  if (get(11) === "driver") {
    await setCell("L1", "driverId");
  }

  const colM = get(12);
  if (colM === "state" || colM === "") {
    await sheetsBatchUpdate(
      [
        {
          insertDimension: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 12, endIndex: 13 }
          }
        }
      ],
      accessToken
    );
    await valuesUpdate(
      `${MASTER_TITLE}!M1:O1`,
      [["driverName", "state", "requestedAtISO"]],
      accessToken
    );
  }

  await valuesUpdate(
    `${MASTER_TITLE}!A1:${colLetter(MASTER_HEADERS.length)}1`,
    [MASTER_HEADERS],
    accessToken
  );
}

// ---------- Mapping ----------
function rowToTransfer(row: SheetValue[]): TransferRow | null {
  if (!row || row.length < MASTER_HEADERS.length) return null;
  const [
    transferId,
    customerId,
    customerName,
    rideDateISO,
    rideTime,
    pickup,
    dropoff,
    roomOrName,
    vehicle,
    amountEUR,
    payment,
    driverId,
    driverName,
    state,
    requestedAtISO
  ] = row.map((v) => (v ?? "") as string);

  return {
    transferId,
    customerId,
    customerName,
    rideDateISO,
    rideTime,
    pickup,
    dropoff,
    roomOrName,
    vehicle,
    amountEUR: amountEUR ? Number(amountEUR) : undefined,
    payment,
    driverId: driverId || undefined,
    driverName: driverName || undefined,
    state: state as TransferState,
    requestedAtISO
  };
}

function transferToMasterRow(t: TransferRow): SheetValue[] {
  return [
    t.transferId,
    t.customerId,
    t.customerName ?? "",
    t.rideDateISO,
    t.rideTime,
    t.pickup,
    t.dropoff,
    t.roomOrName ?? "",
    t.vehicle ?? "",
    typeof t.amountEUR === "number" ? t.amountEUR : "",
    t.payment ?? "",
    t.driverId ?? "",
    t.driverName ?? "",
    t.state,
    t.requestedAtISO
  ];
}

// ---------- Utilities ----------
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  (globalThis.crypto as Crypto).getRandomValues(arr);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

function newTransferId(): string {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const rand = randomHex(3);
  return `tr_${ts}_${rand}`;
}

function monthKeyFromISO(dateISO: string): string {
  return dateISO.slice(0, 7); // YYYY-MM
}

function germanMonthLabel(yyyymm: string) {
  const [yStr, mStr] = yyyymm.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const names = [
    "JÄNNER",
    "FEBRUAR",
    "MÄRZ",
    "APRIL",
    "MAI",
    "JUNI",
    "JULI",
    "AUGUST",
    "SEPTEMBER",
    "OKTOBER",
    "NOVEMBER",
    "DEZEMBER"
  ];
  return `${names[m - 1]} ${y}`;
}

function monthSheetTitle(userId: string, yyyymm: string) {
  return `USR_${userId}_${yyyymm}`;
}

// ----- helpers for master lookups -----
async function findMasterRowIndexByTransferId(
  transferId: string,
  accessToken: string
): Promise<number | null> {
  const range = `${MASTER_TITLE}!A2:A`;
  const { values } = await valuesGet(range, accessToken);
  if (!values) return null;
  for (let i = 0; i < values.length; i++) {
    if ((values[i][0] as string) === transferId) return i + 2; // A2 => row 2
  }
  return null;
}

async function getMasterRowWithIndex(
  transferId: string,
  accessToken: string
): Promise<{ rowIdx: number | null; row: TransferRow | null }> {
  const idx = await findMasterRowIndexByTransferId(transferId, accessToken);
  if (!idx) return { rowIdx: null, row: null };
  const range = `${MASTER_TITLE}!A${idx}:${colLetter(MASTER_HEADERS.length)}${idx}`;
  const { values } = await valuesGet(range, accessToken);
  const row = values?.[0] ? rowToTransfer(values[0]) : null;
  return { rowIdx: idx, row };
}

// ---------- Monthly helpers ----------
async function findMonthlyRowIndexByTransferId(
  sheetTitle: string,
  transferId: string,
  accessToken: string
): Promise<number | null> {
  const { values } = await valuesGet(`${sheetTitle}!J4:J`, accessToken);
  if (!values) return null;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i]?.[0] ?? "") === transferId) {
      return 4 + i; // J4 is row 4
    }
  }
  return null;
}

// ---------- Monthly sheet styling ----------
async function styleMonthlySheetBase(title: string, accessToken: string) {
  const sheetId = await sheetIdByTitle(title, accessToken);

  const requests: any[] = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 3 } },
        fields: "gridProperties.frozenRowCount"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 9
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 14 },
            backgroundColor: COLOR.white
          }
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)"
      }
    },
    // Row 2 (A2:I2) – fett, weißer Hintergrund
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 9
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: COLOR.white,
            textFormat: { bold: true }
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)"
      }
    },
    // G2 rechtsbündig (Label "Kundennummer:")
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 6, // G
          endColumnIndex: 7
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "RIGHT"
          }
        },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 2,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 9
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: COLOR.headerGray,
            horizontalAlignment: "CENTER",
            textFormat: { bold: true }
          }
        },
        fields:
          "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)"
      }
    },
    ...[40, 100, 70, 220, 220, 180, 110, 110, 130].map((px, i) => ({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: i,
          endIndex: i + 1
        },
        properties: { pixelSize: px },
        fields: "pixelSize"
      }
    })),
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 9,
          endIndex: 10
        }, // J
        properties: { hiddenByUser: true },
        fields: "hiddenByUser"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 1
        },
        cell: {
          userEnteredFormat: { horizontalAlignment: "CENTER" }
        },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 3,
          startColumnIndex: 1,
          endColumnIndex: 3
        },
        cell: {
          userEnteredFormat: { horizontalAlignment: "CENTER" }
        },
        fields: "userEnteredFormat.horizontalAlignment"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 3,
          startColumnIndex: 1,
          endColumnIndex: 2
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "DATE", pattern: "dd.MM.yyyy" }
          }
        },
        fields: "userEnteredFormat.numberFormat"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 3,
          startColumnIndex: 2,
          endColumnIndex: 3
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "TIME", pattern: "hh:mm" }
          }
        },
        fields: "userEnteredFormat.numberFormat"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 3,
          startColumnIndex: 7,
          endColumnIndex: 8
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "CURRENCY", pattern: "#,##0.00€" },
            horizontalAlignment: "RIGHT"
          }
        },
        fields: "userEnteredFormat(numberFormat,horizontalAlignment)"
      }
    }
  ];

  await sheetsBatchUpdate(requests, accessToken);
}

async function enforceNumberFormatsForRows(
  sheetTitle: string,
  rowStart: number,
  rowEnd: number,
  accessToken: string
) {
  if (rowEnd < rowStart) return;
  const sheetId = await sheetIdByTitle(sheetTitle, accessToken);

  const requests: any[] = [
    // Date (B)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowStart - 1,
          endRowIndex: rowEnd,
          startColumnIndex: 1,
          endColumnIndex: 2
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "DATE", pattern: "dd.MM.yyyy" },
            horizontalAlignment: "CENTER"
          }
        },
        fields: "userEnteredFormat(numberFormat,horizontalAlignment)"
      }
    },
    // Time (C)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowStart - 1,
          endRowIndex: rowEnd,
          startColumnIndex: 2,
          endColumnIndex: 3
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "TIME", pattern: "hh:mm" },
            horizontalAlignment: "CENTER"
          }
        },
        fields: "userEnteredFormat(numberFormat,horizontalAlignment)"
      }
    },
    // Amounts (H)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowStart - 1,
          endRowIndex: rowEnd,
          startColumnIndex: 7,
          endColumnIndex: 8
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "CURRENCY", pattern: "#,##0.00€" },
            horizontalAlignment: "RIGHT"
          }
        },
        fields: "userEnteredFormat(numberFormat,horizontalAlignment)"
      }
    }
  ];

  await sheetsBatchUpdate(requests, accessToken);
}

// ---------- Sorting helper (Abrechnung chronologisch) ----------
async function sortMonthlySheetChronologically(
  sheetTitle: string,
  accessToken: string,
  dataCountHint?: number
) {
  let dataCount = dataCountHint ?? 0;

  // Fallback: only if caller did not provide dataCount
  if (!dataCountHint) {
    const { values } = await valuesGet(`${sheetTitle}!J4:J`, accessToken);
    dataCount = values?.length
      ? values.filter((r) => String(r?.[0] ?? "") !== "").length
      : 0;
  }

  if (dataCount <= 1) return;

  const sheetId = await sheetIdByTitle(sheetTitle, accessToken);

  await sheetsBatchUpdate(
    [
      {
        sortRange: {
          range: {
            sheetId,
            startRowIndex: 3, // row 4
            endRowIndex: 3 + dataCount, // exclusive
            startColumnIndex: 0,
            endColumnIndex: 10 // A..J
          },
          sortSpecs: [
            { dimensionIndex: 1, sortOrder: "ASCENDING" }, // B: Datum
            { dimensionIndex: 2, sortOrder: "ASCENDING" } // C: Uhrzeit
          ]
        }
      }
    ],
    accessToken
  );

  // Renumber "Nr." column (A) after sorting
  const nrValues: SheetValue[][] = [];
  for (let i = 0; i < dataCount; i++) {
    nrValues.push([i + 1]);
  }
  await valuesUpdate(
    `${sheetTitle}!A4:A${3 + dataCount}`,
    nrValues,
    accessToken
  );
}

// ---------- Totals / spacer handling ----------
async function refreshMonthlyTotals(
  sheetTitle: string,
  accessToken: string,
  dataCountHint?: number
) {
  const argSep = await getFormulaArgSep(accessToken);

  // One read: detect voucher + count rows
  const { values: hv } = await valuesGet(
    `${sheetTitle}!H4:I`,
    accessToken
  );

  let dataCount = 0;
  let voucherExists = false;

  if (hv && hv.length) {
    for (const r of hv) {
      const amount = String(r?.[0] ?? "");
      const payment = String(r?.[1] ?? "");
      if (amount !== "" || payment !== "") {
        dataCount++;
      }
      if (payment === "Gutschein") {
        voucherExists = true;
      }
    }
  }

  // If caller passed a hint, trust it (sheet was just rewritten)
  if (typeof dataCountHint === "number") {
    dataCount = dataCountHint;
  }

  const lastDataRow = 3 + dataCount;

  const sheetId = await sheetIdByTitle(sheetTitle, accessToken);

  // Prepare value writes (in one values:batchUpdate)
  const spacerRow = lastDataRow + 1;
  let cursor = spacerRow + 1;
  const sumRow = cursor;
  cursor++;

  const voucherRow = voucherExists ? cursor : null;
  if (voucherExists) cursor++;
  const netRow = cursor;
  cursor++;
  const vatRow = cursor;
  cursor++;
  const discountedRow = cursor;
  cursor++;

  const amountCol = "H";
  const paymentCol = "I";

  const round2 = (expr: string) =>
    argSep === ";" ? `ROUND(${expr};2)` : `ROUND(${expr},2)`;

  const sumInner =
    dataCount > 0 ? `SUM(${amountCol}4:${amountCol}${lastDataRow})` : `0`;

  const voucherInner =
    dataCount > 0
      ? `SUMIF(${paymentCol}4:${paymentCol}${lastDataRow}${argSep}"Gutschein"${argSep}${amountCol}4:${amountCol}${lastDataRow})`
      : `0`;

  const sumFormula = `=${round2(sumInner)}`;
  const voucherFormula = `=${round2(voucherInner)}`;
  const netInner = `H${sumRow}-${voucherExists ? `H${voucherRow!}` : "0"}`;
  const netFormula = `=${round2(netInner)}`;

  const vatPercent = 10;
  const vatInner = `H${netRow}*(1+${vatPercent}/100)`;
  const vatFormula = `=${round2(vatInner)}`;

  const discInner = `H${netRow}*(1-4/100)*(1+${vatPercent}/100)`;
  const discFormula = `=${round2(discInner)}`;

  const batchData: { range: string; values: SheetValue[][] }[] = [];

  // Clear totals block F..H (6 rows)
  batchData.push({
    range: `${sheetTitle}!F${lastDataRow + 1}:H${lastDataRow + 6}`,
    values: [
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
      ["", "", ""]
    ]
  });

  // Spacer row
  batchData.push({
    range: `${sheetTitle}!A${spacerRow}:I${spacerRow}`,
    values: [["", "", "", "", "", "", "", "", ""]]
  });

  // Sum row (label in F, value in H)
  batchData.push({
    range: `${sheetTitle}!F${sumRow}:H${sumRow}`,
    values: [["Gesamtsumme:", "", sumFormula]]
  });

  if (voucherExists && voucherRow) {
    batchData.push({
      range: `${sheetTitle}!F${voucherRow}:H${voucherRow}`,
      values: [[`LIMOSEN KG 100% Rabatt Gutscheine:`, "", voucherFormula]]
    });
  }

  batchData.push({
    range: `${sheetTitle}!F${netRow}:H${netRow}`,
    values: [[`Rechnungsbetrag nach Abzug Gutscheine:`, "", netFormula]]
  });

  batchData.push({
    range: `${sheetTitle}!F${vatRow}:H${vatRow}`,
    values: [[`Gesamt Rechnungsbetrag inkl. 10% MwSt:`, "", vatFormula]]
  });

  batchData.push({
    range: `${sheetTitle}!F${discountedRow}:H${discountedRow}`,
    values: [[`Gesamt Rechnungsbetrag inkl. 10% MwSt mit 4% Rabatt:`, "", discFormula]]
  });

  await valuesBatchUpdate(batchData, accessToken);

  // Styling + borders in ONE batchUpdate call
  const requests: any[] = [];

  if (dataCount > 0) {
    requests.push({
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 3, // row 4
          endRowIndex: lastDataRow,
          startColumnIndex: 0,
          endColumnIndex: MONTH_TOTAL_COLUMNS
        },
        top: { style: "SOLID", color: COLOR.black },
        bottom: { style: "SOLID", color: COLOR.black },
        left: { style: "SOLID", color: COLOR.black },
        right: { style: "SOLID", color: COLOR.black },
        innerHorizontal: { style: "SOLID", color: COLOR.black },
        innerVertical: { style: "SOLID", color: COLOR.black }
      }
    });
  }

  requests.push(
    // Bold block (F..H)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: sumRow - 1,
          endRowIndex: discountedRow,
          startColumnIndex: 5,
          endColumnIndex: 8
        },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat.bold"
      }
    },
    // Currency format H
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: sumRow - 1,
          endRowIndex: discountedRow,
          startColumnIndex: 7,
          endColumnIndex: 8
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "CURRENCY", pattern: "#,##0.00€" },
            horizontalAlignment: "RIGHT"
          }
        },
        fields: "userEnteredFormat(numberFormat,horizontalAlignment)"
      }
    },
    // Highlight discounted row label cells → weißer Hintergrund
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: discountedRow - 1,
          endRowIndex: discountedRow,
          startColumnIndex: 5,
          endColumnIndex: 6
        },
        cell: { userEnteredFormat: { backgroundColor: COLOR.white } },
        fields: "userEnteredFormat.backgroundColor"
      }
    },
    // Background für Sum-Row (G..H) → weiß
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: sumRow - 1,
          endRowIndex: sumRow,
          startColumnIndex: 6,
          endColumnIndex: 8
        },
        cell: { userEnteredFormat: { backgroundColor: COLOR.white } },
        fields: "userEnteredFormat.backgroundColor"
      }
    },
    // Background für Net-Row (H) → weiß
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: netRow - 1,
          endRowIndex: netRow,
          startColumnIndex: 7,
          endColumnIndex: 8
        },
        cell: { userEnteredFormat: { backgroundColor: COLOR.white } },
        fields: "userEnteredFormat.backgroundColor"
      }
    },
    // Double bottom border for discounted total (H)
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: discountedRow - 1,
          endRowIndex: discountedRow,
          startColumnIndex: 7,
          endColumnIndex: 8
        },
        bottom: { style: "DOUBLE", color: COLOR.black }
      }
    }
  );

  await sheetsBatchUpdate(requests, accessToken);
}

// ---------- Apps Script WebApp helper (SHEETS_WEBAPP_URL) ----------
async function callAppsScriptForSheet(sheetTitle: string): Promise<void> {
  const env: any = getEnv();
  const scriptUrl = env?.SHEETS_WEBAPP_URL;
  if (!scriptUrl) {
    console.warn("SHEETS_WEBAPP_URL is not set, skipping Apps Script refresh");
    return;
  }

  try {
    const resp = await fetch(
      `${scriptUrl}?sheet=${encodeURIComponent(sheetTitle)}`,
      { method: "GET" }
    );
    // Consume body so Cloudflare doesn't complain about stalled responses
    await resp.text();
  } catch (err) {
    console.error("Apps Script refresh failed", err);
  }
}

async function tryGetUserDisplayName(
  userId: string
): Promise<string | undefined> {
  try {
    const user = await UserService.getZitadelUserById(userId);
    const display =
      user?.human?.profile?.displayName ||
      `${user?.human?.profile?.firstName ?? ""} ${
        user?.human?.profile?.lastName ?? ""
      }`.trim();
    return display || undefined;
  } catch {
    return undefined;
  }
}

async function ensureMonthlyForUser(
  userId: string,
  yyyymm: string,
  accessToken: string,
  opts?: { wipe?: boolean }
): Promise<string> {
  const title = monthSheetTitle(userId, yyyymm);
  await ensureSheet(title, accessToken);

  if (opts?.wipe) {
    await sheetsBatchUpdate(
      [
        {
          updateCells: {
            range: { sheetId: await sheetIdByTitle(title, accessToken) },
            fields: "userEnteredValue"
          }
        }
      ],
      accessToken
    );
  }

  const header1 = `ABRECHNUNG: ${germanMonthLabel(yyyymm)}`;
  const displayName = await tryGetUserDisplayName(userId).catch(
    () => undefined
  );

  // A2: nur Kundenname (falls vorhanden)
  const nameCell = displayName ?? "";
  // G2: Label "Kundennummer:", H2: Wert (ID)
  const kundenLabel = "Kundennummer:";
  const kundenValue = userId;

  const exist = await valuesGet(`${title}!A1:J3`, accessToken);
  const hasHeader3 =
    !!exist.values &&
    exist.values.length >= 3 &&
    ((exist.values[2]?.length ?? 0) >= MONTH_TOTAL_COLUMNS);

  if (!hasHeader3) {
    await valuesUpdate(`${title}!A1`, [[header1]], accessToken);
    await valuesUpdate(
      `${title}!A2:I2`,
      [[nameCell, "", "", "", "", "", kundenLabel, kundenValue, ""]],
      accessToken
    );
    await valuesUpdate(
      `${title}!A3:I3`,
      [MONTH_HEADERS_VISIBLE],
      accessToken
    );
  } else {
    await valuesUpdate(`${title}!A1`, [[header1]], accessToken);
    await valuesUpdate(
      `${title}!A2:I2`,
      [[nameCell, "", "", "", "", "", kundenLabel, kundenValue, ""]],
      accessToken
    );
  }

  await styleMonthlySheetBase(title, accessToken);
  return title;
}

// ---------- Public API ----------
export class TransferService {
  //@requireAuth()
  static async createTransfer(
    customerId: string,
    rideDateISO: string,
    rideTime: string,
    pickup: string,
    dropoff: string,
    roomOrName?: string,
    vehicle?: string,
    amountEUR?: number,
    payment?: string
  ): Promise<{ transferId: string }> {
    if (!validator.isISO8601(rideDateISO))
      throw new Error("Invalid rideDateISO");
    if (!/^\d{2}:\d{2}$/.test(rideTime))
      throw new Error("Invalid rideTime");
    if (!customerId) throw new Error("customerId required");

    const displayName = await tryGetUserDisplayName(customerId);

    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);

    const row: TransferRow = {
      transferId: newTransferId(),
      customerId,
      customerName: displayName,
      rideDateISO,
      rideTime,
      pickup,
      dropoff,
      roomOrName,
      vehicle,
      amountEUR,
      payment,
      driverId: "",
      driverName: "",
      state: "pending",
      requestedAtISO: new Date().toISOString()
    };

    await valuesAppend(
      `${MASTER_TITLE}!A:A`,
      [transferToMasterRow(row)],
      accessToken
    );
    return { transferId: row.transferId };
  }

  //@requireAuth()
  static async bookTransfer(
    rideDateISO: string,
    rideTime: string,
    pickup: string,
    dropoff: string,
    roomOrName?: string,
    vehicle?: string,
    amountEUR?: number,
    payment?: string
  ): Promise<{ transferId: string }> {
    const auth = getContext().get("auth");
    const userId = "346402675442587254"//auth.sub as string;
    if (!userId) throw new Error("Anonymous");

    return TransferService.createTransfer(
      userId,
      rideDateISO,
      rideTime,
      pickup,
      dropoff,
      roomOrName,
      vehicle,
      amountEUR,
      payment
    );
  }

  static async assignDriver(
    transferId: string,
    driverUserId: string
  ): Promise<void> {
    if (!driverUserId) throw new Error("driverUserId required");
    try {
      await UserService.getZitadelUserById(driverUserId);
    } catch {
      throw new Error("Driver user not found");
    }

    const driverName = (await tryGetUserDisplayName(driverUserId)) ?? "";

    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);
    const rowIdx = await findMasterRowIndexByTransferId(
      transferId,
      accessToken
    );
    if (!rowIdx) throw new Error("transferId not found");

    await valuesUpdate(
      `${MASTER_TITLE}!L${rowIdx}:M${rowIdx}`,
      [[driverUserId, driverName]],
      accessToken
    );
  }

  static async markConfirmed(transferId: string): Promise<void> {
    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);

    const { rowIdx, row } = await getMasterRowWithIndex(transferId, accessToken);
    if (!rowIdx || !row) throw new Error("transferId not found");
    if (row.state !== "pending")
      throw new Error("Only pending transfers can be confirmed");

    await valuesUpdate(
      `${MASTER_TITLE}!N${rowIdx}:N${rowIdx}`,
      [["confirmed"]],
      accessToken
    );
  }

  //@requireAuth()
  static async cancelTransfer(transferId: string): Promise<void> {
    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);

    const auth = getContext().get("auth");
    const userId = "346402675442587254"//auth.sub as string;
    if (!userId) throw new Error("Anonymous");

    const { rowIdx, row } = await getMasterRowWithIndex(transferId, accessToken);
    if (!rowIdx || !row) throw new Error("transferId not found");
    if (row.customerId !== userId) throw new Error("Forbidden");
    if (row.state !== "pending")
      throw new Error("Only pending transfers can be canceled");

    await valuesUpdate(
      `${MASTER_TITLE}!N${rowIdx}:N${rowIdx}`,
      [["canceled"]],
      accessToken
    );
  }

  static async terminateTransfer(transferId: string): Promise<void> {
    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);

    const { rowIdx, row } = await getMasterRowWithIndex(transferId, accessToken);
    if (!rowIdx || !row) throw new Error("transferId not found");
    if (row.state === "complete")
      throw new Error("Cannot terminate a completed transfer");

    await valuesUpdate(
      `${MASTER_TITLE}!N${rowIdx}:N${rowIdx}`,
      [["terminated"]],
      accessToken
    );
  }

  static async markCompleted(transferId: string): Promise<void> {
    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);

    const { rowIdx, row } = await getMasterRowWithIndex(transferId, accessToken);
    if (!rowIdx || !row) throw new Error("transferId not found");
    if (row.state !== "pending" && row.state !== "confirmed") {
      throw new Error("Only pending or confirmed transfers can be completed");
    }

    await valuesUpdate(
      `${MASTER_TITLE}!N${rowIdx}:N${rowIdx}`,
      [["complete"]],
      accessToken
    );

    const yyyymm = monthKeyFromISO(row.rideDateISO);
    const monthlyTitle = await ensureMonthlyForUser(
      row.customerId,
      yyyymm,
      accessToken
    );

    const existingMonthlyRow = await findMonthlyRowIndexByTransferId(
      monthlyTitle,
      transferId,
      accessToken
    );

    if (existingMonthlyRow) {
      // Row already present → let Apps Script handle sorting/totals/borders/formatting
      await callAppsScriptForSheet(monthlyTitle);
      return;
    }

    // New monthly row
    const { values: existingJ } = await valuesGet(
      `${monthlyTitle}!J4:J`,
      accessToken
    );
    const currentCount = existingJ?.length
      ? existingJ.filter((r) => String(r?.[0] ?? "") !== "").length
      : 0;

    const nextIdx = currentCount + 1;
    const insertAtRow = 3 + nextIdx;

    const sheetId = await sheetIdByTitle(monthlyTitle, accessToken);
    await sheetsBatchUpdate(
      [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: insertAtRow - 1,
              endIndex: insertAtRow
            },
            inheritFromBefore: true
          }
        }
      ],
      accessToken
    );

    const argSep = await getFormulaArgSep(accessToken);
    const vals = monthlyRowFormulas_SQL(transferId, argSep, MASTER_TITLE);
    vals[0] = nextIdx;

    await valuesUpdate(
      `${monthlyTitle}!A${insertAtRow}:J${insertAtRow}`,
      [vals],
      accessToken
    );

    // Delegate sorting, totals, borders & formatting to Apps Script
    await callAppsScriptForSheet(monthlyTitle);
  }

  static async getTransfer(
    transferId: string
  ): Promise<TransferRow | null> {
    const accessToken = await googleAccessToken();
    const { row } = await getMasterRowWithIndex(transferId, accessToken);
    return row ?? null;
  }

  static async listTransfers(opts?: {
    customerId?: string;
    driverId?: string;
    state?: TransferState;
    fromDateISO?: string;
    toDateISO?: string;
  }): Promise<TransferRow[]> {
    const accessToken = await googleAccessToken();
    const range = `${MASTER_TITLE}!A2:${colLetter(MASTER_HEADERS.length)}`;
    const { values } = await valuesGet(range, accessToken);
    const rows = (values ?? [])
      .map((r) => rowToTransfer(r))
      .filter(Boolean) as TransferRow[];
    return rows.filter((r) => {
      if (opts?.customerId && r.customerId !== opts.customerId) return false;
      if (opts?.driverId && r.driverId !== opts.driverId) return false;
      if (opts?.state && r.state !== opts.state) return false;
      if (opts?.fromDateISO && r.rideDateISO < opts.fromDateISO) return false;
      if (opts?.toDateISO && r.rideDateISO > opts.toDateISO) return false;
      return true;
    });
  }

  @requireAuth()
  static async getCustomerBookings(): Promise<TransferRow[]> {
    const auth = getContext().get("auth");
    // const userId = "346402675442587254"; //auth.sub as string;
    const userId = auth.sub;
    if (!userId) throw new Error("Anonymous");

    return TransferService.listTransfers({ customerId: userId });
  }

  static async getDriverTransfers(
    driverUserId: string,
    opts?: {
      state?: TransferState;
      fromDateISO?: string;
      toDateISO?: string;
    }
  ): Promise<TransferRow[]> {
    return TransferService.listTransfers({
      driverId: driverUserId,
      state: opts?.state,
      fromDateISO: opts?.fromDateISO,
      toDateISO: opts?.toDateISO
    });
  }

  static async getDriverRevenue(
    driverUserId: string,
    opts?: {
      state?: TransferState | "completeOrConfirmed";
      fromDateISO?: string;
      toDateISO?: string;
      includeVouchers?: boolean;
    }
  ): Promise<{
    driverUserId: string;
    currency: "EUR";
    total: () => Promise<number>;
    count: () => Promise<number>;
  }> {
    const stateFilter = opts?.state ?? "complete";

    const compute = async () => {
      const rows = await TransferService.listTransfers({
        driverId: driverUserId,
        fromDateISO: opts?.fromDateISO,
        toDateISO: opts?.toDateISO
      });

      const eligible = rows.filter((r) => {
        const stateOk =
          stateFilter === "completeOrConfirmed"
            ? r.state === "complete" || r.state === "confirmed"
            : r.state === stateFilter;
        if (!stateOk) return false;
        if (!opts?.includeVouchers && r.payment === "Gutschein") return false;
        return typeof r.amountEUR === "number";
      });

      const total = eligible.reduce(
        (sum, r) => sum + (r.amountEUR ?? 0),
        0
      );

      return {
        total,
        count: eligible.length
      };
    };

    let cachePromise: Promise<{ total: number; count: number }> | null = null;
    const getComputed = () => {
      if (!cachePromise) {
        cachePromise = compute();
      }
      return cachePromise;
    };

    return {
      driverUserId,
      currency: "EUR" as const,
      total: async () => (await getComputed()).total,
      count: async () => (await getComputed()).count
    };
  }

  static async syncMonthlySheet(
    userId: string,
    yyyymm: string
  ): Promise<void> {
    const accessToken = await googleAccessToken();
    await ensureMaster(accessToken);

    const monthlyTitle = await ensureMonthlyForUser(
      userId,
      yyyymm,
      accessToken,
      { wipe: true }
    );

    const all = await TransferService.listTransfers({
      customerId: userId,
      state: "complete"
    });
    const monthRows = all.filter(
      (r) => monthKeyFromISO(r.rideDateISO) === yyyymm
    );

    const argSep = await getFormulaArgSep(accessToken);
    const payload: SheetValue[][] = monthRows.map((r, i) => {
      const vals = monthlyRowFormulas_SQL(r.transferId, argSep, MASTER_TITLE);
      vals[0] = i + 1;
      return vals;
    });

    if (payload.length) {
      const endRow = 3 + payload.length;
      await valuesUpdate(
        `${monthlyTitle}!A4:J${endRow}`,
        payload,
        accessToken
      );
    }

    // Delegate sorting, totals, borders & formatting to Apps Script
    await callAppsScriptForSheet(monthlyTitle);
  }
}
