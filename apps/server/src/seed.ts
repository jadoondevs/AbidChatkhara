import { paisa, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { createPaymentAccount, createPaymentMethod } from './billing/service.js';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  linkModifierGroup,
  setItemPrice,
} from './catalog/service.js';
import { createPerson } from './consumption/service.js';
import { createUser } from './identity/service.js';
import { createPartner, setItemOwnership, setModifierOwnership } from './partners/service.js';
import type { Database } from './platform/db/types.js';
import { saveSetting } from './settings/service.js';

/**
 * Populates a fresh database with a realistic-but-obviously-fictional
 * restaurant: a menu across four categories, three partners with a mix
 * of single-owner and shared items, staff on every different meal
 * policy, and the three payment methods (spec's definition of done).
 *
 * Every name here is invented. No real staff or partner names, no real
 * account numbers, no real printer address — this file is committed, so
 * nothing in it may be real (see the spec's own rule, and .gitignore).
 *
 * Passwords are the obvious sequential ones on purpose: this seeds a
 * demo or a test day, not a live till. Change them before the
 * restaurant opens.
 */
export interface SeedResult {
  readonly users: { admin: number; manager: number; cashier: number; waiterOne: number; waiterTwo: number };
  readonly usernames: { admin: string; manager: string; cashier: string; waiterOne: string; waiterTwo: string };
  readonly paymentAccounts: Record<string, number>;
  readonly partners: { alia: number; bilal: number; chandni: number };
  readonly paymentMethods: { cash: number; easypaisa: number; bankTransfer: number };
  readonly items: Record<string, number>;
  readonly modifiers: Record<string, number>;
  readonly people: Record<string, number>;
}

