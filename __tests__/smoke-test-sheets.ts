// smoke-test-sheets.ts
import crypto from "crypto";
import fetch from "node-fetch"; // Node 18 has global fetch; import if you need

const CLIENT_EMAIL = process.env.GOOGLE_SHEETS_CLIENT_EMAIL!;
const PRIVATE_KEY = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
if (!CLIENT_EMAIL || !PRIVATE_KEY || !SPREADSHEET_ID) {
  throw new Error("Missing envs GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY / GOOGLE_SHEETS_SPREADSHEET_ID");
}

function b64url(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(PRIVATE_KEY);
  const jwt = `${unsigned}.${b64url(signature)}`;

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
  return j.access_token as string;
}

async function appendTestRow() {
  const token = await getAccessToken();
  const range = encodeURIComponent("AllRequests!A:A");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const now = new Date().toISOString();
  const row = [
    `tr_test_${Date.now()}`, // transferId
    "user_123",              // userId
    now.slice(0,10),         // rideDateISO
    "07:30",                 // rideTime
    "Hotel Hein",            // pickup
    "VIE",                   // dropoff
    "Zimmer 108 / Huber",    // roomOrName
    "Limousine",             // vehicle
    48.5,                    // amountEUR
    "Lieferschein",          // payment
    "",                      // driver (empty)
    "pending",               // state
    now                      // requestedAtISO
  ];

  const r = await fetch(url, {
    method: "POST",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: [row], majorDimension: "ROWS" })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Append error: ${r.status} ${JSON.stringify(j)}`);
  console.log("OK appended:", j.updates?.updatedRange || j);
}

appendTestRow().catch(e => { console.error(e); process.exit(1); });
