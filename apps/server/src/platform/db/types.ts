import type { BillingTables } from '../../billing/tables.js';
import type { CatalogTables } from '../../catalog/tables.js';
import type { ConsumptionTables } from '../../consumption/tables.js';
import type { GratuityTables } from '../../gratuity/tables.js';
import type { IdentityTables } from '../../identity/tables.js';
import type { OrderingTables } from '../../ordering/tables.js';
import type { PartnersTables } from '../../partners/tables.js';
import type { ShiftsTables } from '../../shifts/tables.js';
import type { TaxTables } from '../../tax/tables.js';
import type { SyncQueueTables } from '../sync-queue/tables.js';

/**
 * The single Kysely `Database` type, composed from each module's own
 * table interfaces. Kysely needs one schema type to query against, but
 * each module still owns and exports only its own slice — this file is
 * the one place they're stitched together, and it grows by one `extends`
 * per module, never by a module reaching into another's tables.
 */
export interface Database
  extends IdentityTables,
    SyncQueueTables,
    CatalogTables,
    OrderingTables,
    PartnersTables,
    BillingTables,
    GratuityTables,
    ConsumptionTables,
    TaxTables,
    ShiftsTables {}
