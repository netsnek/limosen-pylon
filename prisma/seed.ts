import {PrismaClient} from '@prisma/client'
const db = new PrismaClient()

async function main() {
  await db.user.create({
    data: {
      name: 'kleberbaum',
      email: 'florian.kleber@netsnek.com',
      password: 'netsnek'
    }
  })
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => await db.$disconnect())
