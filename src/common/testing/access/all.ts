import { LinkScenario, Scenario, SelfScenario } from '../access-matrix';
import { messageScenarios, messageSelfScenarios } from './messages';
import { clientScenarios, clientSelfScenarios } from './client';
import { complaintScenarios, complaintSelfScenarios } from './complaints';
import { fileScenarios, fileSelfScenarios } from './files';
import { invoiceScenarios, invoiceSelfScenarios, paymentScenarios } from './invoices-payments';
import { notificationScenarios, notificationSelfScenarios } from './notifications';
import { quoteScenarios } from './quotes';
import { schedulingScenarios, schedulingSelfScenarios } from './scheduling';
import { reviewScenarios, reviewSelfScenarios } from './reviews';
import { jobScenarios, jobSelfScenarios } from './jobs';
import { artisanScenarios, artisanSelfScenarios } from './artisans';
import { accountScenarios, accountSelfScenarios } from './accounts';
import { staffScenarios } from './staff';
import { linkScenarios } from './links';

export const SCENARIOS: Scenario[] = [...messageScenarios, ...quoteScenarios, ...invoiceScenarios, ...paymentScenarios, ...notificationScenarios, ...fileScenarios, ...complaintScenarios, ...clientScenarios, ...reviewScenarios, ...schedulingScenarios, ...jobScenarios, ...artisanScenarios, ...accountScenarios, ...staffScenarios];

export const SELF_SCENARIOS: SelfScenario[] = [...messageSelfScenarios, ...invoiceSelfScenarios, ...notificationSelfScenarios, ...complaintSelfScenarios, ...clientSelfScenarios, ...reviewSelfScenarios, ...schedulingSelfScenarios, ...jobSelfScenarios, ...fileSelfScenarios, ...artisanSelfScenarios, ...accountSelfScenarios];


export const LINK_SCENARIOS: LinkScenario[] = [...linkScenarios];
