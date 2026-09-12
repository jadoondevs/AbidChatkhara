import type { Generated } from 'kysely';

export interface RiderTable {
  id: Generated<number>;
  name: string;
  active: number;
  created_at: string;
}

export interface RidersTables {
  rider: RiderTable;
}
