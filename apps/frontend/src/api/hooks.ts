import type { Paisa } from '@pos/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { api, query, type RequestOptions } from './client.js';
import { completePrint } from './printing.js';
import type {
  AppSettings,
  BillTotals,
  Category,
  FloorBoard,
  PaymentAccount,
  OrderHistory,
  PartnerRecord,
  PaymentOption,
  PrintOutcome,
  PrinterSettings,
  ReceiptSettings,
  RestaurantSettings,
  ServiceChargeSettings,
  Role,
  RosterEntry,
  ConsumptionReport,
  DailySalesReport,
  ItemMixLine,
  MenuItem,
  Modifier,
  ModifierGroup,
  OrderDetail,
  OrderStatus,
  OrderSummary,
  OrderType,
  OwnershipShare,
  Partner,
  PartnerStatement,
  PaymentMethod,
  PaymentMethodKind,
  Person,
  PersonKind,
  MealPolicy,
  RecordPaymentResult,
  SettleConsumptionResult,
  SettlementType,
  Shift,
  TaxRule,
  User,
  VoidOrDiscountEntry,
  WaiterPayoutLine,
  ZReport,
} from './types.js';

/** Order lists refetch on an interval: the floor view is a live board of
 * what other terminals are doing, and this system deliberately has no
 * websocket/push channel — one server, one LAN, a short poll is the
 * simplest thing that keeps two tills honest about each other. */
const LIVE_REFETCH_MS = 4000;

// ---------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------

export function useUsers(includeInactive = false): UseQueryResult<User[]> {
  return useQuery({
    queryKey: ['users', includeInactive],
    queryFn: () => api.get<User[]>(`/api/users${query({ includeInactive })}`),
  });
}

/** Names for the floor board and the waiter picker. Uses the roster
 * rather than the manager-only user list, so a server signing in does
 * not fire a 403 on the home screen. */
export function useRoster(): UseQueryResult<RosterEntry[]> {
  return useQuery({ queryKey: ['roster'], queryFn: () => api.get<RosterEntry[]>('/api/roster') });
}

export function useCreateUser(): UseMutationResult<User, Error, { name: string; username: string; password: string; role: Role }> {
  const invalidate = useInvalidateOnSuccess(['users']);
  return useMutation({ mutationFn: (body) => api.post<User>('/api/users', body), onSuccess: invalidate });
}

export function useUpdateUser(): UseMutationResult<
  User,
  Error,
  { id: number; name?: string; username?: string; role?: Role; active?: boolean }
> {
  const invalidate = useInvalidateOnSuccess(['users']);
  return useMutation({ mutationFn: ({ id, ...body }) => api.patch<User>(`/api/users/${id}`, body), onSuccess: invalidate });
}

export function useSetUserPassword(): UseMutationResult<User, Error, { id: number; password: string }> {
  const invalidate = useInvalidateOnSuccess(['users']);
  return useMutation({ mutationFn: ({ id, password }) => api.put<User>(`/api/users/${id}/password`, { password }), onSuccess: invalidate });
}

// ---------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------

export function useCategories(includeInactive = false): UseQueryResult<Category[]> {
  return useQuery({
    queryKey: ['categories', includeInactive],
    queryFn: () => api.get<Category[]>(`/api/categories${query({ includeInactive })}`),
  });
}

export function useMenu(categoryId?: number): UseQueryResult<MenuItem[]> {
  return useQuery({
    queryKey: ['menu', categoryId ?? null],
    queryFn: () => api.get<MenuItem[]>(`/api/menu${query({ categoryId })}`),
  });
}

export function useItemModifierGroups(itemId: number | null): UseQueryResult<ModifierGroup[]> {
  return useQuery({
    queryKey: ['item-modifier-groups', itemId],
    queryFn: () => api.get<ModifierGroup[]>(`/api/items/${itemId}/modifier-groups`),
    enabled: itemId !== null,
  });
}

export function useModifiers(groupId?: number): UseQueryResult<Modifier[]> {
  return useQuery({
    queryKey: ['modifiers', groupId ?? null],
    queryFn: () => api.get<Modifier[]>(`/api/modifiers${query({ groupId })}`),
  });
}

export function useModifierGroups(): UseQueryResult<ModifierGroup[]> {
  return useQuery({ queryKey: ['modifier-groups'], queryFn: () => api.get<ModifierGroup[]>('/api/modifier-groups') });
}

