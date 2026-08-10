import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  IBillingRepository,
  ICreateSubscriptionInput,
} from '../application/ports/billing.repository.port';
import type {
  IInvoiceRecord,
  InvoiceStatusValue,
  IPlanDefinition,
  ISubscriptionRecord,
  SubscriptionPlanTier,
  SubscriptionStatusValue,
} from '../domain/billing.types';

@Injectable()
export class PrismaBillingRepository implements IBillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAllActivePlans(): Promise<IPlanDefinition[]> {
    const rows = await this.prisma.planDefinition.findMany({ where: { isActive: true } });
    return rows.map((r: any) => ({ ...r, features: r.features as string[] }));
  }

  async findPlanByTier(tier: SubscriptionPlanTier): Promise<IPlanDefinition | null> {
    const row = await this.prisma.planDefinition.findUnique({ where: { tier } });
    return row ? { ...row, features: row.features as string[] } : null;
  }

  async findSubscriptionByFamily(familyId: string): Promise<ISubscriptionRecord | null> {
    return this.prisma.subscription.findUnique({ where: { familyId } });
  }

  async createSubscription(input: ICreateSubscriptionInput): Promise<ISubscriptionRecord> {
    return this.prisma.subscription.create({
      data: {
        familyId: input.familyId,
        planTier: input.planTier,
        provider: input.provider,
        status: input.status,
        trialEndsAt: input.trialEndsAt,
      },
    });
  }

  async updateSubscriptionStatus(
    subscriptionId: string,
    status: SubscriptionStatusValue,
    extra?: { canceledAt?: Date; currentPeriodStart?: Date; currentPeriodEnd?: Date; trialEndsAt?: Date },
  ): Promise<void> {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status, ...extra },
    });
  }

  async createInvoice(input: {
    subscriptionId: string;
    amountCents: number;
    currency: string;
    status: InvoiceStatusValue;
    providerInvoiceId?: string;
  }): Promise<IInvoiceRecord> {
    return this.prisma.invoice.create({ data: input });
  }

  async markInvoicePaid(invoiceId: string, paidAt: Date): Promise<void> {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID', paidAt },
    });
  }

  async listInvoicesForSubscription(subscriptionId: string): Promise<IInvoiceRecord[]> {
    return this.prisma.invoice.findMany({
      where: { subscriptionId },
      orderBy: { issuedAt: 'desc' },
    });
  }
}
