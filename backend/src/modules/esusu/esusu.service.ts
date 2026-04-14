import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { CreateEsusuGroupDto } from './esusu.dto';

@Injectable()
export class EsusuService {
  private readonly logger = new Logger(EsusuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly exchangeRate: ExchangeRateService,
  ) {}

  /** Create a new Esusu/Ajo group */
  async createGroup(ownerId: string, dto: CreateEsusuGroupDto) {
    const group = await this.prisma.esusuGroup.create({
      data: {
        name: dto.name,
        description: dto.description,
        ownerId,
        contributionAmountKobo: BigInt(dto.contributionAmountKobo),
        cyclePeriod: dto.cyclePeriod as any,
        maxMembers: dto.maxMembers,
        savingsMode: (dto.savingsMode || 'USDC') as any,
        emergencyPotBps: dto.emergencyPotBps ?? 500,
        members: {
          create: {
            userId: ownerId,
            payoutPosition: 0,
          },
        },
      },
      include: { members: true },
    });

    return group;
  }

  /** Join an existing group */
  async joinGroup(userId: string, groupId: string) {
    const group = await this.prisma.esusuGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });

    if (!group) throw new NotFoundException('Group not found');
    if (group.status !== 'FORMING') throw new BadRequestException('Group is no longer accepting members');
    if (group.members.length >= group.maxMembers) throw new BadRequestException('Group is full');
    if (group.members.some((m) => m.userId === userId)) throw new BadRequestException('Already a member');

    const member = await this.prisma.esusuMember.create({
      data: {
        groupId,
        userId,
        payoutPosition: group.members.length,
      },
    });

    // Auto-start if group is full
    if (group.members.length + 1 >= group.maxMembers) {
      await this.startGroup(groupId);
    }

    return member;
  }

  /** Start group cycles */
  private async startGroup(groupId: string) {
    const group = await this.prisma.esusuGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: { members: { orderBy: { payoutPosition: 'asc' } } },
    });

    const payoutOrder = group.members.map((m) => m.userId);

    await this.prisma.esusuGroup.update({
      where: { id: groupId },
      data: {
        status: 'ACTIVE',
        startDate: new Date(),
        payoutOrder,
        currentCycleNumber: 1,
      },
    });

    this.logger.log(`Esusu group ${group.name} started with ${payoutOrder.length} members`);
  }

  /** Make a contribution for the current cycle */
  async contribute(userId: string, groupId: string) {
    const group = await this.prisma.esusuGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });

    if (!group) throw new NotFoundException('Group not found');
    if (group.status !== 'ACTIVE') throw new BadRequestException('Group is not active');

    const member = group.members.find((m) => m.userId === userId);
    if (!member) throw new ForbiddenException('Not a member of this group');

    // Check if already contributed this cycle
    const existing = await this.prisma.esusuContribution.findUnique({
      where: {
        groupId_memberId_cycleNumber: {
          groupId,
          memberId: member.id,
          cycleNumber: group.currentCycleNumber,
        },
      },
    });
    if (existing) throw new BadRequestException('Already contributed for this cycle');

    const amountKobo = group.contributionAmountKobo;

    // Debit user's Naira balance
    await this.walletService.debitNaira(userId, amountKobo);

    // Calculate emergency pot portion
    const emergencyKobo = BigInt(Math.floor(Number(amountKobo) * group.emergencyPotBps / 10000));
    const mainPotKobo = amountKobo - emergencyKobo;

    // If USDC mode, convert
    let amountUsdc: bigint | undefined;
    if (group.savingsMode === 'USDC') {
      amountUsdc = await this.exchangeRate.koboToUsdc(mainPotKobo);
    }

    await this.prisma.$transaction(async (tx) => {
      // Record contribution
      await tx.esusuContribution.create({
        data: {
          groupId,
          memberId: member.id,
          cycleNumber: group.currentCycleNumber,
          amountKobo,
          amountUsdc,
          status: 'PAID',
        },
      });

      // Update group pot
      if (group.savingsMode === 'USDC') {
        const emergencyUsdc = await this.exchangeRate.koboToUsdc(emergencyKobo);
        await tx.esusuGroup.update({
          where: { id: groupId },
          data: {
            potBalanceUsdc: { increment: amountUsdc! },
            potBalanceKobo: { increment: mainPotKobo },
            emergencyPotUsdc: { increment: emergencyUsdc },
            emergencyPotKobo: { increment: emergencyKobo },
          },
        });
      } else {
        await tx.esusuGroup.update({
          where: { id: groupId },
          data: {
            potBalanceKobo: { increment: mainPotKobo },
            emergencyPotKobo: { increment: emergencyKobo },
          },
        });
      }

      // Ledger entry
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'ESUSU_CONTRIBUTE',
          direction: 'DEBIT',
          amountKobo,
          amountUsdc,
          relatedEsusuId: groupId,
          description: `Esusu contribution to ${group.name} (Cycle ${group.currentCycleNumber})`,
        },
      });
    });

    // Check if all members have contributed → trigger payout
    const contributionCount = await this.prisma.esusuContribution.count({
      where: { groupId, cycleNumber: group.currentCycleNumber, status: 'PAID' },
    });

    if (contributionCount >= group.members.filter((m) => m.isActive).length) {
      await this.triggerPayout(groupId);
    }

    return {
      groupId,
      cycle: group.currentCycleNumber,
      amountKobo: amountKobo.toString(),
      amountUsdc: amountUsdc?.toString(),
      message: 'Contribution recorded successfully',
    };
  }

  /** Payout to the next member in rotation */
  private async triggerPayout(groupId: string) {
    const group = await this.prisma.esusuGroup.findUniqueOrThrow({
      where: { id: groupId },
    });

    const recipientId = group.payoutOrder[group.nextPayoutIndex];
    if (!recipientId) return;

    const payoutKobo = group.potBalanceKobo;
    const payoutUsdc = group.potBalanceUsdc;

    await this.prisma.$transaction(async (tx) => {
      // Credit recipient
      await this.walletService.creditNaira(recipientId, payoutKobo);

      // Record payout
      await tx.esusuPayout.create({
        data: {
          groupId,
          recipientId,
          cycleNumber: group.currentCycleNumber,
          amountKobo: payoutKobo,
          amountUsdc: payoutUsdc > 0n ? payoutUsdc : undefined,
        },
      });

      // Reset pot, advance cycle
      const isLastCycle = group.nextPayoutIndex + 1 >= group.payoutOrder.length;

      await tx.esusuGroup.update({
        where: { id: groupId },
        data: {
          potBalanceKobo: 0,
          potBalanceUsdc: 0,
          nextPayoutIndex: isLastCycle ? group.nextPayoutIndex : group.nextPayoutIndex + 1,
          currentCycleNumber: isLastCycle ? group.currentCycleNumber : group.currentCycleNumber + 1,
          status: isLastCycle ? 'COMPLETED' : 'ACTIVE',
        },
      });

      // Ledger entry for recipient
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: recipientId } });
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'ESUSU_PAYOUT',
          direction: 'CREDIT',
          amountKobo: payoutKobo,
          amountUsdc: payoutUsdc > 0n ? payoutUsdc : undefined,
          relatedEsusuId: groupId,
          description: `Esusu payout from ${group.name} (Cycle ${group.currentCycleNumber})`,
        },
      });
    });

    this.logger.log(
      `Esusu payout: ₦${Number(payoutKobo) / 100} to ${recipientId} from ${group.name}`,
    );
  }

  /** Get group details */
  async getGroup(groupId: string) {
    const group = await this.prisma.esusuGroup.findUnique({
      where: { id: groupId },
      include: {
        members: { include: { user: { select: { id: true, displayName: true, businessName: true } } } },
        contributions: { orderBy: { paidAt: 'desc' }, take: 50 },
        payouts: { orderBy: { paidAt: 'desc' } },
      },
    });

    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  /** List user's groups */
  async getUserGroups(userId: string) {
    const memberships = await this.prisma.esusuMember.findMany({
      where: { userId, isActive: true },
      include: {
        group: {
          include: { members: { select: { userId: true, payoutPosition: true } } },
        },
      },
    });

    return memberships.map((m) => ({
      groupId: m.group.id,
      name: m.group.name,
      status: m.group.status,
      memberCount: m.group.members.length,
      maxMembers: m.group.maxMembers,
      contributionAmountKobo: m.group.contributionAmountKobo.toString(),
      cyclePeriod: m.group.cyclePeriod,
      currentCycle: m.group.currentCycleNumber,
      potBalanceKobo: m.group.potBalanceKobo.toString(),
      emergencyPotKobo: m.group.emergencyPotKobo.toString(),
      myPayoutPosition: m.payoutPosition,
      savingsMode: m.group.savingsMode,
    }));
  }

  /** One-tap "Create Market Ajo" — simplified creation */
  async quickCreateMarketAjo(ownerId: string, tradeLine: string, memberCount: number) {
    return this.createGroup(ownerId, {
      name: `${tradeLine} Market Ajo`,
      description: `Quick Ajo for ${tradeLine} traders`,
      contributionAmountKobo: '5000000', // ₦50,000 default
      cyclePeriod: 'WEEKLY',
      maxMembers: memberCount,
      savingsMode: 'USDC',
      emergencyPotBps: 500,
    });
  }
}
