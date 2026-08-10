import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ICreateSupportRequestInput, ISupportRequestRecord, ISupportRequestRepository } from '../../domain/support.types';

@Injectable()
export class PrismaSupportRequestRepository implements ISupportRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: ICreateSupportRequestInput): Promise<ISupportRequestRecord> {
    return this.prisma.supportRequest.create({ data: input });
  }

  async listAll(limit: number): Promise<ISupportRequestRecord[]> {
    return this.prisma.supportRequest.findMany({
      orderBy: [{ isPriority: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }
}
