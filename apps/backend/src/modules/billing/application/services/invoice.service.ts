import { Inject, Injectable } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';

@Injectable()
export class InvoiceService {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository) {}

  createDraftInvoice(subscriptionId: string, amountCents: number, currency: string) {
    return this.repository.createInvoice({ subscriptionId, amountCents, currency, status: 'DRAFT' });
  }

  markPaid(invoiceId: string) {
    return this.repository.markInvoicePaid(invoiceId, new Date());
  }

  listForSubscription(subscriptionId: string) {
    return this.repository.listInvoicesForSubscription(subscriptionId);
  }
}
