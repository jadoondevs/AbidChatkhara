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
  user: { id: number; name: string; username: string; role: Role };
}

/** Who is on today — names only, readable by anyone signed in. Not the
 * same as `User`, which is the admin's view and carries usernames. */
export interface RosterEntry {
  id: number;
  name: string;
  role: Role;
}

export interface User {
  id: number;
  name: string;
  username: string;
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

/**
 * NOTE: there is deliberately no `active` here. The `modifier` table has
 * no such column and `/api/modifiers` has never returned one — this type
 * used to claim it anyway, and because it arrived as `undefined`, every
 * `filter(m => m.active)` in the UI silently discarded every option.
 * That is what made a required modifier group unsatisfiable: the dialog
 * showed no choices, and the server then rejected the add.
 *
 * A modifier is removed by unlinking its group from the item, or by
 * deleting the modifier — not by a flag that does not exist.
 */
export interface Modifier {
  id: number;
  groupId: number;
  name: string;
  priceDeltaMinor: Paisa;
}

export interface OrderLineModifier {
  id: number;
  modifierId: number;
  modifierName: string;
  priceDeltaMinor: Paisa;
  grossMinor: Paisa;
  proratedDiscountMinor: Paisa;
  netSalesMinor: Paisa;
  allocationBaseMinor: Paisa;
}

export type VoidKind = 'correction' | 'void';

export interface OrderLine {
  id: number;
  /** What the item was called when it was sold — a snapshot, not a
   * lookup against today's menu. */
  itemName: string;
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
  voidKind: VoidKind | null;
  /** What the kitchen was told about this line. */
  note: string | null;
  modifiers: OrderLineModifier[];
}

export interface OrderSummary {
  id: number;
  invoiceNo: number | null;
  orderType: OrderType;
  channel: OrderChannel;
  tableLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  waiterId: number | null;
  beneficiaryPersonId: number | null;
  shiftId: number | null;
  openedAt: string;
  billedAt: string | null;
  firstBilledAt: string | null;
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
  /** The configured rate that produced it, or null when none did. */
  serviceChargeRateBp: number | null;
  roundingAdjustmentMinor: Paisa;
  totalMinor: Paisa;
  version: number;
}

export interface FloorOrder extends OrderSummary {
  /** Item lines, voided ones included. Zero means the order never
   * became one and can be deleted rather than voided. */
  lineCount: number;
  paidMinor: Paisa;
  balanceMinor: Paisa;
}

/** A row on the Orders screen: enough to recognise an order without a
 * second request per row. */
export interface OrderSearchResult extends OrderSummary {
  paidMinor: Paisa;
  balanceMinor: Paisa;
  lineCount: number;
  waiterName: string | null;
  settledByName: string | null;
}

export interface FloorBoard {
  open: FloorOrder[];
  awaitingPayment: FloorOrder[];
  completed: FloorOrder[];
}

export interface BillTotals {
  subtotalMinor: Paisa;
  orderDiscountMinor: Paisa;
  netSalesMinor: Paisa;
  taxMinor: Paisa;
  serviceChargeMinor: Paisa;
  serviceChargeRateBp: number | null;
  serviceChargeName: string;
  roundingAdjustmentMinor: Paisa;
  totalMinor: Paisa;
}

export interface HistoricalPayment {
  id: number;
  methodName: string;
  methodKind: string;
  amountMinor: Paisa;
  referenceNo: string | null;
  accountId: number | null;
  accountLabel: string | null;
  accountNumber: string | null;
  accountBankName: string | null;
  tenderedMinor: Paisa | null;
  changeMinor: Paisa | null;
  receivedAt: string;
  receivedByName: string | null;
  isRefund: boolean;
  reversedByPaymentId: number | null;
}

/** The complete record of one order, as it happened. */
export interface OrderHistory {
  order: OrderDetail;
  waiterName: string | null;
  openedByName: string | null;
  closedByName: string | null;
  beneficiaryName: string | null;
  payments: HistoricalPayment[];
  paidMinor: Paisa;
  balanceMinor: Paisa;
  changeGivenMinor: Paisa;
  partnerAllocations: {
    partnerId: number;
    partnerName: string;
    amountMinor: Paisa;
    shareBpSnapshot: number;
  }[];
}

export interface ServiceChargeSettings {
  enabled: boolean;
  rateBp: number;
  displayName: string;
  dineInOnly: boolean;
}

export interface PartnerRecord {
  partner: Partner;
  ownedItems: { itemId: number; itemName: string; shareBp: number }[];
  recentAllocations: {
    orderId: number;
    invoiceNo: number | null;
    closedAt: string | null;
    itemName: string;
    qty: number;
    shareBpSnapshot: number;
    amountMinor: Paisa;
    isReversal: boolean;
  }[];
  totalAllocatedMinor: Paisa;
}

export type PaymentAccountType = 'easypaisa' | 'bank' | 'other';

/** Where money actually goes. One method can have several. */
export interface PaymentAccount {
  id: number;
  paymentMethodId: number;
  accountType: PaymentAccountType;
  label: string;
  accountTitle: string | null;
  accountNumber: string | null;
  bankName: string | null;
  active: boolean;
  /** Whether these details print for a customer to pay into.
   * Independent of `active`. */
  printOnReceipt: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Everything the payment screen needs to decide what to offer for one
 * method. `blockedReason` is the server's own sentence — the screen
 * shows it rather than composing its own, so the block a cashier reads
 * is the rule the server will enforce.
 */
export interface PaymentOption {
  paymentMethodId: number;
  code: string;
  displayName: string;
  kind: PaymentMethodKind;
  requiresAccount: boolean;
  accounts: PaymentAccount[];
  blockedReason: string | null;
}

/** How a ticket was printed. `fallback` carries the ticket as HTML for
 * the browser's own print dialog — see api/printing.ts. */
export type PrintOutcome =
  | { method: 'thermal' }
  | { method: 'fallback'; reason: 'not_configured' | 'unreachable'; detail: string | null; html: string };

export interface RestaurantSettings {
  name: string;
  addressLine1: string;
  addressLine2: string;
  phone: string;
  registrationLine: string;
}

export interface ReceiptSettings {
  headerName: string;
  showAddress: boolean;
  showPhone: boolean;
  headerNote: string;
  footerMessage: string;
  footerNote: string;
  showOrderNumber: boolean;
  showTable: boolean;
  showWaiter: boolean;
  showPaymentAccounts: boolean;
  feedLines: number;
}

export interface PrinterSettings {
  host: string;
  port: number;
  enabled: boolean;
  /** 0 = leave the printer on its own setting; 1–8 = ESC/POS print
   * density. What makes ordinary receipt text dark. */
  densityLevel: number;
}

export interface AppSettings {
  restaurant: RestaurantSettings;
  receipt: ReceiptSettings;
  serviceCharge: ServiceChargeSettings;
}

export interface ConsumptionDetailLine {
  consumptionRecordId: number;
  orderId: number;
  invoiceNo: number | null;
  personId: number;
  personName: string;
  itemName: string;
  modifierNames: string;
  qty: number;
  menuValueMinor: Paisa;
  chargedMinor: Paisa;
  mealPolicy: string;
  settlementType: string | null;
  settlementStatus: string;
  consumedAt: string;
}

export interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
  paidMinor: Paisa;
  balanceMinor: Paisa;
}

/** What the customer paid WITH — a type of payment, nothing more.
 * Where the money went is a PaymentAccount. */
export interface PaymentMethod {
  id: number;
  code: string;
  displayName: string;
  kind: PaymentMethodKind;
  active: boolean;
  sortOrder: number;
}

export interface Payment {
  id: number;
  orderId: number;
  paymentMethodId: number;
  amountMinor: Paisa;
  referenceNo: string | null;
  paymentAccountId: number | null;
  tenderedMinor: Paisa | null;
  changeMinor: Paisa | null;
  receivedBy: number;
  receivedAt: string;
  reversedByPaymentId: number | null;
}

export interface RecordPaymentResult {
  payment: Payment;
  changeMinor: Paisa | null;
  appliedMinor: Paisa;
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
  /** Zero means it can be deleted rather than worked through. */
  lineCount: number;
}

export interface ZReport {
  shift: Shift;
  grossSalesMinor: Paisa;
  customerSalesMinor: Paisa;
  consumptionMinor: Paisa;
  combinedSalesMinor: Paisa;
  consumptionUnchargedMinor: Paisa;
  discountsGivenMinor: Paisa;
  voidedSalesMinor: Paisa;
  taxCollectedMinor: Paisa;
  serviceChargeCollectedMinor: Paisa;
  roundingAdjustmentMinor: Paisa;
  openingFloatMinor: Paisa;
  cashPaymentsMinor: Paisa;
  cashTenderedMinor: Paisa;
  changeGivenMinor: Paisa;
  nonCashPaymentsMinor: Paisa;
  expectedCashMinor: Paisa;
  countedCashMinor: Paisa | null;
  varianceMinor: Paisa | null;
  paymentMethodBreakdown: { paymentMethodId: number; paymentMethodName: string; totalMinor: Paisa }[];
}

export interface WaiterPayoutLine {
  waiterId: number;
  waiterName: string;
  totalMinor: Paisa;
}

export interface DailySalesReport {
  grossSalesMinor: Paisa;
  discountsMinor: Paisa;
  serviceChargeMinor: Paisa;
  totalCollectedMinor: Paisa;
  customerSalesMinor: Paisa;
  consumptionMinor: Paisa;
  combinedSalesMinor: Paisa;
  taxCollectedMinor: Paisa;
  serviceChargeByWaiter: WaiterPayoutLine[];
  roundingAdjustmentMinor: Paisa;
  paymentMethodBreakdown: { paymentMethodId: number; paymentMethodName: string; totalMinor: Paisa }[];
  /** Customer bills closed in the range. Staff and owner meals are
   * excluded — they are consumption, not trade. */
  orderCount: number;
  /** Takings by local hour, for the dashboard bars. Only hours that saw
   * a sale are present. */
  salesByHour: { hour: number; orderCount: number; totalMinor: Paisa }[];
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
  /** The sizes/add-ons this configuration was sold with (snapshot
   * names), or '' when sold plain. */
  modifierNames: string;
  /** The item name, plus " — <sizes>" when sold with modifiers — what to
   * show in the Item column. */
  variantName: string;
  categoryName: string | null;
  qty: number;
  netSalesMinor: Paisa;
  owners: { partnerId: number; partnerName: string; shareBp: number }[];
}

export interface ConsumptionReport {
  records: ConsumptionRecord[];
  lines: ConsumptionDetailLine[];
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
