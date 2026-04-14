import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [ExchangeRateModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
