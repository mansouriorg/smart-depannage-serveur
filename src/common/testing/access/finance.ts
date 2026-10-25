import { Scenario } from '../access-matrix';

/**
 * The finance console (P2-08): reads for the administrators and the accountant, and for nobody else (the support and dispatch roles
 * keep the payment routes they work with, not the console). Every household's payments and invoices are in the answers: the back
 * office is shown all of them, so the customers and artisans are turned away.
 */
export const financeScenarios: Scenario[] = [
  { route: 'GET /finance/summary', note: 'the totals of a week: figures only, nothing of a household to find in them', allowed: ['admins', 'accountant'], gateOnly: true, request: () => ({ query: {} }) },
  { route: 'GET /finance/payments', note: 'every payment, with the customer and the artisan of its job', allowed: ['admins', 'accountant'], gateOnly: true, request: () => ({ query: { view: 'all' } }) },
  { route: 'GET /finance/payments/export', note: 'the same payments as a CSV file', allowed: ['admins', 'accountant'], gateOnly: true, request: () => ({ query: {} }) },
  { route: 'GET /finance/invoices', note: 'every invoice issued, with its credit notes', allowed: ['admins', 'accountant'], gateOnly: true, request: () => ({ query: {} }) },
  { route: 'GET /finance/refunds-due', note: 'the jobs where a credit note leaves money to give back', allowed: ['admins', 'accountant'], gateOnly: true, request: () => ({}) },
];
