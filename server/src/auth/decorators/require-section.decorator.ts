import { SetMetadata } from '@nestjs/common';
import type { PermissionKey, SectionKey } from '../permissions';

export const REQUIRE_SECTION_KEY = 'requireSection';
export const SECTION_OR_PERMISSION_KEY = 'sectionOrPermission';

type SectionName = SectionKey extends `section.${infer S}` ? S : never;

/**
 * Tie a controller (or one handler) to an app section. `SectionAccessGuard`
 * lets the request through when the member may open ANY of the listed
 * sections — list several on a read that another section's screen depends on
 * (the order form's product picker, a customer's order history).
 *
 * A handler-level decorator replaces the class-level one. Call it with no
 * arguments to lift the requirement for shared reference data.
 */
export const RequireSection = (...sections: SectionName[]) =>
  SetMetadata(
    REQUIRE_SECTION_KEY,
    sections.map((s) => `section.${s}` as SectionKey),
  );

/**
 * Also open a route to a member who holds `key` without its section. The till
 * belongs to Orders, but a Cashier holds `pos.sell` and no Orders section, the
 * way a Packer holds `inventory.pack`. Members with the section pass as before.
 */
export const SectionOrPermission = (key: PermissionKey) =>
  SetMetadata(SECTION_OR_PERMISSION_KEY, key);