// ---------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------

export function useOrders(statuses: OrderStatus[]): UseQueryResult<OrderSummary[]> {
  const status = statuses.join(',');
  return useQuery({
    queryKey: ['orders', status],
    queryFn: () => api.get<OrderSummary[]>(`/api/orders${query({ status })}`),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** The floor board's three lists, split by the server — see the note on
 * getFloorBoard. One request, one consistent snapshot, so the lists can
 * never disagree with each other about where an order is. */
export function useFloorBoard(): UseQueryResult<FloorBoard> {
  return useQuery({
    queryKey: ['orders', 'board'],
    queryFn: () => api.get<FloorBoard>('/api/orders/board'),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** The complete record of one order, as it happened — see the server's
 * getOrderHistory. Read-only; opening an order changes nothing. */
export function useOrderHistory(orderId: number | null): UseQueryResult<OrderHistory> {
  return useQuery({
    queryKey: ['order-history', orderId],
    queryFn: () => api.get<OrderHistory>(`/api/orders/${orderId}/history`),
    enabled: orderId !== null,
  });
}

/** What this order WILL total if billed with the given service charge —
 * computed by the same server code that will do the billing, so the
 * figure on screen is the figure that prints. */
export function useBillPreview(orderId: number | null, serviceChargeMinor?: Paisa): UseQueryResult<BillTotals> {
  return useQuery({
    queryKey: ['bill-preview', orderId, serviceChargeMinor ?? null],
    queryFn: () =>
      // No override means "what would the configured rule charge?",
      // which is what the bill screen asks before a cashier touches
      // anything.
      api.get<BillTotals>(`/api/orders/${orderId}/bill-preview${query(serviceChargeMinor === undefined ? {} : { serviceChargeMinor })}`),
    enabled: orderId !== null,
  });
}

export function useOrder(orderId: number | null): UseQueryResult<OrderDetail> {
  return useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get<OrderDetail>(`/api/orders/${orderId}`),
    enabled: orderId !== null,
  });
}

/** Anything that changes an order invalidates both the order itself and
 * every list it might appear in — the floor view is always live. */
function useOrderMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>): UseMutationResult<TData, Error, TVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['order'] });
    },
  });
}

export interface CreateOrderVars {
  orderType: OrderType;
  channel?: 'staff_meal' | 'owner_meal';
  tableLabel?: string;
  customerName?: string;
  customerPhone?: string;
  waiterId?: number;
  beneficiaryPersonId?: number;
}

export function useCreateOrder(): UseMutationResult<OrderSummary, Error, CreateOrderVars> {
  return useOrderMutation((vars: CreateOrderVars) => api.post<OrderSummary>('/api/orders', vars));
}

export function useAddLine(): UseMutationResult<
  OrderDetail,
  Error,
  { orderId: number; itemId: number; qty: number; modifierIds?: number[]; note?: string }
> {
  return useOrderMutation(({ orderId, ...body }) => api.post<OrderDetail>(`/api/orders/${orderId}/lines`, body));
}

/** Who the order is for. Both fields optional: saving a phone number
 * must not require re-sending the name. */
export function useSetOrderCustomer(): UseMutationResult<OrderDetail, Error, { orderId: number; customerName?: string; customerPhone?: string }> {
  return useOrderMutation(({ orderId, ...body }) => api.patch<OrderDetail>(`/api/orders/${orderId}/customer`, body));
}

/** What the kitchen is told about one line. An empty string clears it. */
export function useSetLineNote(): UseMutationResult<OrderDetail, Error, { orderId: number; lineId: number; note: string }> {
  return useOrderMutation(({ orderId, lineId, note }) => api.patch<OrderDetail>(`/api/orders/${orderId}/lines/${lineId}/note`, { note }));
}

export function useSetLineQty(): UseMutationResult<OrderDetail, Error, { orderId: number; lineId: number; qty: number }> {
  return useOrderMutation(({ orderId, lineId, qty }) => api.patch<OrderDetail>(`/api/orders/${orderId}/lines/${lineId}/qty`, { qty }));
}

/** Removing a mis-tap from a bill that has never been printed. The
 * server refuses once the order has been billed, at which point the UI
 * falls back to the manager-approved void below. */
export function useRemoveLine(): UseMutationResult<OrderDetail, Error, { orderId: number; lineId: number }> {
  return useOrderMutation(({ orderId, lineId }) => api.del<OrderDetail>(`/api/orders/${orderId}/lines/${lineId}`));
}

