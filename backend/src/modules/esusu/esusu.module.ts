import { Module } from '@nestjs/common';
import { EsusuService } from './esusu.service';
import { EsusuController } from './esusu.controller';
import { EmergencyService } from './emergency.service';
import { WalletModule } from '../wallet/wallet.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [WalletModule, ExchangeRateModule],
  controllers: [EsusuController],
  providers: [EsusuService, EmergencyService],
  exports: [EsusuService],
})
export class EsusuModule {}
