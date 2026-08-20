import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

/**
 * Every handler's module must be wired into AppModule.
 *
 * Bindings are created from the handlers DiscoveryService finds among
 * AppModule's providers. A handler in a module nobody imports is therefore
 * never discovered, no queue binding is made for its routing key, and the topic
 * exchange silently DISCARDS every message published to it — the message does
 * not fail, does not retry, and does not reach the dead-letter queue. There is
 * no trace of it anywhere.
 *
 * PaymentsModule was in exactly that state: `payment.refund_required` events
 * were published by the API, relayed to the exchange, and dropped. Refunds owed
 * to double-charged buyers went nowhere.
 *
 * Nothing else catches this. Each handler's own unit spec passes — the class is
 * correct in isolation; it is simply never reached. So the check is structural,
 * and it reads the filesystem rather than a hand-maintained list, because a
 * list is one more thing to forget to update alongside the module.
 */

const MODULES_DIR = join(__dirname, 'modules');

/** The module class each handler lives beside, e.g. `PaymentsModule`. */
function modulesOwningAHandler(): { feature: string; moduleClass: string }[] {
  const owners: { feature: string; moduleClass: string }[] = [];

  for (const feature of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue;
    const dir = join(MODULES_DIR, feature.name);
    const files = readdirSync(dir);

    const hasHandler = files.some(
      (f) => f.endsWith('.handler.ts') && !f.endsWith('.spec.ts'),
    );
    if (!hasHandler) continue;

    const moduleFile = files.find((f) => f.endsWith('.module.ts'));
    if (!moduleFile) continue;

    const source = readFileSync(join(dir, moduleFile), 'utf8');
    const declared = /export class (\w+Module)/.exec(source);
    if (declared)
      owners.push({ feature: feature.name, moduleClass: declared[1] });
  }
  return owners;
}

/** AppModule's `imports`, by class name, read without booting anything. */
function importedModuleNames(): string[] {
  const imported = (Reflect.getMetadata('imports', AppModule) ??
    []) as unknown[];
  return imported
    .map((m) => (typeof m === 'function' ? m.name : ''))
    .filter(Boolean);
}

describe('AppModule wiring', () => {
  const owners = modulesOwningAHandler();

  it('finds the feature modules that declare handlers', () => {
    // A guard on the guard: if the layout changes and this finds nothing, the
    // test below would pass vacuously and prove nothing.
    expect(owners.length).toBeGreaterThan(0);
  });

  it.each(owners)(
    'imports $moduleClass, so $feature handlers get a queue binding',
    ({ moduleClass }) => {
      expect(importedModuleNames()).toContain(moduleClass);
    },
  );
});
