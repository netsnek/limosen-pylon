// src/d1.service.ts
import { getEnv, requireAuth } from "@getcronit/pylon";
import type { D1Database } from "@cloudflare/workers-types";
import { InvalidInputError } from "./errors/general.errors";
import { getPrisma } from "./prisma";
import type { Prisma } from "@prisma/client";

// Local TransferState type (avoid importing from @prisma/client)
export type TransferState =
  | "pending"
  | "confirmed"
  | "complete"
  | "canceled"
  | "terminated";

/**
 * Input shape for creating/upserting a transfer in D1 via Prisma.
 * Mirrors your TransferInput/TransferRow fields.
 */
export type D1TransferInput = {
  transferId: string;           // required for upsert/update
  rideDateISO: string;          // YYYY-MM-DD
  rideTime: string;             // HH:mm
  pickup: string;
  dropoff: string;
  roomOrName?: string;
  vehicle?: string;
  amountEUR?: number | null;
  payment?: string | null;

  customerId: string;
  customerName?: string | null;

  driverId?: string | null;
  driverName?: string | null;

  state: TransferState;
  requestedAtISO: string;       // ISO string
};

export class D1Service {
  // ---------- helpers ----------
  private static env() {
    return getEnv() as any as { DB: D1Database };
  }

  private static prisma() {
    const env = D1Service.env();
    if (!env?.DB) {
      throw new InvalidInputError('D1 binding "DB" fehlt in env');
    }
    return getPrisma(env);
  }