export async function seed(db: Kysely<Database>): Promise<SeedResult> {
  const existing = await db.selectFrom('user').select('id').executeTakeFirst();
  if (existing) throw new Error('refusing to seed: this database already has users');

  // The very first user has no actor to attribute it to — the one
  // legitimate `actorId: null` case in the system (see identity/).
  const admin = await createUser(db, { name: 'Amina Qureshi', username: 'amina.qureshi', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const actor = { actorId: admin.id, terminalId: 'seed' };

  const manager = await createUser(db, { name: 'Danish Raza', username: 'danish.raza', password: '2222', role: 'manager' }, actor);
  const cashier = await createUser(db, { name: 'Sana Iqbal', username: 'sana.iqbal', password: '3333', role: 'cashier' }, actor);
  const waiterOne = await createUser(db, { name: 'Faisal Ahmed', username: 'faisal.ahmed', password: '4444', role: 'server' }, actor);
  const waiterTwo = await createUser(db, { name: 'Hina Malik', username: 'hina.malik', password: '5555', role: 'server' }, actor);

  // ---- partners ----
  const alia = await createPartner(db, 'Alia Holdings', actor);
  const bilal = await createPartner(db, 'Bilal Foods', actor);
  const chandni = await createPartner(db, 'Chandni Kitchen Co', actor);

  // ---- menu ----
  const items: Record<string, number> = {};
  const addItem = async (categoryId: number, name: string, priceMinor: Paisa, ownership: { partnerId: number; shareBp: number }[]) => {
    const item = await createItem(db, { categoryId, name }, actor);
    await setItemPrice(db, item.id, priceMinor, actor);
    await setItemOwnership(db, item.id, ownership, actor);
    items[name] = item.id;
    return item;
  };

  const mains = await createCategory(db, { name: 'Karahi & Handi', sortOrder: 1 }, actor);
  const bbq = await createCategory(db, { name: 'BBQ', sortOrder: 2 }, actor);
  const rice = await createCategory(db, { name: 'Rice', sortOrder: 3 }, actor);
  const drinks = await createCategory(db, { name: 'Drinks', sortOrder: 4 }, actor);

  // Single-owner items.
  await addItem(mains.id, 'Chicken Karahi (full)', paisa(1_850_00), [{ partnerId: alia.id, shareBp: 10_000 }]);
  await addItem(mains.id, 'Mutton Karahi (full)', paisa(2_650_00), [{ partnerId: alia.id, shareBp: 10_000 }]);
  await addItem(drinks.id, 'Mineral water', paisa(80_00), [{ partnerId: chandni.id, shareBp: 10_000 }]);
  await addItem(drinks.id, 'Fresh lime', paisa(180_00), [{ partnerId: chandni.id, shareBp: 10_000 }]);

  // Shared items — the interesting allocation cases.
  await addItem(bbq.id, 'Seekh kebab (6 pcs)', paisa(950_00), [
    { partnerId: alia.id, shareBp: 5_000 },
    { partnerId: bilal.id, shareBp: 5_000 },
  ]);
  await addItem(bbq.id, 'Malai boti', paisa(1_100_00), [
    { partnerId: bilal.id, shareBp: 6_000 },
    { partnerId: chandni.id, shareBp: 4_000 },
  ]);
  // A three-way split with a remainder that has to land somewhere —
  // exactly the case docs/decisions/002 is about.
  await addItem(rice.id, 'Chicken Biryani', paisa(700_00), [
    { partnerId: alia.id, shareBp: 3_334 },
    { partnerId: bilal.id, shareBp: 3_333 },
    { partnerId: chandni.id, shareBp: 3_333 },
  ]);
  const raita = await addItem(rice.id, 'Mutton Pulao', paisa(1_250_00), [
    { partnerId: bilal.id, shareBp: 10_000 },
  ]);

  // ---- modifiers ----
  const modifiers: Record<string, number> = {};
  const spice = await createModifierGroup(db, { name: 'Spice level', minSelect: 1, maxSelect: 1 }, actor);
  for (const level of ['Mild', 'Medium', 'Extra hot']) {
    const modifier = await createModifier(db, { groupId: spice.id, name: level, priceDeltaMinor: paisa(0) }, actor);
    modifiers[level] = modifier.id;
  }
  await linkModifierGroup(db, items['Chicken Karahi (full)'] as number, spice.id, actor);
  await linkModifierGroup(db, items['Mutton Karahi (full)'] as number, spice.id, actor);

  const extras = await createModifierGroup(db, { name: 'Extras', minSelect: 0, maxSelect: 2 }, actor);
  const cheese = await createModifier(db, { groupId: extras.id, name: 'Extra cheese', priceDeltaMinor: paisa(150_00) }, actor);
  const extraRaita = await createModifier(db, { groupId: extras.id, name: 'Extra raita', priceDeltaMinor: paisa(60_00) }, actor);
  modifiers['Extra cheese'] = cheese.id;
  modifiers['Extra raita'] = extraRaita.id;
  await linkModifierGroup(db, raita.id, extras.id, actor);
  // One modifier owned separately from its item — the carve-out case
  // (docs/decisions/004): the cheese belongs to Chandni even though the
  // pulao it sits on belongs to Bilal.
  await setModifierOwnership(db, cheese.id, [{ partnerId: chandni.id, shareBp: 10_000 }], actor);

  // ---- restaurant settings ----
  // Obviously fictional, and obviously a placeholder: an operator who
  // never opens the Settings screen should see something on the receipt
  // that tells them to.
  await saveSetting(
    db,
    'restaurant',
    {
      name: 'Demo Restaurant — set your own name in Settings',
      addressLine1: '00 Example Road',
      addressLine2: 'Nowhere',
      phone: '000-0000000',
      registrationLine: '',
    },
    actor,
  );
  await saveSetting(
    db,
    'receipt',
    {
      headerName: '',
      showAddress: true,
      showPhone: true,
      headerNote: '',
      footerMessage: 'Thank you',
      footerNote: '',
      showOrderNumber: true,
      showTable: true,
      showWaiter: true,
      showPaymentAccounts: true,
      feedLines: 3,
    },
    actor,
  );

  // ---- payment methods ----
  const cash = await createPaymentMethod(db, { code: 'cash', displayName: 'Cash', kind: 'cash', sortOrder: 1 }, actor);
  const easypaisa = await createPaymentMethod(
    db,
    {
      code: 'easypaisa',
      displayName: 'Easypaisa',
      kind: 'wallet',
      sortOrder: 2,
      printOnBill: true,
      accountTitle: 'DEMO ACCOUNT — replace before going live',
      accountNumber: '0000-0000000',
    },
    actor,
  );
  const bankTransfer = await createPaymentMethod(
    db,
    {
      code: 'bank',
      displayName: 'Bank transfer',
      kind: 'bank_transfer',
      sortOrder: 3,
      printOnBill: true,
      accountTitle: 'DEMO ACCOUNT — replace before going live',
      accountNumber: '0000000000000000',
      bankName: 'Demo Bank',
    },
    actor,
  );

  // ---- payment accounts ----
  // Two wallets and one bank account, so the payment screen has a real
  // choice to make and the reports have something to tell apart. Every
  // number here is a placeholder — nothing real is ever committed.
  const paymentAccounts: Record<string, number> = {};
  const addAccount = async (
    paymentMethodId: number,
    label: string,
    accountNumber: string,
    bankName?: string,
    sortOrder = 0,
  ) => {
    const account = await createPaymentAccount(
      db,
      {
        paymentMethodId,
        label,
        accountTitle: 'DEMO ACCOUNT — replace before going live',
        accountNumber,
        ...(bankName === undefined ? {} : { bankName }),
        sortOrder,
      },
      actor,
    );
    paymentAccounts[label] = account.id;
  };

  await addAccount(easypaisa.id, 'Counter wallet', '0000-0000000', undefined, 1);
  await addAccount(easypaisa.id, 'Delivery wallet', '0000-1111111', undefined, 2);
  await addAccount(bankTransfer.id, 'Main current account', '0000000000000000', 'Demo Bank', 1);

  // ---- people (staff and owner meals), one per policy ----
  const people: Record<string, number> = {};
  const addPerson = async (
    name: string,
    kind: 'staff' | 'partner',
    mealPolicy: 'free' | 'discounted' | 'full_price' | 'payroll_deduction',
    mealDiscountBp?: number,
  ) => {
    const person = await createPerson(db, { name, kind, mealPolicy, ...(mealDiscountBp === undefined ? {} : { mealDiscountBp }) }, actor);
    people[name] = person.id;
  };

  await addPerson('Rashid (kitchen)', 'staff', 'free');
  await addPerson('Nadia (floor)', 'staff', 'discounted', 5_000);
  await addPerson('Kamran (delivery)', 'staff', 'payroll_deduction');
  await addPerson('Tariq (part-time)', 'staff', 'full_price');
  await addPerson('Alia Holdings — owner', 'partner', 'free');
  await addPerson('Bilal Foods — owner', 'partner', 'discounted', 2_500);

  return {
    users: { admin: admin.id, manager: manager.id, cashier: cashier.id, waiterOne: waiterOne.id, waiterTwo: waiterTwo.id },
    usernames: {
      admin: admin.username,
      manager: manager.username,
      cashier: cashier.username,
      waiterOne: waiterOne.username,
      waiterTwo: waiterTwo.username,
    },
    paymentAccounts,
    partners: { alia: alia.id, bilal: bilal.id, chandni: chandni.id },
    paymentMethods: { cash: cash.id, easypaisa: easypaisa.id, bankTransfer: bankTransfer.id },
    items,
    modifiers,
    people,
  };
}
