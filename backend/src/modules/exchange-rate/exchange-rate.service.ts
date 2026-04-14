import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private cachedRate: { rate: number; fetchedAt: Date } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Get current NGN/USD rate */
  async getNgnUsdRate(): Promise<number> {
    // Return cached if fresh (< 5 minutes)
    if (this.cachedRate && Date.now() - this.cachedRate.fetchedAt.getTime() < 5 * 60 * 1000) {
      return this.cachedRate.rate;
    }

    // Try DB
    const latest = await this.prisma.exchangeRate.findFirst({
      where: { pair: 'NGN_USD' },
      orderBy: { fetchedAt: 'desc' },
    });

    if (latest && Date.now() - latest.fetchedAt.getTime() < 10 * 60 * 1000) {
      this.cachedRate = { rate: Number(latest.rate), fetchedAt: latest.fetchedAt };
      return Number(latest.rate);
    }

    return this.fetchAndStore();
  }

  /** Convert kobo to USDC micro-units */
  async koboToUsdc(kobo: bigint): Promise<bigint> {
    const rate = await this.getNgnUsdRate();
    // kobo / 100 = Naira, Naira / rate = USD, USD * 1_000_000 = micro-USDC
    const usdcMicro = (Number(kobo) / 100 / rate) * 1_000_000;
    return BigInt(Math.floor(usdcMicro));
  }

  /** Convert USDC micro-units to kobo */
  async usdcToKobo(usdcMicro: bigint): Promise<bigint> {
    const rate = await this.getNgnUsdRate();
    // usdcMicro / 1_000_000 = USD, USD * rate = Naira, Naira * 100 = kobo
    const kobo = (Number(usdcMicro) / 1_000_000) * rate * 100;
    return BigInt(Math.floor(kobo));
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshRate() {
    try {
      await this.fetchAndStore();
    } catch (err) {
      this.logger.error('Failed to refresh exchange rate', err);
    }
  }

  private async fetchAndStore(): Promise<number> {
    // TODO: Replace with real API call (Quidax, Flutterwave, etc.)
    // For now, use a sensible default or env fallback
    const fallbackRate = 1600; // NGN per USD

    try {
      const apiUrl = this.config.get<string>('EXCHANGE_RATE_API_URL');
      const apiKey = this.config.get<string>('EXCHANGE_RATE_API_KEY');

      if (apiUrl && apiKey) {
        const response = await fetch(`${apiUrl}?pair=NGN_USD`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const data = await response.json();
        const rate = data.rate || fallbackRate;

        await this.prisma.exchangeRate.create({
          data: { pair: 'NGN_USD', rate: new Decimal(rate), source: 'api' },
        });

        this.cachedRate = { rate, fetchedAt: new Date() };
        return rate;
      }
    } catch (err) {
      this.logger.warn('Exchange rate API failed, using fallback', err);
    }

    this.cachedRate = { rate: fallbackRate, fetchedAt: new Date() };
    return fallbackRate;
  }
}