export function useVoidLine(): UseMutationResult<OrderDetail, Error, { orderId: number; lineId: number; reason: string; token?: string }> {
  return useOrderMutation(({ orderId, lineId, reason, token }) => {
    const opts: RequestOptions = token !== undefined ? { token } : {};
    return api.post<OrderDetail>(`/api/orders/${orderId}/lines/${lineId}/void`, { reason }, opts);
  });
}

export function useSetDiscount(): UseMutationResult<OrderDetail, Error, { orderId: number; discountMinor: Paisa; reason?: string }> {
  return useOrderMutation(({ orderId, ...body }) => api.patch<OrderDetail>(`/api/orders/${orderId}/discount`, body));
}

export function useBillOrder(): UseMutationResult<OrderDetail, Error, { orderId: number; serviceChargeMinor?: Paisa }> {
  return useOrderMutation(({ orderId, serviceChargeMinor }) =>
    api.post<OrderDetail>(`/api/orders/${orderId}/bill`, serviceChargeMinor === undefined ? {} : { serviceChargeMinor }),
  );
}

export function useReopenOrder(): UseMutationResult<OrderDetail, Error, { orderId: number; token?: string }> {
  return useOrderMutation(({ orderId, token }) => {
    const opts: RequestOptions = token !== undefined ? { token } : {};
    return api.post<OrderDetail>(`/api/orders/${orderId}/reopen`, undefined, opts);
  });
}

export function useVoidOrder(): UseMutationResult<OrderDetail, Error, { orderId: number; reason: string; token?: string }> {
  return useOrderMutation(({ orderId, reason, token }) => {
    const opts: RequestOptions = token !== undefined ? { token } : {};
    return api.post<OrderDetail>(`/api/orders/${orderId}/void`, { reason }, opts);
  });
}

// ---------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------

export function usePaymentMethods(includeInactive = false): UseQueryResult<PaymentMethod[]> {
  return useQuery({
    queryKey: ['payment-methods', includeInactive],
    queryFn: () => api.get<PaymentMethod[]>(`/api/payment-methods${query({ includeInactive })}`),
  });
}

export function usePaymentAccounts(paymentMethodId?: number, includeInactive = false): UseQueryResult<PaymentAccount[]> {
  return useQuery({
    queryKey: ['payment-accounts', paymentMethodId ?? null, includeInactive],
    queryFn: () => api.get<PaymentAccount[]>(`/api/payment-accounts${query({ paymentMethodId, includeInactive })}`),
  });
}

export function useCreatePaymentAccount(): UseMutationResult<
  PaymentAccount,
  Error,
  { paymentMethodId: number; label: string; accountTitle?: string; accountNumber?: string; bankName?: string }
> {
  const invalidate = useInvalidateOnSuccess(['payment-accounts']);
  return useMutation({ mutationFn: (body) => api.post<PaymentAccount>('/api/payment-accounts', body), onSuccess: invalidate });
}

export function useUpdatePaymentAccount(): UseMutationResult<
  PaymentAccount,
  Error,
  { id: number; label?: string; accountTitle?: string; accountNumber?: string; bankName?: string; active?: boolean }
