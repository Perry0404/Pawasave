import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { SplitService } from '../split/split.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly splitService: SplitService,
    @InjectQueue('payment-settlement') private readonly settlementQueue: Queue,
  ) {}

  /**
   * Handle incoming Naira payment (webhook from Paystack/Flutterwave).
   *
   * FLOW:
   * 1. Record payment
   * 2. INSTANTLY credit user's Naira balance (5-min liquidity guarantee)
   * 3. Queue background USDC settlement
   * 4. Execute Smart Split rules
   */
  async handleIncomingPayment(userId: string, amountKobo: bigint, provider: string, providerRef?: string) {
    const reference = `PAY-${uuid()}`;

    // 1. Record payment
    const payment = await this.prisma.payment.create({
      data: {
        userId,
        amountKobo,
        reference,
        provider: provider as any,
        providerRef,
        status: 'CONFIRMED',
        receivedAt: new Date(),
      },
    });

    // 2. INSTANT credit — this is the "5-Minute Liquidity Guarantee"
    // Money is available immediately from treasury pool
    await this.walletService.creditNaira(userId, amountKobo);

    // Record ledger entry
    const wallet = await this.walletService.getWallet(userId);
    await this.prisma.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'DEPOSIT',
        direction: 'CREDIT',
        amountKobo,
        description: `Payment received: ₦${(Number(amountKobo) / 100).toLocaleString()}`,
        reference,
      },
    });

    this.logger.log(`Payment ${reference}: ₦${Number(amountKobo) / 100} credited instantly to ${userId}`);

    // 3. Queue background USDC settlement (treasury buys USDC)
    await this.settlementQueue.add(
      'settle',
      { paymentId: payment.id, userId, amountKobo: amountKobo.toString() },
      { delay: 0, attempts: 3, backoff: { type: 'exponential', delay: 10000 } },
    );

    // 4. Execute Smart Split rules
    await this.splitService.executeSplit(userId, payment.id, amountKobo);

    return {
      paymentId: payment.id,
      reference,
      amountKobo: amountKobo.toString(),
      status: 'CONFIRMED',
      message: 'Payment credited instantly. USDC settlement in background.',
    };
  }

  /** Paystack webhook handler */
  async handlePaystackWebhook(body: any) {
    if (body.event !== 'charge.success') return;

    const { reference, amount, customer } = body.data;

    // Look up user by email or metadata
    const user = await this.prisma.user.findFirst({
      where: { email: customer?.email },
    });

    if (!user) {
      this.logger.warn(`Webhook: no user found for ${customer?.email}`);
      return;
    }

    // Check for duplicate
    const existing = await this.prisma.payment.findFirst({
      where: { providerRef: reference },
    });
    if (existing) return;

    return this.handleIncomingPayment(
      user.id,
      BigInt(amount),
      'PAYSTACK',
      reference,
    );
  }

  /** Get payment history for user */
  async getPaymentHistory(userId: string, limit = 50, offset = 0) {
    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.payment.count({ where: { userId } }),
    ]);

    return { payments, total, limit, offset };
  }

  /** Get transaction ledger for user */
  async getTransactions(userId: string, limit = 50, offset = 0) {
    const wallet = await this.walletService.getWallet(userId);

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.transaction.count({ where: { walletId: wallet.id } }),
    ]);

    return { transactions, total, limit, offset };
  }
}
