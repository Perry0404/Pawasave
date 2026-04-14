import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRate: ExchangeRateService,
  ) {}

  /** Generate daily report for a specific user */
  async generateDailyReport(userId: string, date?: Date) {
    const reportDate = date || new Date();
    const startOfDay = new Date(reportDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(reportDate);
    endOfDay.setHours(23, 59, 59, 999);

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return null;

    // Aggregate today's transactions
    const transactions = await this.prisma.transaction.findMany({
      where: {
        walletId: wallet.id,
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
    });

    let totalReceivedKobo = BigInt(0);
    let totalSavedKobo = BigInt(0);
    let totalSavedUsdc = BigInt(0);
    let interestEarnedKobo = BigInt(0);
    let esusuContributedKobo = BigInt(0);

    for (const tx of transactions) {
      switch (tx.type) {
        case 'DEPOSIT':
          totalReceivedKobo += tx.amountKobo;
          break;
        case 'SAVE_TO_VAULT':
          totalSavedKobo += tx.amountKobo;
          if (tx.amountUsdc) totalSavedUsdc += tx.amountUsdc;
          break;
        case 'INTEREST_CREDIT':
        case 'LIQUIDITY_BONUS':
          interestEarnedKobo += tx.amountKobo;
          break;
        case 'ESUSU_CONTRIBUTE':
          esusuContributedKobo += tx.amountKobo;
          break;
      }
    }

    // Get group pot totals
    const memberships = await this.prisma.esusuMember.findMany({
      where: { userId, isActive: true },
      include: { group: true },
    });
    const groupPotTotalKobo = memberships.reduce(
      (sum, m) => sum + m.group.potBalanceKobo,
      BigInt(0),
    );

    // Generate pidgin voice summary text
    const voiceSummary = this.generatePidginSummary({
      totalReceivedKobo,
      totalSavedKobo,
      interestEarnedKobo,
      groupPotTotalKobo,
    });

    // Upsert report
    const report = await this.prisma.dailyReport.upsert({
      where: { userId_reportDate: { userId, reportDate: startOfDay } },
      update: {
        totalReceivedKobo,
        totalSavedKobo,
        totalSavedUsdc,
        interestEarnedKobo,
        esusuContributedKobo,
        groupPotTotalKobo,
      },
      create: {
        userId,
        reportDate: startOfDay,
        totalReceivedKobo,
        totalSavedKobo,
        totalSavedUsdc,
        interestEarnedKobo,
        esusuContributedKobo,
        groupPotTotalKobo,
      },
    });

    return {
      ...report,
      totalReceivedKobo: totalReceivedKobo.toString(),
      totalSavedKobo: totalSavedKobo.toString(),
      interestEarnedKobo: interestEarnedKobo.toString(),
      esusuContributedKobo: esusuContributedKobo.toString(),
      groupPotTotalKobo: groupPotTotalKobo.toString(),
      voiceSummary,
    };
  }

  /** Generate pidgin English voice summary text */
  private generatePidginSummary(data: {
    totalReceivedKobo: bigint;
    totalSavedKobo: bigint;
    interestEarnedKobo: bigint;
    groupPotTotalKobo: bigint;
  }): string {
    const received = this.formatNaira(data.totalReceivedKobo);
    const saved = this.formatNaira(data.totalSavedKobo);
    const interest = this.formatNaira(data.interestEarnedKobo);
    const groupPot = this.formatNaira(data.groupPotTotalKobo);

    const parts: string[] = [];

    if (data.totalReceivedKobo > 0n) {
      parts.push(`Today you receive ${received}`);
    } else {
      parts.push('Today no money enter');
    }

    if (data.totalSavedKobo > 0n) {
      parts.push(`${saved} don save for your USDC vault`);
    }

    if (data.interestEarnedKobo > 0n) {
      parts.push(`You earn ${interest} interest`);
    }

    if (data.groupPotTotalKobo > 0n) {
      parts.push(`Your group pot don reach ${groupPot}`);
    }

    parts.push('PawaSave dey always protect your money!');

    return parts.join('. ') + '.';
  }

  /** Get sales trend data (last N days) */
  async getSalesTrend(userId: string, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const reports = await this.prisma.dailyReport.findMany({
      where: {
        userId,
        reportDate: { gte: startDate },
      },
      orderBy: { reportDate: 'asc' },
    });

    return reports.map((r) => ({
      date: r.reportDate,
      receivedKobo: r.totalReceivedKobo.toString(),
      savedKobo: r.totalSavedKobo.toString(),
      interestKobo: r.interestEarnedKobo.toString(),
    }));
  }

  /** Cron: generate daily reports for all active users at end of day */
  @Cron('0 23 * * *') // 11 PM daily
  async generateAllDailyReports() {
    this.logger.log('Generating end-of-day reports...');

    const users = await this.prisma.user.findMany({
      where: { isVerified: true },
      select: { id: true },
    });

    let count = 0;
    for (const user of users) {
      try {
        await this.generateDailyReport(user.id);
        count++;
      } catch (err) {
        this.logger.error(`Failed to generate report for ${user.id}`, err);
      }
    }

    this.logger.log(`Generated ${count} daily reports`);
  }

  private formatNaira(kobo: bigint): string {
    const naira = Number(kobo) / 100;
    if (naira >= 1_000_000) return `₦${(naira / 1_000_000).toFixed(1)}M`;
    if (naira >= 1_000) return `₦${(naira / 1_000).toFixed(1)}k`;
    return `₦${naira.toLocaleString()}`;
  }
}
