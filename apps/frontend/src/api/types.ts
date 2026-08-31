import type { Paisa } from '@pos/shared';

/**
 * Hand-written mirrors of the API's own Zod response schemas. The server
 * owns those schemas; duplicating the shapes here (rather than importing
 * the server package) keeps the frontend from depending on server code,
 * which would drag Kysely, better-sqlite3 and Fastify into a browser
 * build. `@pos/shared` still supplies the one type that genuinely must
 * be identical on both sides — Paisa — so money is never a bare number
 * here either.
 */

export type Role = 'server' | 'cashier' | 'manager' | 'admin';
export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type OrderChannel = 'customer' | 'staff_meal' | 'owner_meal';
export type OrderStatus = 'open' | 'billed' | 'closed' | 'voided';
export type PaymentMethodKind = 'cash' | 'wallet' | 'bank_transfer' | 'card';
export type PersonKind = 'staff' | 'partner';
export type MealPolicy = 'free' | 'discounted' | 'full_price' | 'payroll_deduction';
export type SettlementType = 'house_expense' | 'payroll_deduction' | 'partner_personal';

export interface LoginResult {
  token: string;
  user: { id: number; name: string; role: Role };
}

export interface User {
  id: number;
  name: string;
  role: Role;
  active: boolean;
}

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface MenuItem {
  id: number;
  categoryId: number;
  name: string;
  active: boolean;
  priceMinor: Paisa | null;
  available: boolean;
}

export interface ModifierGroup {
  id: number;
  name: string;
  minSelect: number;
  maxSelect: number;
}

export interface Modifier {
  id: number;
  groupId: number;
  name: string;
  priceDeltaMinor: Paisa;
  active: boolean;
}

export interface OrderLineModifier {
  id: number;
  modifierId: number;
  priceDeltaMinor: Paisa;
  grossMinor: Paisa;
  proratedDiscountMinor: Paisa;
  netSalesMinor: Paisa;
  allocationBaseMinor: Paisa;
}

export interface OrderLine {
  id: number;
  itemId: number;
  qty: number;
  unitPriceMinor: Paisa;
  grossMinor: Paisa;
  proratedDiscountMinor: Paisa;
  netSalesMinor: Paisa;
  allocationBaseMinor: Paisa;
  voided: boolean;
  voidReason: string | null;
  voidApprovedBy: number | null;
  modifiers: OrderLineModifier[];
}

export interface OrderSummary {
  id: number;
  invoiceNo: number | null;
  orderType: OrderType;
  channel: OrderChannel;
  tableLabel: string | null;
  waiterId: number | null;
  beneficiaryPersonId: number | null;
  shiftId: number | null;
  openedAt: string;
  billedAt: string | null;
  closedAt: string | null;
  openedBy: number;
  closedBy: number | null;
  status: OrderStatus;
  subtotalMinor: Paisa;
  orderDiscountMinor: Paisa;
  discountReason: string | null;
  netSalesMinor: Paisa;
  taxMinor: Paisa;
  serviceChargeMinor: Paisa;
  roundingAdjustmentMinor: Paisa;
  totalMinor: Paisa;
  version: number;
}

export interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
}

export interface PaymentMethod {
  id: number;
  code: string;
  displayName: string;
  kind: PaymentMethodKind;
  active: boolean;
  sortOrder: number;
  printOnBill: boolean;
  accountTitle: string | null;
  accountNumber: string | null;
  bankName: string | null;
  instructionsLine: string | null;
}

export interface Payment {
  id: number;
  orderId: number;
  paymentMethodId: number;
  amountMinor: Paisa;
  referenceNo: string | null;
  receivedBy: number;
  receivedAt: string;
  reversedByPaymentId: number | null;
}

export interface RecordPaymentResult {
  payment: Payment;
  changeMinor: Paisa | null;
  orderClosed: boolean;
  order: OrderSummary;
  invoiceNo: number | null;
}

export interface ConsumptionRecord {
  id: number;
  orderId: number;
  personId: number;
  personName: string;
  policySnapshot: { mealPolicy: MealPolicy; mealDiscountBp: number };
  menuValueMinor: Paisa;
  chargedMinor: Paisa;
  settlementMinor: Paisa;
  settlementType: SettlementType | null;
  createdAt: string;
}

export interface SettleConsumptionResult {
  consumptionRecord: ConsumptionRecord;
  payment: Payment | null;
  order: OrderSummary;
  invoiceNo: number;
}

export interface Partner {
  id: number;
  name: string;
  active: boolean;
  joinedAt: string;
  leftAt: string | null;
}

export interface OwnershipShare {
  partnerId: number;
  shareBp: number;
}

export interface Person {
  id: number;
  name: string;
  kind: PersonKind;
  active: boolean;
  mealPolicy: MealPolicy;
  mealDiscountBp: number;
}

export interface TaxRule {
  id: number;
  name: string;
  rateBp: number;
  appliesToCategoryId: number | null;
  appliesToOrderType: OrderType | null;
  inclusive: boolean;
  validFrom: string;
  validTo: string | null;
  active: boolean;
}

export interface Shift {
  id: number;
  openedAt: string;
  closedAt: string | null;
  openedBy: number;
  closedBy: number | null;
  openingCashMinor: Paisa;
  countedCashMinor: Paisa | null;
  expectedCashMinor: Paisa | null;
  varianceMinor: Paisa | null;
}

export interface BlockingOrder {
  id: number;
  orderType: string;
  status: string;
  tableLabel: string | null;
}

export interface ZReport {
  shift: Shift;
  customerSalesMinor: Paisa;
  consumptionMinor: Paisa;
  combinedSalesMinor: Paisa;
  taxCollectedMinor: Paisa;
  serviceChargeCollectedMinor: Paisa;
  roundingAdjustmentMinor: Paisa;
  paymentMethodBreakdown: { paymentMethodId: number; paymentMethodName: string; totalMinor: Paisa }[];
}

export interface WaiterPayoutLine {
  waiterId: number;
  waiterName: string;
  totalMinor: Paisa;
}

export interface DailySalesReport {
  customerSalesMinor: Paisa;
  consumptionMinor: Paisa;
  combinedSalesMinor: Paisa;
  taxCollectedMinor: Paisa;
  serviceChargeByWaiter: WaiterPayoutLine[];
  roundingAdjustmentMinor: Paisa;
  paymentMethodBreakdown: { paymentMethodId: number; paymentMethodName: string; totalMinor: Paisa }[];
}

export interface PartnerStatement {
  partnerId: number;
  partnerName: string;
  totalAllocatedMinor: Paisa;
  customerSalesAllocatedMinor: Paisa;
  consumptionAllocatedMinor: Paisa;
  items: { itemId: number; itemName: string; qty: number; allocatedMinor: Paisa }[];
  reconciliation: { allocationBaseMinor: Paisa; totalAllocatedMinor: Paisa; varianceMinor: Paisa };
}

export interface ItemMixLine {
  itemId: number;
  itemName: string;
  qty: number;
  netSalesMinor: Paisa;
  owners: { partnerId: number; partnerName: string; shareBp: number }[];
}

export interface ConsumptionReport {
  records: ConsumptionRecord[];
  byPerson: { personId: number; personName: string; menuValueMinor: Paisa; chargedMinor: Paisa; settlementMinor: Paisa }[];
}

export interface VoidOrDiscountEntry {
  id: number;
  kind: 'void_line' | 'void_order' | 'discount';
  actorId: number | null;
  actorName: string | null;
  orderId: number | null;
  reason: string | null;
  discountMinor: Paisa | null;
  createdAt: string;
}
