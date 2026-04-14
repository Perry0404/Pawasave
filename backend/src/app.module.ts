import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';

import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PaymentModule } from './modules/payment/payment.module';
import { SavingsModule } from './modules/savings/savings.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { EsusuModule } from './modules/esusu/esusu.module';
import { SplitModule } from './modules/split/split.module';
import { ReportModule } from './modules/report/report.module';
import { ExchangeRateModule } from './modules/exchange-rate/exchange-rate.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),
    PrismaModule,
    AuthModule,
    WalletModule,
    PaymentModule,
    SavingsModule,
    TreasuryModule,
    EsusuModule,
    SplitModule,
    ReportModule,
    ExchangeRateModule,
  ],
})
export class AppModule {}
