import { z } from 'zod';
import { paisa, type Paisa } from './paisa.js';

/**
 * The one Zod schema for a money value anywhere an API request or
 * response carries one — every module needs this, so it's defined once
 * here rather than as a local `z.number().int()...transform(paisa)` at
 * each route. Validates to a non-negative integer, then brands it via
 * `paisa()` so the rest of the request handler works with a real `Paisa`
 * value instead of a bare number a stray `*`/`/` could slip past.
 *
 * Use `paisaSchema.min(negativeAllowedFloor)` sparingly for the few
 * fields that can legitimately be negative (e.g. a reversing allocation)
 * — most money fields (prices, amounts entered by staff) cannot be.
 */
export const paisaSchema: z.ZodType<Paisa, z.ZodTypeDef, number> = z
  .number()
  .int()
  .min(0)
  .transform((value) => paisa(value));
