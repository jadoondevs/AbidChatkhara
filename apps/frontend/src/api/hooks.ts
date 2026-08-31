import type { Paisa } from '@pos/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { api, query, type RequestOptions } from './client.js';
import type {
  Category,
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

export function useUsers(): UseQueryResult<User[]> {
  return useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
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
  waiterId?: number;
  beneficiaryPersonId?: number;
}

export function useCreateOrder(): UseMutationResult<OrderSummary, Error, CreateOrderVars> {
  return useOrderMutation((vars: CreateOrderVars) => api.post<OrderSummary>('/api/orders', vars));
}

export function useAddLine(): UseMutationResult<OrderDetail, Error, { orderId: number; itemId: number; qty: number; modifierIds?: number[] }> {
  return useOrderMutation(({ orderId, ...body }) => api.post<OrderDetail>(`/api/orders/${orderId}/lines`, body));
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

export function useRecordPayment(): UseMutationResult<
  RecordPaymentResult,
  Error,
  { orderId: number; paymentMethodId: number; amountMinor: Paisa; referenceNo?: string; tenderedMinor?: Paisa }
> {
  return useOrderMutation(({ orderId, ...body }) => api.post<RecordPaymentResult>(`/api/orders/${orderId}/payments`, body));
}

export function useSettleConsumption(): UseMutationResult<
  SettleConsumptionResult,
  Error,
  { orderId: number; settlementType?: SettlementType; paymentMethodId?: number; referenceNo?: string }
> {
  return useOrderMutation(({ orderId, ...body }) => api.post<SettleConsumptionResult>(`/api/orders/${orderId}/settle-consumption`, body));
}

export function usePrintBill(): UseMutationResult<{ ok: true }, Error, number> {
  return useMutation({ mutationFn: (orderId: number) => api.post<{ ok: true }>(`/api/orders/${orderId}/print-bill`) });
}

export function usePrintReceipt(): UseMutationResult<{ ok: true }, Error, number> {
  return useMutation({ mutationFn: (orderId: number) => api.post<{ ok: true }>(`/api/orders/${orderId}/print-receipt`) });
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

export interface DateRange {
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
