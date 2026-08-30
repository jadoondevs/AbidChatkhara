import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

export interface ShiftTable {
  id: Generated<number>;
  opened_at: string;
  closed_at: string | null;
  opened_by: number;
  closed_by: number | null;
  opening_cash_minor: Paisa;
  counted_cash_minor: Paisa | null;
  expected_cash_minor: Paisa | null;
  variance_minor: Paisa | null;
}

export interface ShiftsTables {
  shift: ShiftTable;
}
