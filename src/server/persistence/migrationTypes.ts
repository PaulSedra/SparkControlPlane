/**
 * @fileoverview Persistence types for applied database migrations.
 */

/** A migration version and checksum already applied to the control-plane schema. */
export interface AppliedMigration {
    checksum: string;
    version: string;
}