  private static assertNonEmptyString(value: unknown, label: string) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidInputError(`${label} is required`);
    }
  }

  // --------------------------------------------------
  // READ
  // --------------------------------------------------

  @requireAuth()
  static async getD1Transfer(transferId: string) {
    D1Service.assertNonEmptyString(transferId, "transferId");
    const prisma = D1Service.prisma();
    return prisma.transfer.findUnique({
      where: { transferId }
    });
  }

  /**
   * Fetch all transfers from D1.
   * Sorted like your sheets: by rideDateISO then rideTime.
   */
  //@requireAuth()
  static async getD1AllTransfers(args?: {
    state?: TransferState;
    customerId?: string;
    driverId?: string;
    fromDateISO?: string; // YYYY-MM-DD inclusive
    toDateISO?: string;   // YYYY-MM-DD inclusive
    take?: number;
    skip?: number;
  }) {
    const prisma = D1Service.prisma();

    const where: Prisma.TransferWhereInput = {};

    if (args?.state) where.state = args.state as any;
    if (args?.customerId) where.customerId = args.customerId;
    if (args?.driverId) where.driverId = args.driverId;

    if (args?.fromDateISO || args?.toDateISO) {
      where.rideDateISO = {};
      if (args.fromDateISO) (where.rideDateISO as any).gte = args.fromDateISO;
      if (args.toDateISO) (where.rideDateISO as any).lte = args.toDateISO;
    }

    return prisma.transfer.findMany({
      where,
      orderBy: [
        { rideDateISO: "asc" },
        { rideTime: "asc" }
      ],
      take: args?.take,
      skip: args?.skip
    });
  }

  // --------------------------------------------------
  // WRITE
  // --------------------------------------------------

  /**
   * Create a transfer in D1 (throws if already exists).
   * Mostly for direct GraphQL usage.
   */
  @requireAuth()
  static async createD1Transfer(data: D1TransferInput) {
    D1Service.assertNonEmptyString(data.rideDateISO, "rideDateISO");
    D1Service.assertNonEmptyString(data.rideTime, "rideTime");
    D1Service.assertNonEmptyString(data.pickup, "pickup");
    D1Service.assertNonEmptyString(data.dropoff, "dropoff");
    D1Service.assertNonEmptyString(data.customerId, "customerId");
    D1Service.assertNonEmptyString(data.transferId, "transferId");

    const prisma = D1Service.prisma();

    return prisma.transfer.create({
      data: {
        transferId: data.transferId,

        rideDateISO: data.rideDateISO,
        rideTime: data.rideTime,
        pickup: data.pickup,
        dropoff: data.dropoff,
        roomOrName: data.roomOrName ?? null,
        vehicle: data.vehicle ?? null,
        amountEUR: typeof data.amountEUR === "number" ? data.amountEUR : null,
        payment: data.payment ?? null,

        customerId: data.customerId,
        customerName: data.customerName ?? null,

        driverId: data.driverId ?? null,
        driverName: data.driverName ?? null,

        state: (data.state ?? "pending") as any,

        requestedAtISO: data.requestedAtISO
          ? new Date(data.requestedAtISO)
          : undefined
      }
    });
  }

  /**
   * Upsert a full transfer row into D1.
   * Used by TransferService to keep D1 in sync with Sheets.
   */
  static async upsertD1Transfer(data: D1TransferInput) {
    // NOTE: no decorator here so we can call it from
    // non-decorated TransferService methods without changing auth behavior.
    D1Service.assertNonEmptyString(data.transferId, "transferId");

    const prisma = D1Service.prisma();

    const createData: Prisma.TransferCreateInput = {
      transferId: data.transferId,

      rideDateISO: data.rideDateISO,
      rideTime: data.rideTime,
      pickup: data.pickup,
      dropoff: data.dropoff,
      roomOrName: data.roomOrName ?? null,
      vehicle: data.vehicle ?? null,
      amountEUR: typeof data.amountEUR === "number" ? data.amountEUR : null,
      payment: data.payment ?? null,

      customerId: data.customerId,
      customerName: data.customerName ?? null,

      driverId: data.driverId ?? null,
      driverName: data.driverName ?? null,

      state: data.state as any,
      requestedAtISO: data.requestedAtISO
        ? new Date(data.requestedAtISO)
        : undefined
    };

    const updateData: Prisma.TransferUpdateInput = {
      rideDateISO: createData.rideDateISO,
      rideTime: createData.rideTime,
      pickup: createData.pickup,
      dropoff: createData.dropoff,
      roomOrName: createData.roomOrName,
      vehicle: createData.vehicle,
      amountEUR: createData.amountEUR,
      payment: createData.payment,

      customerId: createData.customerId,
      customerName: createData.customerName,

      driverId: createData.driverId,
      driverName: createData.driverName,

      state: createData.state as any,

      // allow override on sync if provided
      ...(data.requestedAtISO ? { requestedAtISO: createData.requestedAtISO } : {})
    };

    return prisma.transfer.upsert({
      where: { transferId: data.transferId },
      create: createData,
      update: updateData
    });
  }

  /**
   * Patch-update a transfer in D1.
   */
  static async updateD1Transfer(
    transferId: string,
    patch: Partial<{
      rideDateISO: string;
      rideTime: string;
      pickup: string;
      dropoff: string;
      roomOrName: string | null;
      vehicle: string | null;
      amountEUR: number | null;
      payment: string | null;

      customerId: string;
      customerName: string | null;

      driverId: string | null;
      driverName: string | null;

      state: TransferState;
      requestedAtISO: string;
    }>
  ) {
    D1Service.assertNonEmptyString(transferId, "transferId");
    const prisma = D1Service.prisma();

    const data: Prisma.TransferUpdateInput = {
      ...(patch.rideDateISO !== undefined ? { rideDateISO: patch.rideDateISO } : {}),
      ...(patch.rideTime !== undefined ? { rideTime: patch.rideTime } : {}),
      ...(patch.pickup !== undefined ? { pickup: patch.pickup } : {}),
      ...(patch.dropoff !== undefined ? { dropoff: patch.dropoff } : {}),
      ...(patch.roomOrName !== undefined ? { roomOrName: patch.roomOrName } : {}),
      ...(patch.vehicle !== undefined ? { vehicle: patch.vehicle } : {}),
      ...(patch.amountEUR !== undefined ? { amountEUR: patch.amountEUR } : {}),
      ...(patch.payment !== undefined ? { payment: patch.payment } : {}),

      ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
      ...(patch.customerName !== undefined ? { customerName: patch.customerName } : {}),

      ...(patch.driverId !== undefined ? { driverId: patch.driverId } : {}),
      ...(patch.driverName !== undefined ? { driverName: patch.driverName } : {}),

      ...(patch.state !== undefined ? { state: patch.state as any } : {}),
      ...(patch.requestedAtISO !== undefined
        ? { requestedAtISO: new Date(patch.requestedAtISO) }
        : {})
    };

    return prisma.transfer.update({
      where: { transferId },
      data
    });
  }
}
