import {PrismaClient} from '@prisma/client'
import {PrismaD1} from '@prisma/adapter-d1'
import type {D1Database} from '@cloudflare/workers-types'

type Env = { DB: D1Database }

// global cache across requests in same isolate
const g = globalThis as unknown as { __prisma?: PrismaClient }

export function getPrisma(env: Env) {
  if (!g.__prisma) {
    const adapter = new PrismaD1(env.DB)
    g.__prisma = new PrismaClient({ adapter })
  }
  return g.__prisma
}
