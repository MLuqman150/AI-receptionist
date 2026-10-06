import "dotenv/config";
import { prisma } from "./db.js";
import { ingestDocument } from "./rag.js";

const HOURS = [
  { dayOfWeek: 1, openTime: "09:00", closeTime: "17:00" }, // Mon
  { dayOfWeek: 2, openTime: "09:00", closeTime: "17:00" },
  { dayOfWeek: 3, openTime: "09:00", closeTime: "17:00" },
  { dayOfWeek: 4, openTime: "09:00", closeTime: "17:00" },
  { dayOfWeek: 5, openTime: "09:00", closeTime: "15:00" }, // Fri, shorter
];

const DOCS: { source: string; content: string }[] = [
  {
    source: "hours-and-location",
    content: `Acme Dental Clinic is open Monday to Thursday 9am-5pm, and Friday 9am-3pm.
We are closed Saturday and Sunday.

We are located at 221B Main Street, Suite 4.`,
  },
  {
    source: "services-and-pricing",
    content: `We offer the following services:
- General checkup and cleaning: $80, 30 minutes
- Teeth whitening: $150, 45 minutes
- Cavity filling: $120, 30 minutes
- Root canal: $600, 90 minutes (requires a referral consultation first)

New patients get a free initial consultation.`,
  },
  {
    source: "policies",
    content: `Cancellation policy: appointments can be cancelled or rescheduled free of charge up to
24 hours before the appointment. Cancellations within 24 hours incur a $25 fee.

We accept most major insurance providers. Please bring your insurance card to your first visit.

Payment methods accepted: cash, credit card, and insurance direct billing.`,
  },
];

async function main() {
  console.log("Seeding business hours...");
  await prisma.businessHours.deleteMany();
  await prisma.businessHours.createMany({ data: HOURS });

  console.log("Ingesting knowledge base...");
  for (const doc of DOCS) {
    const count = await ingestDocument(doc.source, doc.content);
    console.log(`  - ${doc.source}: ${count} chunk(s)`);
  }

  console.log("Done. Remember to run sql/post_migrate_index.sql once for query performance.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
