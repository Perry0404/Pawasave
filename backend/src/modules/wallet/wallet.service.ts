import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRate: ExchangeRateService,
  ) {}

  async getWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
  }

  /** Get user-facing dashboard balances (everything in Naira) */
  async getDashboard(userId: string) {
    const wallet = await this.getWallet(userId);

    // Convert USDC savings to Naira equivalent for display
    const savingsInKobo = await this.exchangeRate.usdcToKobo(wallet.usdcSavings);
    const pendingInKobo = await this.exchangeRate.usdcToKobo(wallet.usdcPending);

    // Get Esusu group totals
    const memberships = await this.prisma.esusuMember.findMany({
      where: { userId, isActive: true },
      include: { group: true },
    });

    const esusuTotalKobo = memberships.reduce(
      (sum, m) => sum + Number(m.group.potBalanceKobo),
      0,
    );

    return {
      naira: {
        available: wallet.nairaBalance.toString(),
        savings: savingsInKobo.toString(),
        pending: pendingInKobo.toString(),
        totalInterestEarned: wallet.totalInterestEarnedKobo.toString(),
      },
      usdc: {
        savings: wallet.usdcSavings.toString(),
        pending: wallet.usdcPending.toString(),
      },
      esusu: {
        groupCount: memberships.length,
        totalPotKobo: esusuTotalKobo.toString(),
        groups: memberships.map((m) => ({
          groupId: m.group.id,
          name: m.group.name,
          potKobo: m.group.potBalanceKobo.toString(),
          status: m.group.status,
        })),
      },
      baseAddress: wallet.baseAddress,
    };
  }

  /** Credit Naira balance (from payment) */
  async creditNaira(userId: string, amountKobo: bigint) {
    return this.prisma.wallet.update({
      where: { userId },
      data: { nairaBalance: { increment: amountKobo } },
    });
  }

  /** Debit Naira balance */
  async debitNaira(userId: string, amountKobo: bigint) {
    const wallet = await this.getWallet(userId);
    if (wallet.nairaBalance < amountKobo) {
      throw new Error('Insufficient Naira balance');
    }
    return this.prisma.wallet.update({
      where: { userId },
      data: { nairaBalance: { decrement: amountKobo } },
    });
  }

  /** Move Naira → USDC savings vault */
  async saveToVault(userId: string, amountKobo: bigint) {
    const usdcAmount = await this.exchangeRate.koboToUsdc(amountKobo);
    const rate = await this.exchangeRate.getNgnUsdRate();

    return this.prisma.$transaction(async (tx) => {
      // Debit Naira
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      if (wallet.nairaBalance < amountKobo) {
        throw new Error('Insufficient Naira balance');
      }

      await tx.wallet.update({
        where: { userId },
        data: {
          nairaBalance: { decrement: amountKobo },
          usdcSavings: { increment: usdcAmount },
        },
      });

      // Ledger entry
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'SAVE_TO_VAULT',
          direction: 'DEBIT',
          amountKobo,
          amountUsdc: usdcAmount,
          rateUsed: rate,
          description: `Saved ₦${(Number(amountKobo) / 100).toLocaleString()} to USDC vault`,
        },
      });

      return { amountKobo: amountKobo.toString(), usdcAmount: usdcAmount.toString(), rate };
    });
  }

  /** Withdraw from USDC vault → Naira */
  async withdrawFromVault(userId: string, amountKobo: bigint) {
    const usdcAmount = await this.exchangeRate.koboToUsdc(amountKobo);
    const rate = await this.exchangeRate.getNgnUsdRate();

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      if (wallet.usdcSavings < usdcAmount) {
        throw new Error('Insufficient USDC savings');
      }

      await tx.wallet.update({
        where: { userId },
        data: {
          usdcSavings: { decrement: usdcAmount },
          nairaBalance: { increment: amountKobo },
        },
      });

      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'VAULT_WITHDRAW',
          direction: 'CREDIT',
          amountKobo,
          amountUsdc: usdcAmount,
          rateUsed: rate,
          description: `Withdrew ₦${(Number(amountKobo) / 100).toLocaleString()} from USDC vault`,
        },
      });

      return { amountKobo: amountKobo.toString(), usdcAmount: usdcAmount.toString(), rate };
    });
  }
}
