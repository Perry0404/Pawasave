import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PaymentProcessor } from './payment.processor';
import { WalletModule } from '../wallet/wallet.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { SplitModule } from '../split/split.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'payment-settlement' }),
    WalletModule,
    ExchangeRateModule,
    SplitModule,
  ],
  controllers: [PaymentController],
  providers: [PaymentService, PaymentProcessor],
  exports: [PaymentService],
})
export class PaymentModule {}
