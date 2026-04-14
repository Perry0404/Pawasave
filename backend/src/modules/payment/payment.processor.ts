import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ConfigService } from '@nestjs/config';

interface SettlementJob {
  paymentId: string;
  userId: string;
  amountKobo: string;
}

@Processor('payment-settlement')
export class PaymentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<SettlementJob>): Promise<void> {
    const { paymentId, userId, amountKobo } = job.data;
    this.logger.log(`Settling payment ${paymentId} for user ${userId}`);

    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === 'SETTLED') return;

    const kobo = BigInt(amountKobo);
    const usdcAmount = await this.exchangeRate.koboToUsdc(kobo);

    // TODO: In production, actually purchase USDC on Base L2 via DEX or Circle
    // For now, simulate the on-chain settlement
    const settlementTime = new Date();

    // Check if settlement took >5 minutes → apply bonus yield
    const receivedAt = payment.receivedAt;
    const diffMs = settlementTime.getTime() - receivedAt.getTime();
    const bonusApplied = diffMs > 5 * 60 * 1000;

    await this.prisma.$transaction(async (tx) => {
      // Mark payment as settled
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'SETTLED',
          settledAt: settlementTime,
          bonusApplied,
        },
      });

      // Update wallet USDC pending → settled
      await tx.wallet.update({
        where: { userId },
        data: {
          usdcPending: { decrement: usdcAmount },
        },
      });

      // If bonus, credit extra yield
      if (bonusApplied) {
        const bonusBps = this.config.get<number>('LIQUIDITY_BONUS_YIELD_BPS', 50);
        const bonusKobo = BigInt(Math.floor(Number(kobo) * bonusBps / 10000));

        await tx.wallet.update({
          where: { userId },
          data: {
            nairaBalance: { increment: bonusKobo },
            totalInterestEarnedKobo: { increment: bonusKobo },
          },
        });

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'LIQUIDITY_BONUS',
            direction: 'CREDIT',
            amountKobo: bonusKobo,
            description: `5-min guarantee bonus: ₦${(Number(bonusKobo) / 100).toFixed(2)}`,
          },
        });

        this.logger.log(`Bonus yield ₦${Number(bonusKobo) / 100} applied for delayed settlement on ${paymentId}`);
      }

      // Record treasury ledger
      await tx.treasuryLedger.create({
        data: {
          type: 'SETTLE_PAYMENT',
          amountUsdc: usdcAmount,
          amountKobo: kobo,
          description: `Settlement for payment ${paymentId}`,
        },
      });
    });

    this.logger.log(`Payment ${paymentId} settled: ${usdcAmount} micro-USDC`);
  }
}