> {
  const invalidate = useInvalidateOnSuccess(['payment-accounts']);
  return useMutation({
    mutationFn: ({ id, ...body }) => api.patch<PaymentAccount>(`/api/payment-accounts/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useRecordPayment(): UseMutationResult<
  RecordPaymentResult,
  Error,
  {
    orderId: number;
    paymentMethodId: number;
    amountMinor: Paisa;
    referenceNo?: string;
    paymentAccountId?: number;
    tenderedMinor?: Paisa;
  }
> {
  return useOrderMutation(({ orderId, ...body }) => api.post<RecordPaymentResult>(`/api/orders/${orderId}/payments`, body));
}

export function useSettleConsumption(): UseMutationResult<
  SettleConsumptionResult,
  Error,
  { orderId: number; settlementType?: SettlementType; paymentMethodId?: number; referenceNo?: string; paymentAccountId?: number }
> {
  return useOrderMutation(({ orderId, ...body }) => api.post<SettleConsumptionResult>(`/api/orders/${orderId}/settle-consumption`, body));
}

/** What each payment method can accept right now — see PaymentOption. */
export function usePaymentOptions(): UseQueryResult<PaymentOption[]> {
  return useQuery({ queryKey: ['payment-options'], queryFn: () => api.get<PaymentOption[]>('/api/payment-options') });
}

/**
 * Printing always succeeds as far as the server is concerned: it either
 * printed to the thermal printer or handed back the ticket as HTML.
 * `completePrint` then opens the browser's print dialog for the second
 * case (api/printing.ts), so a caller gets one promise for "the ticket
 * has been dealt with" however this till prints.
 */
export function usePrintBill(): UseMutationResult<'thermal' | 'fallback', Error, number> {
  return useMutation({
    mutationFn: async (orderId: number) => completePrint(await api.post<PrintOutcome>(`/api/orders/${orderId}/print-bill`)),
  });
}

export function usePrintReceipt(): UseMutationResult<'thermal' | 'fallback', Error, number> {
  return useMutation({
    mutationFn: async (orderId: number) => completePrint(await api.post<PrintOutcome>(`/api/orders/${orderId}/print-receipt`)),
  });
}

// ---------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------

export function usePartners(includeInactive = false): UseQueryResult<Partner[]> {
  return useQuery({
    queryKey: ['partners', includeInactive],
    queryFn: () => api.get<Partner[]>(`/api/partners${query({ includeInactive })}`),
  });
}

export function useItemOwnership(itemId: number | null): UseQueryResult<OwnershipShare[]> {
  return useQuery({
    queryKey: ['item-ownership', itemId],
    queryFn: () => api.get<OwnershipShare[]>(`/api/items/${itemId}/ownership`),
    enabled: itemId !== null,
  });
}

export function useSetItemOwnership(): UseMutationResult<OwnershipShare[], Error, { itemId: number; split: OwnershipShare[] }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, split }) => api.put<OwnershipShare[]>(`/api/items/${itemId}/ownership`, { split }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['item-ownership'] }),
  });
}

// ---------------------------------------------------------------------
// Consumption (people)
// ---------------------------------------------------------------------

export function usePeople(kind?: PersonKind, includeInactive = false): UseQueryResult<Person[]> {
  return useQuery({
    queryKey: ['people', kind ?? null, includeInactive],
    queryFn: () => api.get<Person[]>(`/api/people${query({ kind, includeInactive })}`),
  });
}

// ---------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------

export function useTaxRules(includeInactive = false): UseQueryResult<TaxRule[]> {
  return useQuery({
    queryKey: ['tax-rules', includeInactive],
    queryFn: () => api.get<TaxRule[]>(`/api/tax-rules${query({ includeInactive })}`),
  });
}

// ---------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------

export function useOpenShift(): UseQueryResult<Shift | null> {
  return useQuery({ queryKey: ['shift', 'open'], queryFn: () => api.get<Shift | null>('/api/shifts/open') });
}

export function useZReport(shiftId: number | null): UseQueryResult<ZReport> {
  return useQuery({
    queryKey: ['z-report', shiftId],
    queryFn: () => api.get<ZReport>(`/api/shifts/${shiftId}/z-report`),
    enabled: shiftId !== null,
  });
}

export function usePayoutSheet(shiftId: number | null): UseQueryResult<WaiterPayoutLine[]> {
  return useQuery({
    queryKey: ['payout-sheet', shiftId],
    queryFn: () => api.get<WaiterPayoutLine[]>(`/api/shifts/${shiftId}/payout-sheet`),
    enabled: shiftId !== null,
  });
}

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------

/**
 * A report's date filter, in any of the three forms the server accepts
 * (see reporting/date-range.ts):
 *
 *   { date }            one calendar day
 *   { from, to }        calendar days, INCLUSIVE at both ends
 *   { fromInclusive, toExclusive }   exact instants
 *
 * The screens use `from`/`to`, because that is what the operator types
 * and what makes "the same day in both boxes" mean that day.
 */
export interface DateRange {
  date?: string;
  from?: string;
  to?: string;
  fromInclusive?: string;
  toExclusive?: string;
}

export function useDailySalesReport(range: DateRange): UseQueryResult<DailySalesReport> {
  return useQuery({
    queryKey: ['report', 'daily-sales', range],
    queryFn: () => api.get<DailySalesReport>(`/api/reports/daily-sales${query({ ...range })}`),
  });
}

export function usePartnerStatement(partnerId: number | null, range: DateRange): UseQueryResult<PartnerStatement> {
  return useQuery({
    queryKey: ['report', 'partner-statement', partnerId, range],
    queryFn: () => api.get<PartnerStatement>(`/api/reports/partners/${partnerId}/statement${query({ ...range })}`),
    enabled: partnerId !== null,
  });
}

export function useItemMixReport(range: DateRange): UseQueryResult<ItemMixLine[]> {
  return useQuery({
    queryKey: ['report', 'item-mix', range],
    queryFn: () => api.get<ItemMixLine[]>(`/api/reports/item-mix${query({ ...range })}`),
  });
}

export function useConsumptionReport(range: DateRange): UseQueryResult<ConsumptionReport> {
  return useQuery({
    queryKey: ['report', 'consumption', range],
    queryFn: () => api.get<ConsumptionReport>(`/api/reports/consumption${query({ ...range })}`),
  });
}

export function useServiceChargeReport(range: DateRange & { shiftId?: number }): UseQueryResult<WaiterPayoutLine[]> {
  return useQuery({
    queryKey: ['report', 'service-charge', range],
    queryFn: () => api.get<WaiterPayoutLine[]>(`/api/reports/service-charge${query({ ...range })}`),
  });
}

export function useVoidAndDiscountReport(range: DateRange & { actorId?: number }): UseQueryResult<VoidOrDiscountEntry[]> {
  return useQuery({
    queryKey: ['report', 'void-discount', range],
    queryFn: () => api.get<VoidOrDiscountEntry[]>(`/api/reports/void-and-discount${query({ ...range })}`),
  });
}

// ---------------------------------------------------------------------
// Config mutations shared by the admin screens
// ---------------------------------------------------------------------

export function useInvalidateOnSuccess(keys: string[]) {
  const queryClient = useQueryClient();
  return () => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

export function useCreateCategory(): UseMutationResult<Category, Error, { name: string; sortOrder?: number }> {
  const invalidate = useInvalidateOnSuccess(['categories', 'menu']);
  return useMutation({ mutationFn: (body) => api.post<Category>('/api/categories', body), onSuccess: invalidate });
}

export function useCreateItem(): UseMutationResult<MenuItem, Error, { categoryId: number; name: string }> {
  const invalidate = useInvalidateOnSuccess(['menu']);
  return useMutation({ mutationFn: (body) => api.post<MenuItem>('/api/items', body), onSuccess: invalidate });
}

export function useSetItemPrice(): UseMutationResult<unknown, Error, { itemId: number; priceMinor: Paisa }> {
  const invalidate = useInvalidateOnSuccess(['menu']);
  return useMutation({ mutationFn: ({ itemId, priceMinor }) => api.post(`/api/items/${itemId}/price`, { priceMinor }), onSuccess: invalidate });
}

export function useSetItemAvailability(): UseMutationResult<unknown, Error, { itemId: number; available: boolean }> {
  const invalidate = useInvalidateOnSuccess(['menu']);
  return useMutation({ mutationFn: ({ itemId, available }) => api.patch(`/api/items/${itemId}/availability`, { available }), onSuccess: invalidate });
}

export function useCreatePaymentMethod(): UseMutationResult<
  PaymentMethod,
  Error,
  {
    code: string;
    displayName: string;
    kind: PaymentMethodKind;
    printOnBill?: boolean;
    accountTitle?: string;
    accountNumber?: string;
    bankName?: string;
  }
> {
  const invalidate = useInvalidateOnSuccess(['payment-methods']);
  return useMutation({ mutationFn: (body) => api.post<PaymentMethod>('/api/payment-methods', body), onSuccess: invalidate });
}

export function useUpdatePaymentMethod(): UseMutationResult<PaymentMethod, Error, { id: number; active?: boolean; displayName?: string; printOnBill?: boolean }> {
  const invalidate = useInvalidateOnSuccess(['payment-methods']);
  return useMutation({ mutationFn: ({ id, ...body }) => api.patch<PaymentMethod>(`/api/payment-methods/${id}`, body), onSuccess: invalidate });
}

export function useCreatePerson(): UseMutationResult<Person, Error, { name: string; kind: PersonKind; mealPolicy: MealPolicy; mealDiscountBp?: number }> {
  const invalidate = useInvalidateOnSuccess(['people']);
  return useMutation({ mutationFn: (body) => api.post<Person>('/api/people', body), onSuccess: invalidate });
}

export function useUpdatePerson(): UseMutationResult<
  Person,
  Error,
  { id: number; name?: string; active?: boolean; mealPolicy?: MealPolicy; mealDiscountBp?: number }
> {
  const invalidate = useInvalidateOnSuccess(['people']);
  return useMutation({ mutationFn: ({ id, ...body }) => api.patch<Person>(`/api/people/${id}`, body), onSuccess: invalidate });
}

export function useCreatePartner(): UseMutationResult<Partner, Error, { name: string }> {
  const invalidate = useInvalidateOnSuccess(['partners']);
  return useMutation({ mutationFn: (body) => api.post<Partner>('/api/partners', body), onSuccess: invalidate });
}

export function useUpdatePartner(): UseMutationResult<Partner, Error, { id: number; name?: string; active?: boolean }> {
  const invalidate = useInvalidateOnSuccess(['partners', 'partner-record']);
  return useMutation({ mutationFn: ({ id, ...body }) => api.patch<Partner>(`/api/partners/${id}`, body), onSuccess: invalidate });
}

/** What a partner owns today, and what they have actually been credited
 * — at the share each sale was written at. */
export function usePartnerRecord(partnerId: number | null): UseQueryResult<PartnerRecord> {
  return useQuery({
    queryKey: ['partner-record', partnerId],
    queryFn: () => api.get<PartnerRecord>(`/api/partners/${partnerId}/record`),
    enabled: partnerId !== null,
  });
}

export function useOpenShiftMutation(): UseMutationResult<Shift, Error, { openingCashMinor: Paisa }> {
  const invalidate = useInvalidateOnSuccess(['shift']);
  return useMutation({ mutationFn: (body) => api.post<Shift>('/api/shifts', body), onSuccess: invalidate });
}

export function useCloseShiftMutation(): UseMutationResult<Shift, Error, { shiftId: number; countedCashMinor: Paisa }> {
  const invalidate = useInvalidateOnSuccess(['shift', 'z-report', 'payout-sheet']);
  return useMutation({
    mutationFn: ({ shiftId, countedCashMinor }) => api.post<Shift>(`/api/shifts/${shiftId}/close`, { countedCashMinor }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

/**
 * Restaurant identity and receipt wording. Readable by anyone signed in
 * — the header on every screen uses the restaurant's own name.
 *
 * `enabled` is required, not optional: the App shell calls this above
 * its own "no session yet" early return, so without it every visit to
 * the sign-in page would fire one guaranteed-401 request.
 */
export function useSettings(enabled: boolean): UseQueryResult<AppSettings> {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/api/settings'), enabled });
}

/** Admin-only, and deliberately a separate call: a network address is
 * infrastructure, not something a waiter's screen should ever hold. */
export function usePrinterSettings(enabled: boolean): UseQueryResult<PrinterSettings> {
  return useQuery({ queryKey: ['settings', 'printer'], queryFn: () => api.get<PrinterSettings>('/api/settings/printer'), enabled });
}

export function useSaveRestaurantSettings(): UseMutationResult<RestaurantSettings, Error, RestaurantSettings> {
  const invalidate = useInvalidateOnSuccess(['settings']);
  return useMutation({ mutationFn: (body) => api.put<RestaurantSettings>('/api/settings/restaurant', body), onSuccess: invalidate });
}

export function useServiceChargeSettings(): UseQueryResult<ServiceChargeSettings> {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/api/settings'),
    select: (settings) => settings.serviceCharge,
  });
}

export function useSaveServiceChargeSettings(): UseMutationResult<ServiceChargeSettings, Error, ServiceChargeSettings> {
  const invalidate = useInvalidateOnSuccess(['settings', 'bill-preview', 'order']);
  return useMutation({ mutationFn: (body) => api.put<ServiceChargeSettings>('/api/settings/service-charge', body), onSuccess: invalidate });
}

export function useSaveReceiptSettings(): UseMutationResult<ReceiptSettings, Error, ReceiptSettings> {
  const invalidate = useInvalidateOnSuccess(['settings']);
  return useMutation({ mutationFn: (body) => api.put<ReceiptSettings>('/api/settings/receipt', body), onSuccess: invalidate });
}

export function useSavePrinterSettings(): UseMutationResult<PrinterSettings, Error, PrinterSettings> {
  const invalidate = useInvalidateOnSuccess(['settings']);
  return useMutation({ mutationFn: (body) => api.put<PrinterSettings>('/api/settings/printer', body), onSuccess: invalidate });
}
