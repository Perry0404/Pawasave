import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

@Injectable()
export class SavingsService {
  private readonly logger = new Logger(SavingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly exchangeRate: ExchangeRateService,
  ) {}

  /**
   * Daily interest accrual — runs at midnight.
   * 
   * Interest is calculated on USDC savings but displayed/credited in Naira.
   * Formula: dailyYield = usdcSavings * (annualRateBps / 10000) / 365
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async accrueInterest() {
    this.logger.log('Starting daily interest accrual...');

    const annualBps = this.config.get<number>('ANNUAL_YIELD_RATE_BPS', 500);
    const dailyRate = annualBps / 10000 / 365;

    // Process in batches
    let cursor: string | undefined;
    let totalProcessed = 0;
    let totalInterestKobo = BigInt(0);

    while (true) {
      const wallets = await this.prisma.wallet.findMany({
        where: { usdcSavings: { gt: 0 } },
        take: 100,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });

      if (wallets.length === 0) break;

      for (const wallet of wallets) {
        const interestUsdc = BigInt(Math.floor(Number(wallet.usdcSavings) * dailyRate));
        if (interestUsdc <= 0n) continue;

        const interestKobo = await this.exchangeRate.usdcToKobo(interestUsdc);

        await this.prisma.$transaction(async (tx) => {
          // Credit USDC interest to savings
          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              usdcSavings: { increment: interestUsdc },
              totalInterestEarnedKobo: { increment: interestKobo },
            },
          });

          // Ledger entry
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              type: 'INTEREST_CREDIT',
              direction: 'CREDIT',
              amountKobo: interestKobo,
              amountUsdc: interestUsdc,
              description: `Daily interest: ₦${(Number(interestKobo) / 100).toFixed(2)}`,
            },
          });
        });

        totalInterestKobo += interestKobo;
        totalProcessed++;
      }

      cursor = wallets[wallets.length - 1].id;
    }

    this.logger.log(
      `Interest accrual complete: ${totalProcessed} wallets, total ₦${(Number(totalInterestKobo) / 100).toFixed(2)}`,
    );
  }
}
