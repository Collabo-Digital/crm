// Rewrite automations saved by the first Instagram engine into the builder's
// current definition format.
//
// The first engine (feat/whats-app-automation, before the messaging-updates
// merge) saved two shapes the current parser refuses or reads differently:
//   - a DM trigger as `event: 'dm'`; the current name is `message`;
//   - the first send_message after a comment trigger was sent as the one
//     private reply Meta allows per comment. The current engine sends that
//     only from a `reply_comment` step, so the step becomes one (mode
//     private). Later send_message steps stay DMs, as they were.
//     reply_comment has no `product` field, so the product name the old step
//     filled {{product_name}} from is written into the message text.
// A legacy definition is one with a send_message step that has no `kind`
// (the current builder always writes one).
//
// Both automations.definition (the draft) and every automation_versions
// definition (what runs read) are rewritten. Trigger rows need nothing: their
// trigger_type strings (instagram.comment / instagram.message) are the same.
//
// Dry run by default. Nothing is written without --apply.
//
//   npm run db:fix:convert-legacy-automations -- --apply

try {
  require('dotenv/config');
} catch {
  // Container: env already populated.
}

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const PRODUCT_NAME_PATTERN = /\{\{\s*product_name\s*\}\}/g;
const prisma = new PrismaClient();

function isLegacy(definition) {
  const steps = definition && Array.isArray(definition.steps) ? definition.steps : [];
  return steps.some((s) => s.type === 'send_message' && !(s.config && 'kind' in s.config));
}

function convert(definition) {
  const [trigger, ...actions] = definition.steps;
  const triggerConfig = { ...trigger.config };
  if (triggerConfig.event === 'dm') triggerConfig.event = 'message';
  const isComment = triggerConfig.event === 'comment';

  let sawSend = false;
  const converted = actions.map((step) => {
    if (step.type !== 'send_message') return step;
    const isFirstSend = !sawSend;
    sawSend = true;
    if (isComment && isFirstSend) {
      const product = String(step.config.product ?? '');
      const message = String(step.config.message ?? '').replace(PRODUCT_NAME_PATTERN, product);
      return { id: step.id, type: 'reply_comment', config: { mode: 'private', message } };
    }
    return { ...step, config: { ...step.config, kind: 'text' } };
  });

  return { ...definition, steps: [{ ...trigger, config: triggerConfig }, ...converted] };
}

(async () => {
  const automations = await prisma.automation.findMany({
    select: { id: true, name: true, status: true, definition: true, versions: { select: { id: true, definition: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const writes = [];
  for (const automation of automations) {
    const targets = [
      { table: 'automation', id: automation.id, definition: automation.definition },
      ...automation.versions.map((v) => ({ table: 'version', id: v.id, definition: v.definition })),
    ].filter((t) => isLegacy(t.definition));
    if (targets.length === 0) continue;

    console.log(`\n${automation.name} (${automation.id}, ${automation.status})`);
    for (const target of targets) {
      const next = convert(target.definition);
      console.log(`  ${target.table} ${target.id}`);
      console.log(`    before: ${JSON.stringify(target.definition.steps.map((s) => [s.type, s.config.event ?? s.config.message ?? '']))}`);
      console.log(`    after:  ${JSON.stringify(next.steps.map((s) => [s.type, s.config.event ?? s.config.mode ?? s.config.kind ?? '']))}`);
      writes.push({ ...target, next });
    }
  }

  console.log(`\n${writes.length} definition(s) to rewrite.`);
  if (!APPLY) {
    console.log('Dry run: nothing written. Re-run with --apply to rewrite them.');
    return;
  }

  await prisma.$transaction(
    writes.map((w) =>
      w.table === 'automation'
        ? prisma.automation.update({ where: { id: w.id }, data: { definition: w.next } })
        : prisma.automationVersion.update({ where: { id: w.id }, data: { definition: w.next } }),
    ),
  );
  console.log('Rewritten.');
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
