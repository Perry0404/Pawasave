import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class SplitService {
  private readonly logger = new Logger(SplitService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Create a new split rule */
  async createRule(
    userId: string,
    name: string,
    minAmountKobo: bigint,
    allocations: { target: string; percentage: number; esusuGroupId?: string }[],
  ) {
    // Validate allocations sum to 10000
    const totalPct = allocations.reduce((sum, a) => sum + a.percentage, 0);
    if (totalPct !== 10000) {
      throw new BadRequestException(`Allocations must sum to 100% (10000 bps). Got ${totalPct}`);
    }

    const rule = await this.prisma.splitRule.create({
      data: {
        userId,
        name,
        minAmountKobo,
        allocations: {
          create: allocations.map((a) => ({
            target: a.target as any,
            percentage: a.percentage,
            esusuGroupId: a.esusuGroupId,
          })),
        },
      },
      include: { allocations: true },
    });

    return rule;
  }

  /** Execute split rules on an incoming payment */
  async executeSplit(userId: string, paymentId: string, amountKobo: bigint) {
    // Find matching rule (highest priority first, min amount check)
    const rule = await this.prisma.splitRule.findFirst({
      where: {
        userId,
        isActive: true,
        minAmountKobo: { lte: amountKobo },
      },
      orderBy: { priority: 'desc' },
      include: { allocations: true },
    });

    if (!rule) {
      this.logger.debug(`No split rules found for user ${userId}`);
      return [];
    }

    const executions = [];

    for (const alloc of rule.allocations) {
      const allocKobo = BigInt(Math.floor(Number(amountKobo) * alloc.percentage / 10000));
      if (allocKobo <= 0n) continue;

      // Record the split execution
      await this.prisma.splitExecution.create({
        data: {
          paymentId,
          target: alloc.target,
          amountKobo: allocKobo,
          esusuGroupId: alloc.esusuGroupId,
        },
      });

      // Execute the allocation
      switch (alloc.target) {
        case 'PERSONAL_VAULT':
          // Debit Naira, credit USDC vault
          // This is handled after the initial Naira credit
          await this.prisma.wallet.update({
            where: { userId },
            data: { nairaBalance: { decrement: allocKobo } },
          });
          // The actual USDC conversion happens in the wallet service
          // For now, mark as pending
          this.logger.log(`Split: ₦${Number(allocKobo) / 100} → personal vault for ${userId}`);
          break;

        case 'NAIRA_BALANCE':
          // Already in Naira balance, no action needed
          this.logger.log(`Split: ₦${Number(allocKobo) / 100} stays in Naira for ${userId}`);
          break;

        case 'ESUSU_GROUP':
          if (alloc.esusuGroupId) {
            // Move to Esusu group pot
            await this.prisma.wallet.update({
              where: { userId },
              data: { nairaBalance: { decrement: allocKobo } },
            });
            await this.prisma.esusuGroup.update({
              where: { id: alloc.esusuGroupId },
              data: { potBalanceKobo: { increment: allocKobo } },
            });
            this.logger.log(
              `Split: ₦${Number(allocKobo) / 100} → Esusu group ${alloc.esusuGroupId} for ${userId}`,
            );
          }
          break;
      }

      executions.push({
        target: alloc.target,
        amountKobo: allocKobo.toString(),
        esusuGroupId: alloc.esusuGroupId,
      });
    }

    return executions;
  }

  /** Get all split rules for a user */
  async getRules(userId: string) {
    return this.prisma.splitRule.findMany({
      where: { userId },
      include: { allocations: { include: { esusuGroup: { select: { id: true, name: true } } } } },
      orderBy: { priority: 'desc' },
    });
  }

  /** Update rule active status */
  async toggleRule(userId: string, ruleId: string, isActive: boolean) {
    const rule = await this.prisma.splitRule.findFirst({
      where: { id: ruleId, userId },
    });
    if (!rule) throw new NotFoundException('Rule not found');

    return this.prisma.splitRule.update({
      where: { id: ruleId },
      data: { isActive },
    });
  }

  /** Delete a rule */
  async deleteRule(userId: string, ruleId: string) {
    const rule = await this.prisma.splitRule.findFirst({
      where: { id: ruleId, userId },
    });
    if (!rule) throw new NotFoundException('Rule not found');

    return this.prisma.splitRule.delete({ where: { id: ruleId } });
  }
}
