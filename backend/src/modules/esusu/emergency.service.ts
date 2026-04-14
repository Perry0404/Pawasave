import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class EmergencyService {
  private readonly logger = new Logger(EmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /** Request emergency payout from group's emergency pot */
  async requestEmergency(userId: string, groupId: string, reason: string, amountKobo: bigint) {
    const group = await this.prisma.esusuGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });

    if (!group) throw new NotFoundException('Group not found');
    if (group.status !== 'ACTIVE') throw new BadRequestException('Group is not active');

    const isMember = group.members.some((m) => m.userId === userId && m.isActive);
    if (!isMember) throw new ForbiddenException('Not a member of this group');

    if (amountKobo > group.emergencyPotKobo) {
      throw new BadRequestException('Requested amount exceeds emergency pot');
    }

    // Check for existing open request
    const openRequest = await this.prisma.emergencyRequest.findFirst({
      where: { groupId, requesterId: userId, status: 'VOTING' },
    });
    if (openRequest) throw new BadRequestException('You already have an open emergency request');

    // Voting deadline: 24 hours
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const totalEligible = group.members.filter((m) => m.isActive && m.userId !== userId).length;

    const request = await this.prisma.emergencyRequest.create({
      data: {
        groupId,
        requesterId: userId,
        reason,
        amountKobo,
        totalEligible,
        expiresAt,
      },
    });

    this.logger.log(`Emergency request created: ${request.id} for ₦${Number(amountKobo) / 100} from group ${group.name}`);

    return {
      requestId: request.id,
      amountKobo: amountKobo.toString(),
      totalEligible,
      expiresAt,
      yieldPenaltyBps: request.yieldPenaltyBps,
      message: `Emergency request submitted. ${totalEligible} members can vote. Expires in 24h.`,
    };
  }

  /** Cast a vote on an emergency request */
  async vote(voterId: string, requestId: string, approve: boolean) {
    const request = await this.prisma.emergencyRequest.findUnique({
      where: { id: requestId },
      include: { votes: true },
    });

    if (!request) throw new NotFoundException('Emergency request not found');
    if (request.status !== 'VOTING') throw new BadRequestException('Voting is closed');
    if (new Date() > request.expiresAt) throw new BadRequestException('Voting has expired');
    if (request.requesterId === voterId) throw new ForbiddenException('Cannot vote on your own request');

    // Verify voter is a member
    const membership = await this.prisma.esusuMember.findFirst({
      where: { groupId: request.groupId, userId: voterId, isActive: true },
    });
    if (!membership) throw new ForbiddenException('Not a member of this group');

    // Check if already voted
    const existingVote = request.votes.find((v) => v.voterId === voterId);
    if (existingVote) throw new BadRequestException('Already voted');

    await this.prisma.emergencyVote.create({
      data: { requestId, voterId, approve },
    });

    // Update vote counts
    const newFor = request.votesFor + (approve ? 1 : 0);
    const newAgainst = request.votesAgainst + (approve ? 0 : 1);

    await this.prisma.emergencyRequest.update({
      where: { id: requestId },
      data: { votesFor: newFor, votesAgainst: newAgainst },
    });

    // Check if majority reached
    const majorityThreshold = Math.ceil(request.totalEligible / 2);

    if (newFor >= majorityThreshold) {
      await this.approveAndDisburse(requestId);
    } else if (newAgainst >= majorityThreshold) {
      await this.prisma.emergencyRequest.update({
        where: { id: requestId },
        data: { status: 'REJECTED', resolvedAt: new Date() },
      });
    }

    return { votesFor: newFor, votesAgainst: newAgainst, totalEligible: request.totalEligible };
  }

  /** Approve and disburse emergency funds */
  private async approveAndDisburse(requestId: string) {
    const request = await this.prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    await this.prisma.$transaction(async (tx) => {
      // Debit emergency pot
      await tx.esusuGroup.update({
        where: { id: request.groupId },
        data: { emergencyPotKobo: { decrement: request.amountKobo } },
      });

      // Credit requester
      await this.walletService.creditNaira(request.requesterId, request.amountKobo);

      // Update request status
      await tx.emergencyRequest.update({
        where: { id: requestId },
        data: { status: 'DISBURSED', resolvedAt: new Date() },
      });

      // Ledger entry
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: request.requesterId } });
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'EMERGENCY_PAYOUT',
          direction: 'CREDIT',
          amountKobo: request.amountKobo,
          relatedEsusuId: request.groupId,
          description: `Emergency payout: ${request.reason}`,
        },
      });
    });

    this.logger.log(`Emergency disbursed: ₦${Number(request.amountKobo) / 100} for request ${requestId}`);
  }

  /** Get emergency request details */
  async getRequest(requestId: string) {
    return this.prisma.emergencyRequest.findUnique({
      where: { id: requestId },
      include: { votes: { include: { voter: { select: { id: true, displayName: true } } } } },
    });
  }

  /** List pending emergency requests for a group */
  async getGroupEmergencies(groupId: string) {
    return this.prisma.emergencyRequest.findMany({
      where: { groupId, status: 'VOTING' },
      orderBy: { createdAt: 'desc' },
    });
  }
}
